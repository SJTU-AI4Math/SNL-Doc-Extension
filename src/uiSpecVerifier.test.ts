import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let workspace: string;
const verifier = join(process.cwd(), 'scripts/verify-ui-spec-doc.mjs');

function runVerifier(): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [verifier, workspace], { encoding: 'utf8' });
}

function mutateJson(path: string, mutate: (value: any) => void): () => void {
  const original = readFileSync(path);
  const value = JSON.parse(original.toString('utf8'));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return () => writeFileSync(path, original);
}

function firstJson(directory: string, prefix = ''): string {
  const name = readdirSync(join(workspace, '.SNL_Doc', directory))
    .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith('.json'))
    .sort()[0];
  if (!name) throw new Error(`No fixture JSON found in ${directory}.`);
  return join(workspace, '.SNL_Doc', directory, name);
}

describe('UI specification workspace verifier', () => {
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'snl-ui-spec-verifier-'));
    cpSync(join(process.cwd(), '.SNL_Doc'), join(workspace, '.SNL_Doc'), { recursive: true });
  });

  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('accepts the committed specification workspace', () => {
    const result = runVerifier();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('rejects invalid Package format and version literals', () => {
    const path = firstJson('packages', 'commands-');
    const restore = mutateJson(path, (manifest) => {
      manifest.format = 'not-snl-package';
      manifest.version = false;
    });
    try {
      const result = runVerifier();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/canonical current Package manifest/);
    } finally {
      restore();
    }
  });

  it('rejects unknown Entry and Macro kinds', () => {
    const entryPath = firstJson('entries');
    const restoreEntry = mutateJson(entryPath, (envelope) => { envelope.entry.kind = 'unknown-entry-kind'; });
    try {
      const entryResult = runVerifier();
      expect(entryResult.status).not.toBe(0);
      expect(entryResult.stderr).toMatch(/supported current Entry envelope/);
    } finally {
      restoreEntry();
    }

    const macroPath = firstJson('macros');
    const restoreMacro = mutateJson(macroPath, (envelope) => { envelope.macro.kind = 'unknown-macro-kind'; });
    try {
      const macroResult = runVerifier();
      expect(macroResult.status).not.toBe(0);
      expect(macroResult.stderr).toMatch(/canonical current Macro envelope/);
    } finally {
      restoreMacro();
    }
  });

  it('rejects a noncanonical owner/hash entity path', () => {
    const source = firstJson('entries');
    const target = join(workspace, '.SNL_Doc', 'entries', 'arbitrary.json');
    renameSync(source, target);
    try {
      const result = runVerifier();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/canonical owner\/hash path/);
    } finally {
      renameSync(target, source);
    }
  });

  it('rejects asset traversal before filesystem lookup', () => {
    const entryDirectory = join(workspace, '.SNL_Doc', 'entries');
    const imagePath = readdirSync(entryDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(entryDirectory, name))
      .find((path) => readFileSync(path, 'utf8').includes('assets/Edit-Entry-Panel.png'));
    if (!imagePath) throw new Error('Image Entry fixture not found.');
    const restore = mutateJson(imagePath, (envelope) => {
      envelope.entry.content.markdown = envelope.entry.content.markdown.replace(
        'assets/Edit-Entry-Panel.png',
        'assets/../../Edit-Entry-Panel.png',
      );
    });
    try {
      const result = runVerifier();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unsafe asset path/);
    } finally {
      restore();
    }
  });
});
