import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOrGenerateCache } from './derivedCache';
const roots: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'snl-derived-')); roots.push(root);
  await fs.mkdir(join(root, '.SNL_Doc'));
  await fs.writeFile(join(root, '.SNL_Doc', 'config.json'), '{"version":"fixture"}');
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const valid = (v: unknown): v is { value: number } => typeof v === 'object' && v !== null && Number.isFinite((v as { value: number }).value);
it('reuses a validated persisted result without changing authored bytes, then invalidates by input', async () => {
  const root = await workspace(); const generate = vi.fn(() => ({ value: 3 }));
  const r = { id: 'ssi', version: '1', input: { entry: 'A', snl: 'x' }, validate: valid, generate };
  expect(await getOrGenerateCache(root, r)).toEqual({ value: 3 });
  expect(await getOrGenerateCache(root, r)).toEqual({ value: 3 });
  expect(generate).toHaveBeenCalledTimes(1);
  const disk = JSON.parse(await fs.readFile(join(root, '.SNL_Doc/.cache/ssi/result.json'), 'utf8'));
  expect(disk.value).toEqual({ value: 3 });
  await getOrGenerateCache(root, { ...r, input: { entry: 'A', snl: 'y' } });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(join(root, '.SNL_Doc/config.json'), 'utf8')).toBe('{"version":"fixture"}');
});
