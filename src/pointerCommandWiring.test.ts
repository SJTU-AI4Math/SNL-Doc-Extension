import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
describe('Pointer command contributions', () => {
  it('contributes discoverable reverse and maintenance commands', () => {
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(ids).toContain('snlDoc.revealNearestEntry');
    expect(ids).toContain('snlDoc.maintainPointers');
  });
  it('scopes the reverse shortcut to an SNL source editor', () => {
    const binding = pkg.contributes.keybindings.find((c: { command: string }) => c.command === 'snlDoc.revealNearestEntry');
    expect(binding).toMatchObject({ key: 'ctrl+alt+j', mac: 'cmd+alt+j' });
    expect(binding.when).toContain('editorTextFocus');
    expect(binding.when).toContain('snlDoc.hasSnlDoc');
  });
  it('provides localized command titles', () => {
    for (const path of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const values = JSON.parse(readFileSync(resolve(path), 'utf8'));
      expect(values['snlDoc.command.revealNearestEntry']).toBeTruthy();
      expect(values['snlDoc.command.maintainPointers']).toBeTruthy();
    }
  });
});
