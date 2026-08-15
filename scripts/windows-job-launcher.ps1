# Windows-only owned process launcher. The sole native Job handle lives in this
# process; closing it kills the complete assigned tree.
param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$OwnerToken,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{24}$')][string]$OwnerId,
  [Parameter(Mandatory=$true)][string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class SnlOwnedJobLauncher {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint SYNCHRONIZE = 0x00100000;
  const uint INFINITE = 0xffffffff;
  const uint WAIT_OBJECT_0 = 0;
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
    public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED_LIMIT info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new [] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { b.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
      b.Append('\\', slashes).Append(c); slashes = 0;
    }
    b.Append('\\', slashes * 2).Append('"'); return b.ToString();
  }
  static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }

  public static int Run(uint parentPid, string executable, string[] args) {
    IntPtr job = IntPtr.Zero, parent = IntPtr.Zero; PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
      var limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits)), "SetInformationJobObject");
      parent = OpenProcess(SYNCHRONIZE, false, parentPid); Check(parent != IntPtr.Zero, "OpenProcess(parent)");
      var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = STARTF_USESTDHANDLES,
        hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
      var command = new StringBuilder(Quote(executable)); foreach (var arg in args) command.Append(' ').Append(Quote(arg));
      Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi), "CreateProcess");
      Check(AssignProcessToJobObject(job, pi.hProcess), "AssignProcessToJobObject");
      if (ResumeThread(pi.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
      uint waited = WaitForMultipleObjects(2, new [] { pi.hProcess, parent }, false, INFINITE);
      if (waited == WAIT_OBJECT_0) { uint code; Check(GetExitCodeProcess(pi.hProcess, out code), "GetExitCodeProcess"); return unchecked((int)code); }
      if (waited == WAIT_OBJECT_0 + 1) return 125; // parent vanished; finally closes the kill-on-close job
      throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForMultipleObjects");
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (parent != IntPtr.Zero) CloseHandle(parent); if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
$payload = $payloadJson | ConvertFrom-Json
if (-not $payload.executable -or $null -eq $payload.arguments) { throw 'invalid child payload' }
$arguments = [string[]]@($payload.arguments)
exit [SnlOwnedJobLauncher]::Run([uint32]$ParentPid, [string]$payload.executable, $arguments)
