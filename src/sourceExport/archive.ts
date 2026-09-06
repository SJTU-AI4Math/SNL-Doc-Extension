import { constants, promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeEntryPointer } from '../pointerSync/schema';
import { resolvePointerTextAsync } from '../pointerSync/resolve';
import type { SourceEntryInput, SourceExportOptions, SourcePreview, SourceRoute, SourceFile, SourcePointer } from './types';

export interface SourceCaptureInput {
  rootPath: string; destinationPath: string; inline: boolean;
  entries: SourceEntryInput[]; entryRoutes: SourceRoute[]; renderSnapshotId: string;
  options: SourceExportOptions; signal?: AbortSignal;
  onProgress?: (progress: { phase: 'scan' | 'read' | 'verify'; files: number; bytes: number; path?: string }) => void;
}
/** A blocked preview is available to host UI; it is NOT confirmation to publish. */
export class SourcePreflightError extends Error {
  constructor(message: string, public readonly preview?: SourcePreview) { super(message); this.name = 'SourcePreflightError'; }
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value);
const receipts = new WeakMap<SourcePreview, { input: string; scan: string; payload: string }>();
const within = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const fingerprint = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
const identity = (s: BigIntStats) => `${s.dev}:${s.ino}`;
function portable(value: string, rule = false): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f-\u009f\\:]/u.test(value) || value.startsWith('/') ||
    value.split('/').some(p => !p || p === '.' || p === '..') || (!rule && value.includes('*'))) {
    throw new SourcePreflightError('Unsafe source path or rule');
  }
  return value;
}
function segmentMatch(pattern: string, text: string): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (pattern[p] === '*') { star = p++; mark = t; }
    else if (pattern[p] === text[t]) { p++; t++; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function glob(pattern: string, name: string): boolean {
  const ps = pattern.split('/'), ns = name.split('/');
  let row = Array<boolean>(ns.length + 1).fill(false); row[0] = true;
  for (const part of ps) {
    const next = Array<boolean>(ns.length + 1).fill(false);
    for (let n = 0; n <= ns.length; n++) {
      next[n] = part === '**' ? row[n] || (n > 0 && next[n - 1]) : n > 0 && row[n - 1] && segmentMatch(part, ns[n - 1]);
    }
    row = next;
  }
  return row[ns.length];
}
function matches(rules: string[], name: string, dirs: Set<string>): boolean {
  return rules.some(rule => glob(rule, name) || (!rule.includes('*') && dirs.has(rule) && name.startsWith(`${rule}/`)));
}
function defaultReason(name: string): string | undefined {
  const parts = name.split('/');
  if (parts.some(p => /^(?:\.SNL_Doc|\.git|\.lake|node_modules|dist|build|out|coverage|\.cache|__pycache__|\.next|target)$/.test(p))) return 'default build/cache exclusion';
  if (parts.some(p => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.netrc|\.pypirc)$/i.test(p)) || /\.(?:pem|key|p12|pfx|jks)$/i.test(name)) return 'default sensitive-file exclusion';
  return undefined;
}
async function canonicalFuture(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourcePreflightError('Cannot resolve destination');
    const parent = path.dirname(file);
    if (parent === file) throw new SourcePreflightError('Cannot resolve destination');
    return path.join(await canonicalFuture(parent), path.basename(file));
  }
}
function inputKey(input: SourceCaptureInput): string {
  return sha(json({ rootPath: path.resolve(input.rootPath), destinationPath: path.resolve(input.destinationPath), inline: input.inline,
    entries: input.entries, entryRoutes: input.entryRoutes, renderSnapshotId: input.renderSnapshotId, options: input.options }));
}
interface Node { name: string; real: string; stat: BigIntStats; link: boolean; }
interface Scan { nodes: Map<string, Node>; dirs: Set<string>; excluded: Map<string, string>; external: Set<string>; key: string; }

/** Serial descriptor reads bound memory/concurrency. No workspace code, hooks or regex run on the host. */
export async function captureSourceSnapshot(input: SourceCaptureInput): Promise<SourcePreview> {
  const inputHash = inputKey(input);
  const { entries, entryRoutes, options, renderSnapshotId } = structuredClone({ entries: input.entries, entryRoutes: input.entryRoutes, options: input.options, renderSnapshotId: input.renderSnapshotId });
  const check = () => { if (input.signal?.aborted) throw new SourcePreflightError('Source capture cancelled'); };
  check();
  if (!options.enabled) throw new SourcePreflightError('Source export is disabled');
  if (!renderSnapshotId || !['pointer-files', 'project'].includes(options.scope)) throw new SourcePreflightError('Invalid source capture options');
  for (const n of [options.maxFileBytes, options.maxTotalBytes]) if (!Number.isSafeInteger(n) || n < 1) throw new SourcePreflightError('Invalid source byte budget');
  for (const rules of [options.keep, options.exclude]) for (const rule of rules) portable(rule, true);
  for (const file of options.companionFiles) portable(file);
  const root = await fs.realpath(input.rootPath).catch(() => { throw new SourcePreflightError('Source root unavailable'); });
  if (!(await fs.stat(root)).isDirectory()) throw new SourcePreflightError('Source root is not a directory');
  const destLexical = path.resolve(input.destinationPath), dest = await canonicalFuture(destLexical);
  if (within(dest, root)) throw new SourcePreflightError('Destination must not contain the source root');
  const allowed: string[] = [];
  for (const external of options.allowedExternalRoots) {
    if (!path.isAbsolute(external) || /[\u0000-\u001f\u007f]/u.test(external)) throw new SourcePreflightError('Invalid external authorization root');
    const real = await fs.realpath(external).catch(() => { throw new SourcePreflightError('External authorization root unavailable'); });
    if (path.dirname(real) === real || !(await fs.stat(real)).isDirectory()) throw new SourcePreflightError('External authorization must name a specific directory');
    allowed.push(real);
  }
  const entryIds = new Set<string>();
  for (const entry of entries) { if (!entry.id || entryIds.has(entry.id)) throw new SourcePreflightError('Duplicate or invalid snapshot Entry'); entryIds.add(entry.id); }
  for (const route of entryRoutes) {
    if (!entryIds.has(route.entryId) || !/^#\/(?:node|entry)\//.test(route.hash) || /[\u0000-\u001f]/.test(route.hash)) throw new SourcePreflightError('Route is outside snapshot Entry closure');
  }
  const pointers: SourcePointer[] = entries.filter(e => e.pointer != null).map(entry => {
    const p = normalizeEntryPointer(entry.pointer);
    if (p) portable(p.file);
    // Unknown fields (including host paths) are never serialized into the public protocol.
    return { entryId: entry.id, ...(entry.package === undefined ? {} : { package: entry.package }),
      ...(entry.title === undefined ? {} : { title: entry.title }), pointer: p,
      status: 'unresolved', ...(p ? {} : { reason: 'invalid Pointer shape' }) };
  });
  const candidates = [...new Set([...pointers.flatMap(p => p.pointer ? [(p.pointer as {file: string}).file] : []), ...options.companionFiles])].sort();
  let totalBytes = 0, readFiles = 0;
  const progress = (phase: 'scan' | 'read' | 'verify', name?: string) => { check(); input.onProgress?.({ phase, files: readFiles, bytes: totalBytes, ...(name ? { path: name } : {}) }); check(); };
  async function scan(): Promise<Scan> {
    const nodes = new Map<string, Node>(), dirs = new Set<string>(['']), excluded = new Map<string, string>(), external = new Set<string>();
    const names = new Map<string, string>(), records: string[] = [];
    let count = 0;
    const rootStat = await fs.stat(root, { bigint: true });
    if (await fs.realpath(input.rootPath) !== root) throw new SourcePreflightError('Source root changed during capture');
    records.push(`root:${root}:${fingerprint(rootStat)}`, `destination:${dest}`);
    async function inspect(name: string, parents: Set<string>, inheritedLink = false, recurse = false): Promise<void> {
      check(); portable(name);
      if (++count > 200000 || name.split('/').length > 256) throw new SourcePreflightError('Source enumeration budget exceeded');
      if (count % 128 === 0) progress('scan', name);
      const collision = name.normalize('NFC').toLowerCase();
      const previous = names.get(collision);
      if (previous !== undefined && previous !== name) throw new SourcePreflightError('Source case/Unicode path collision');
      names.set(collision, name);
      if (nodes.has(name) || excluded.has(name)) return;
      const absolute = path.join(root, name);
      if (within(destLexical, absolute) || within(dest, absolute)) { excluded.set(name, 'output destination'); return; }
      let lst: BigIntStats, stat: BigIntStats, real: string;
      try { lst = await fs.lstat(absolute, { bigint: true }); real = await fs.realpath(absolute); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') { excluded.set(name, 'missing file or dangling symlink'); records.push(`${name}:missing`); return; }
        if (code === 'ELOOP') throw new SourcePreflightError('Source symlink cycle');
        throw new SourcePreflightError('Source metadata read failed');
      }
      if (within(dest, real)) { excluded.set(name, 'output destination'); return; }
      if (!within(root, real) && !allowed.some(a => within(a, real))) {
        external.add(real); excluded.set(name, 'external symlink target requires explicit root authorization'); records.push(`${name}:external:${real}:${fingerprint(lst)}`); return;
      }
      stat = await fs.stat(absolute, { bigint: true }).catch(() => { throw new SourcePreflightError('Source changed during enumeration'); });
      if (!stat.isFile() && !stat.isDirectory()) throw new SourcePreflightError('Unsafe source file type (socket/FIFO/device)');
      if (stat.isDirectory()) dirs.add(name);
      const reason = matches(options.exclude, name, dirs) ? 'explicit exclude rule' : matches(options.keep, name, dirs) ? undefined : defaultReason(name);
      records.push(`${name}:${real}:${fingerprint(lst)}:${fingerprint(stat)}:${reason ?? ''}`);
      if (reason) excluded.set(name, reason);
      const link = inheritedLink || lst.isSymbolicLink() || real !== absolute;
      if (!reason) nodes.set(name, { name, real, stat, link });
      if (stat.isDirectory() && recurse) {
        if (parents.has(identity(stat))) throw new SourcePreflightError('Source symlink directory cycle');
        if (reason === 'explicit exclude rule' || (reason && options.keep.length === 0)) return;
        const next = new Set(parents).add(identity(stat));
        const children = (await fs.readdir(absolute).catch(() => { throw new SourcePreflightError('Source directory read failed'); })).sort();
        for (const child of children) await inspect(`${name}/${child}`, next, link, true);
      }
    }
    const parents = new Set([identity(rootStat)]);
    if (options.scope === 'project') {
      for (const child of (await fs.readdir(root)).sort()) await inspect(child, parents, false, true);
    } else {
      for (const name of candidates) {
        const parts = name.split('/'); let blocked: string | undefined;
        for (let i = 1; i <= parts.length; i++) {
          const sub = parts.slice(0, i).join('/');
          if (blocked) { excluded.set(sub, blocked); continue; }
          await inspect(sub, parents);
          // Defaults on parents are overridable by a deep keep rule. Hard boundaries never are.
          const reason = excluded.get(sub);
          if (reason && !reason.startsWith('default')) blocked = reason;
          if (i < parts.length && nodes.get(sub)?.stat.isFile()) blocked = 'parent is not a directory';
        }
      }
    }
    return { nodes, dirs, excluded, external, key: sha(json(records.sort())) };
  }
  progress('scan');
  const first = await scan();
  const files: SourceFile[] = [], chunks: SourcePreview['chunks'] = [], texts = new Map<string, string>(), fileByPath = new Map<string, SourceFile>();
  const warnings = ['Source payload is visible to every reader; default filters cannot detect every secret. Disk bytes only; no cross-file atomic repository snapshot is claimed.'];
  const aliases = new Map<string, string>();
  for (const node of [...first.nodes.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!node.stat.isFile()) continue;
    check();
    const limit = Math.min(options.maxFileBytes, options.maxTotalBytes - totalBytes);
    if (node.stat.size > BigInt(limit)) throw new SourcePreflightError(`Source byte budget exceeded: ${node.name} (${node.stat.size} bytes; remaining ${limit})`);
    const handle = await fs.open(node.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new SourcePreflightError('Source changed or cannot be opened safely'); });
    let bytes: Buffer;
    try {
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(node.stat)) throw new SourcePreflightError('Source changed before read');
      const parts: Buffer[] = []; let length = 0;
      while (true) {
        check(); const block = Buffer.alloc(Math.min(65536, limit - length + 1));
        const result = await handle.read(block, 0, block.length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
        if (length > limit) throw new SourcePreflightError('Source byte budget exceeded during read');
        parts.push(block.subarray(0, result.bytesRead));
      }
      bytes = Buffer.concat(parts, length); totalBytes += length; readFiles++; progress('read', node.name);
      const after = await handle.stat({ bigint: true });
      const realAfter = await fs.realpath(path.join(root, node.name));
      const statAfter = await fs.stat(path.join(root, node.name), { bigint: true });
      if (node.real !== realAfter || fingerprint(node.stat) !== fingerprint(after) || fingerprint(node.stat) !== fingerprint(statAfter)) throw new SourcePreflightError('Source changed during read');
    } catch (error) {
      if (error instanceof SourcePreflightError) throw error;
      throw new SourcePreflightError('Source changed or read failed');
    } finally { await handle.close(); }
    const oldAlias = aliases.get(identity(node.stat));
    if (oldAlias) warnings.push(`Shared file identity: ${oldAlias} and ${node.name}; both virtual paths retained.`);
    else aliases.set(identity(node.stat), node.name);
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let text: string | undefined, kind: SourceFile['kind'] = 'text';
    const binaryExtension = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|wasm|exe|dll|so|o|a|mp[34]|ogg)$/i.test(node.name);
    if (binaryExtension) kind = 'binary';
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) { kind = 'binary'; text = undefined; } }
      catch { kind = 'unsupported'; }
    }
    let eol: SourceFile['eol'] = 'none';
    if (text !== undefined) {
      const crlf = text.includes('\r\n'), lf = /(?<!\r)\n/.test(text), cr = /\r(?!\n)/.test(text);
      eol = Number(crlf) + Number(lf) + Number(cr) > 1 || cr ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
      texts.set(node.name, text);
    }
    const languages: Record<string, string> = { lean: 'lean4', ts: 'typescript', tsx: 'typescript', js: 'javascript', json: 'json', md: 'markdown', py: 'python', rs: 'rust', c: 'c', cpp: 'cpp', html: 'html', svg: 'xml', css: 'css', tex: 'latex', yaml: 'yaml', yml: 'yaml' };
    const fileId = sha(node.name), digest = sha(bytes);
    const file: SourceFile = { fileId, displayPath: node.name, kind, language: Object.prototype.hasOwnProperty.call(languages, path.extname(node.name).slice(1)) ? languages[path.extname(node.name).slice(1)] : 'plaintext', byteLength: bytes.length, sha256: digest, bom, eol, chunkId: `source-${fileId}.js`, ...(node.link ? { symlink: true } : {}) };
    files.push(file); chunks.push({ fileId, sha256: digest, base64: bytes.toString('base64') }); fileByPath.set(node.name, file);
  }
  for (const p of pointers) {
    check(); const pointer = normalizeEntryPointer(p.pointer); if (!pointer) continue;
    const file = fileByPath.get(pointer.file);
    if (!file) {
      const reason = first.excluded.get(pointer.file) ?? 'not an included regular file';
      p.status = /exclude|output/.test(reason) ? 'excluded' : 'unavailable'; p.reason = reason; continue;
    }
    p.fileId = file.fileId; p.sourceSha256 = file.sha256;
    const text = texts.get(pointer.file);
    if (text === undefined) { p.status = 'unsupported'; p.reason = file.kind === 'binary' ? 'binary payload has no text coordinates' : 'unsupported UTF-8 encoding'; continue; }
    const resolved = await resolvePointerTextAsync(pointer, text); check();
    if (resolved.status === 'ok') { p.status = 'ok'; p.range = resolved.range; }
    else { p.status = 'unresolved'; p.reason = resolved.status; }
  }
  progress('verify');
  const last = await scan();
  if (first.key !== last.key || inputKey(input) !== inputHash) throw new SourcePreflightError('Source files, set or document inputs changed during capture');
  const directories = new Set<string>();
  for (const node of first.nodes.values()) if (node.stat.isDirectory()) directories.add(node.name);
  for (const name of [...directories, ...files.map(f => f.displayPath)]) {
    const parts = name.split('/'); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const snapshot: SourcePreview['manifest']['snapshot'] = { mode: 'disk' };
  // Git is provenance only, never the file enumerator. Disable executable fsmonitor hooks.
  const run = promisify(execFile);
  try {
    const git = await run('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD'], { cwd: root, timeout: 3000, maxBuffer: 1024 * 1024 });
    const status = await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=all'], { cwd: root, timeout: 3000, maxBuffer: 1024 * 1024 });
    if (/^[a-f0-9]{40,64}$/.test(git.stdout.trim())) { snapshot.gitCommit = git.stdout.trim(); snapshot.dirty = !!status.stdout; }
  } catch { /* No Git claim if Git provenance cannot be determined. Byte hashes remain authoritative. */ }
  check();
  // Provenance lookup also yields the event loop: do not leave a final capture race behind it.
  if ((await scan()).key !== first.key || inputKey(input) !== inputHash) throw new SourcePreflightError('Source files or document inputs changed during capture');
  const manifest: SourcePreview['manifest'] = { schemaVersion: 'snl.export.sources/v1', exportId: '', renderSnapshotId,
    workspaceName: path.basename(root), snapshot,
    options: { scope: options.scope, keep: options.keep, exclude: options.exclude, companionFiles: options.companionFiles },
    files, directories: [...directories].sort(), pointers, entryRoutes };
  manifest.exportId = sha(json(manifest));
  const preview: SourcePreview = { manifest, chunks, totalBytes,
    estimatedBytes: Buffer.byteLength(json(manifest)) + chunks.reduce((n, c) => n + Buffer.byteLength(json(c)) + 160, 0),
    exclusions: [...first.excluded].map(([name, reason]) => ({ path: name, reason })).sort((a, b) => a.path < b.path ? -1 : 1),
    warnings, externalRoots: [...first.external].sort(), confirmationId: sha(inputHash + first.key + manifest.exportId) };
  if (!options.allowMissing && (pointers.some(p => p.status !== 'ok') || options.companionFiles.some(name => !fileByPath.has(name)))) throw new SourcePreflightError('Source Pointer/companion closure is incomplete; explicitly accept missing sources or change filters', preview);
  receipts.set(preview, { input: inputHash, scan: first.key, payload: sha(json(preview)) });
  return preview;
}

/** A changed set/byte/identity/Pointer/options/render revision requires a NEW user confirmation. */
export async function revalidateSourceSnapshot(preview: SourcePreview, input: SourceCaptureInput): Promise<void> {
  const receipt = receipts.get(preview);
  if (!receipt || receipt.input !== inputKey(input) || receipt.payload !== sha(json(preview))) throw new SourcePreflightError('Source preview is stale or modified');
  let fresh: SourcePreview;
  try { fresh = await captureSourceSnapshot(input); }
  catch { throw new SourcePreflightError('Source snapshot changed or cannot be revalidated; recapture and reconfirm'); }
  const next = receipts.get(fresh)!;
  if (next.scan !== receipt.scan || next.payload !== receipt.payload) throw new SourcePreflightError('Source snapshot changed; recapture and reconfirm');
}
