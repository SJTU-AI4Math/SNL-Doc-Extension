import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

export async function publishWindowsSvgAssets(
  root: string, files: { name: string; bytes: Uint8Array }[],
): Promise<void> {
  const workspace = resolve(root);
  if (!/^[a-z]:\\/i.test(workspace)) throw new Error('SVG publication requires a local Windows drive.');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw new Error('Cannot locate Windows PowerShell for SVG publication.');
  const helper = join(__dirname, '..', 'media', 'svg-publisher', 'publish.ps1');
  const input = JSON.stringify({ root: workspace, files: files.map(file => ({
    name: file.name, bytes: Buffer.from(file.bytes).toString('base64'),
  })) });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
      { windowsHide: true, cwd: join(systemRoot, 'System32'), stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 8192) stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() :
      reject(new Error(`Secure Windows SVG publication failed: ${stderr.trim() || `exit ${code}`}`)));
    child.stdin.on('error', () => { /* child close reports the native diagnostic */ });
    child.stdin.end(input, 'utf8');
  });
}
