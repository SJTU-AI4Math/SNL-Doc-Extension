using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// All operations below the drive root are relative to handles, never follow
// reparse points, and retain the ancestors without delete sharing. Rollback
// acts on the open file handle, so a foreign name cannot be removed.
public static class SnlSvgPublisher {
    const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000,
        OpenReparsePoint = 0x200000, BackupSemantics = 0x2000000,
        ReadOnly = 1, Directory = 0x10, ReparsePoint = 0x400, Normal = 0x80;
    const uint OpenExisting = 3, ShareRead = 1, ShareWrite = 2;
    const uint NtOpen = 1, NtCreate = 2, NtOpenIf = 3, Synchronize = 0x100000,
        SynchronousNonAlert = 0x20, DirectoryFile = 1, NonDirectoryFile = 0x40;

    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString { public ushort Length, Limit; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    struct ObjectAttributes {
        public int Length;
        public IntPtr Root, Name;
        public uint Attributes;
        public IntPtr Security, Quality;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoStatus { public IntPtr Status, Information; }

    [StructLayout(LayoutKind.Sequential)]
    struct Information {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information result);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, IntPtr buffer, uint length);
    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes obj,
        out IoStatus status, IntPtr allocation, uint attributes, uint share, uint disposition,
        uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")]
    static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatus status,
        IntPtr buffer, uint length, int infoClass);
    [DllImport("ntdll.dll")]
    static extern int RtlNtStatusToDosError(int status);

    static Exception Error(string action, int code) {
        return new IOException(action + ": " + new Win32Exception(code).Message + " (" + code + ")");
    }

    static SafeFileHandle OpenDrive(string path) {
        var handle = CreateFileW(path, Read, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting,
            OpenReparsePoint | BackupSemantics, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        int code = Marshal.GetLastWin32Error();
        handle.Dispose();
        throw Error("Cannot open " + path, code);
    }

    static SafeFileHandle OpenChild(SafeFileHandle parent, string name, uint access, uint share,
        uint disposition, bool directory, bool missingAllowed) {
        IntPtr chars = Marshal.StringToHGlobalUni(name);
        IntPtr unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        try {
            var length = checked((ushort)(name.Length * 2));
            Marshal.StructureToPtr(new UnicodeString { Length = length, Limit = length, Buffer = chars }, unicode, false);
            var obj = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                Root = parent.DangerousGetHandle(), Name = unicode, Attributes = 0x40 /* OBJ_CASE_INSENSITIVE */ };
            SafeFileHandle handle;
            IoStatus status;
            int result = NtCreateFile(out handle, access | Synchronize, ref obj, out status, IntPtr.Zero,
                directory ? 0u : Normal, share, disposition, OpenReparsePoint | SynchronousNonAlert |
                (directory ? DirectoryFile : NonDirectoryFile), IntPtr.Zero, 0);
            GC.KeepAlive(parent);
            if (result >= 0) return handle;
            if (handle != null) handle.Dispose();
            int code = RtlNtStatusToDosError(result);
            if (missingAllowed && code == 2) return null;
            throw Error("Cannot open SVG publication component " + name, code);
        } finally {
            Marshal.FreeHGlobal(unicode);
            Marshal.FreeHGlobal(chars);
        }
    }

    static uint Attributes(SafeFileHandle handle, bool directory) {
        Information i;
        if (!GetFileInformationByHandle(handle, out i))
            throw Error("Cannot inspect SVG publication handle", Marshal.GetLastWin32Error());
        if ((i.Attributes & ReparsePoint) != 0 || ((i.Attributes & Directory) != 0) != directory)
            throw new IOException("SVG publication refuses symbolic links, junctions and other reparse points.");
        return i.Attributes;
    }

    static void Set(SafeFileHandle h, int kind, byte[] bytes) {
        var buffer = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, buffer, bytes.Length);
            if (!SetFileInformationByHandle(h, kind, buffer, (uint)bytes.Length))
                throw Error("Cannot update SVG publication handle (class " + kind + ")", Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    static void Rename(SafeFileHandle h, SafeFileHandle parent, string destination) {
        // FILE_RENAME_INFORMATION: ReplaceIfExists=false, relative name.
        var name = Encoding.Unicode.GetBytes(destination);
        int lengthOffset = IntPtr.Size * 2;
        var info = new byte[lengthOffset + 4 + name.Length + 2];
        var root = IntPtr.Size == 8 ? BitConverter.GetBytes(parent.DangerousGetHandle().ToInt64())
            : BitConverter.GetBytes(parent.DangerousGetHandle().ToInt32());
        Array.Copy(root, 0, info, IntPtr.Size, IntPtr.Size);
        Array.Copy(BitConverter.GetBytes(name.Length), 0, info, lengthOffset, 4);
        Array.Copy(name, 0, info, lengthOffset + 4, name.Length);
        var buffer = Marshal.AllocHGlobal(info.Length);
        try {
            Marshal.Copy(info, 0, buffer, info.Length);
            IoStatus status;
            int result = NtSetInformationFile(h, out status, buffer, (uint)info.Length, 10 /* FileRenameInformation */);
            GC.KeepAlive(parent);
            if (result < 0) throw Error("Cannot publish SVG without replacing an existing file", RtlNtStatusToDosError(result));
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    static void SetAttributes(SafeFileHandle h, uint attributes) {
        // FILE_BASIC_INFO with zero timestamps preserves all existing times.
        var info = new byte[40];
        Array.Copy(BitConverter.GetBytes(attributes), 0, info, 32, 4);
        Set(h, 0, info);
    }

    static FileStream Stream(SafeFileHandle h, FileAccess access) {
        return new FileStream(new SafeFileHandle(h.DangerousGetHandle(), false), access);
    }

    static void Verify(SafeFileHandle handle, byte[] expected) {
        if ((Attributes(handle, false) & ReadOnly) == 0)
            throw new IOException("Content-addressed SVG files must be read-only.");
        using (var stream = Stream(handle, FileAccess.Read)) {
            stream.Position = 0;
            if (stream.Length != expected.Length) throw new IOException("Content-addressed SVG file has the wrong size.");
            var actual = new byte[expected.Length];
            int offset = 0;
            while (offset < actual.Length) {
                int count = stream.Read(actual, offset, actual.Length - offset);
                if (count == 0) throw new IOException("Content-addressed SVG file was truncated.");
                offset += count;
            }
            if (!actual.SequenceEqual(expected)) throw new IOException("Content-addressed SVG file has unexpected bytes.");
        }
    }

    public static void Publish(string root, string[] names, string[] input) {
        if (!Regex.IsMatch(root, @"^[a-zA-Z]:\\") || names.Length != 3 || input.Length != 3)
            throw new IOException("Invalid SVG publication request.");
        var directories = new List<SafeFileHandle>();
        var existing = new List<SafeFileHandle>();
        var created = new List<SafeFileHandle>();
        try {
            var current = Path.GetPathRoot(root);
            var parts = root.Substring(current.Length).Split(new[] {'\\'}, StringSplitOptions.RemoveEmptyEntries);
            var all = parts.Concat(new[] {".SNL_Doc", "assets", "svg"}).ToArray();
            var drive = new DriveInfo(current);
            if (drive.DriveType != DriveType.Fixed || !String.Equals(drive.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Secure Windows SVG publication requires a local fixed NTFS drive.");
            // FILE_LIST_DIRECTORY (included in GENERIC_READ) makes this a
            // shared read handle. FILE_READ_ATTRIBUTES alone is insufficient.
            directories.Add(OpenDrive(current));
            Attributes(directories[0], true);
            for (int i = 0; i < all.Length; i++) {
                string part = all[i];
                if (part.EndsWith(".") || part.EndsWith(" ") || part.Contains(":"))
                    throw new IOException("SVG workspace includes an ambiguous Windows path segment.");
                var directory = OpenChild(directories.Last(), part, Read, ShareRead | ShareWrite,
                    i > parts.Length ? NtOpenIf : NtOpen, true, false);
                directories.Add(directory);
                Attributes(directory, true);
            }
            var svgDirectory = directories.Last();
            for (int i = 0; i < names.Length; i++) {
                if (!Regex.IsMatch(names[i], @"\A[A-Za-z0-9][A-Za-z0-9._-]*\.(source|template|manifest)\.[a-f0-9]{64}\.(svg|json)\z"))
                    throw new IOException("Invalid SVG publication filename.");
                var bytes = Convert.FromBase64String(input[i]);
                var prior = OpenChild(svgDirectory, names[i], Read, ShareRead, NtOpen, false, true);
                if (prior != null) {
                    existing.Add(prior);
                    Verify(prior, bytes);
                    continue;
                }
                string staged = ".snl-svg-" + Guid.NewGuid().ToString("N") + ".tmp";
                var handle = OpenChild(svgDirectory, staged, Read | Write | Delete, 0, NtCreate, false, false);
                created.Add(handle);
                using (var stream = Stream(handle, FileAccess.Write)) {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                Rename(handle, svgDirectory, names[i]);
                SetAttributes(handle, ReadOnly);
                Verify(handle, bytes);
            }
            // A reparse tag can change independently of a directory rename.
            // Refuse success if any pinned ancestor was retagged meanwhile.
            foreach (var directory in directories) Attributes(directory, true);
        } catch (Exception failure) {
            var rollback = new List<Exception> {failure};
            for (int i = created.Count - 1; i >= 0; i--) {
                try {
                    if ((Attributes(created[i], false) & ReadOnly) != 0)
                        SetAttributes(created[i], Normal);
                    Set(created[i], 4, new byte[] {1}); // FILE_DISPOSITION_INFO.DeleteFile
                } catch (Exception error) { rollback.Add(error); }
            }
            if (rollback.Count != 1) throw new IOException("SVG publication rollback was incomplete: " +
                string.Join("; ", rollback.Select(x => x.Message).ToArray()), failure);
            throw;
        } finally {
            foreach (var handle in created) handle.Dispose();
            foreach (var handle in existing) handle.Dispose();
            for (int i = directories.Count - 1; i >= 0; i--) directories[i].Dispose();
        }
    }
}
