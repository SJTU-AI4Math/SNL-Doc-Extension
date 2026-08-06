import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const source = (file: string): string => readFileSync(join(root, 'src', file), 'utf8');

describe('editor missing-target host protocol', () => {
  for (const file of [
    'createEntryPanel.ts',
    'createMacroPanel.ts',
    'createMacroPackagePanel.ts',
    'createRelationshipPanel.ts',
    'kindPanelController.ts'
  ]) {
    it(`${file} publishes an explicit target state on every edit context`, () => {
      const text = source(file);
      expect(text).toContain('targetState:');
    });
  }

  it('does not downgrade a missing edited Macro Package to create mode', () => {
    const text = source('createMacroPanel.ts');
    expect(text).not.toContain('concurrently removed Package is represented as an empty create context');
    expect(text).toContain("targetState: this.mode === 'edit' ? 'notFound' : 'found'");
  });
});
