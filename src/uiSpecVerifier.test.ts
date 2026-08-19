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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyUiSpecWorkspace } from './uiSpecVerifier';

let workspace: string;

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

async function rejectsMutation(path: string, mutate: (value: any) => void, pattern: RegExp): Promise<void> {
  const restore = mutateJson(path, mutate);
  try {
    await expect(verifyUiSpecWorkspace(workspace)).rejects.toThrow(pattern);
  } finally {
    restore();
  }
}

describe('UI specification workspace verifier', () => {
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'snl-ui-spec-verifier-'));
    cpSync(join(process.cwd(), '.SNL_Doc'), join(workspace, '.SNL_Doc'), { recursive: true });
  });

  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('accepts the committed specification workspace', async () => {
    await expect(verifyUiSpecWorkspace(workspace)).resolves.toMatchObject({
      dataVersion: '0.1.0', entries: 332, macros: 207, usedMacros: 207,
    });
  });

  it.each([
    ['format', 'not-snl-package'],
    ['version', false],
    ['schema_version', 1],
  ])('rejects an invalid Package %s literal independently', async (field, replacement) => {
    await rejectsMutation(firstJson('packages', 'commands-'), (manifest) => {
      manifest[field] = replacement;
    }, /Package manifest|schema_version/i);
  });

  it.each([
    ['format', 'not-snl-entry'],
    ['version', false],
    ['schema_version', 2],
  ])('rejects an invalid Entry %s literal independently', async (field, replacement) => {
    await rejectsMutation(firstJson('entries'), (envelope) => {
      envelope[field] = replacement;
    }, /Entry envelope|schema_version/i);
  });

  it.each([
    ['format', 'not-snl-macro'],
    ['version', false],
    ['schema_version', 2],
  ])('rejects an invalid Macro %s literal independently', async (field, replacement) => {
    await rejectsMutation(firstJson('macros'), (envelope) => {
      envelope[field] = replacement;
    }, /Macro envelope|schema_version/i);
  });

  it.each(['title', 'pointer', 'content'])('rejects an Entry missing required %s', async (field) => {
    await rejectsMutation(firstJson('entries'), (envelope) => {
      delete envelope.entry[field];
    }, /canonical Entry payload/i);
  });

  it.each(['description', 'dynamic_arity', 'tags'])('rejects a Macro missing required %s', async (field) => {
    await rejectsMutation(firstJson('macros'), (envelope) => {
      delete envelope.macro[field];
    }, /Macro|canonical/i);
  });

  it('rejects incomplete Kind metadata and blank themed colors independently', async () => {
    const configPath = join(workspace, '.SNL_Doc', 'config.json');
    await rejectsMutation(configPath, (config) => {
      delete config.entry_kinds[0].name;
    }, /entry_kinds.*name/i);
    await rejectsMutation(configPath, (config) => {
      config.entry_kinds[0].coloring.light.stroke = '';
    }, /coloring|stroke/i);
  });

  it('rejects unknown Entry and Macro kinds', async () => {
    await rejectsMutation(firstJson('entries'), (envelope) => {
      envelope.entry.kind = 'unknown-entry-kind';
    }, /unknown Entry Kind/);
    await rejectsMutation(firstJson('macros'), (envelope) => {
      envelope.macro.kind = 'unknown-macro-kind';
    }, /unknown Macro Kind/);
  });

  it('rejects a noncanonical owner/hash entity path', async () => {
    const source = firstJson('entries');
    const target = join(workspace, '.SNL_Doc', 'entries', 'arbitrary.json');
    renameSync(source, target);
    try {
      await expect(verifyUiSpecWorkspace(workspace)).rejects.toThrow(/logical identity path/);
    } finally {
      renameSync(target, source);
    }
  });

  it('rejects asset traversal before filesystem lookup', async () => {
    const entryDirectory = join(workspace, '.SNL_Doc', 'entries');
    const imagePath = readdirSync(entryDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(entryDirectory, name))
      .find((path) => readFileSync(path, 'utf8').includes('assets/Edit-Entry-Panel.png'));
    if (!imagePath) throw new Error('Image Entry fixture not found.');
    await rejectsMutation(imagePath, (envelope) => {
      envelope.entry.content.markdown = envelope.entry.content.markdown.replace(
        'assets/Edit-Entry-Panel.png',
        'assets/../../Edit-Entry-Panel.png',
      );
    }, /unsafe asset path/);
  });
});
