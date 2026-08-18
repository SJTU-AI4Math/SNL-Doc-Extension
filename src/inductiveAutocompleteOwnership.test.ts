import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextInductiveAutocompleteOwner } from './inductiveAutocompleteOwnership';

describe('Inductive autocomplete Tab ownership', () => {
  it('does not let a stale owner clear the current owner', () => {
    let owner: string | null = null;
    owner = nextInductiveAutocompleteOwner(owner, { ownerToken: 'first', ownsTab: true });
    expect(owner).toBe('first');
    owner = nextInductiveAutocompleteOwner(owner, { ownerToken: 'second', ownsTab: true });
    expect(owner).toBe('second');
    owner = nextInductiveAutocompleteOwner(owner, { ownerToken: 'first', ownsTab: false });
    expect(owner).toBe('second');
    owner = nextInductiveAutocompleteOwner(owner, { ownerToken: 'second', ownsTab: false });
    expect(owner).toBeNull();
  });

  it('routes the owner message to the dedicated VS Code context key', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'createEntryPanel.ts'), 'utf8');
    const route = source.slice(
      source.indexOf("msg.type === 'inductiveAutocompleteTabOwnership'"),
      source.indexOf("msg.type === 'shortcutContext'")
    );
    expect(route).toContain("'snl.inductiveAutocompleteOwnsTab'");
    expect(source.slice(source.indexOf('private retarget('), source.indexOf('private revealPackageCreator(')))
      .toContain('this.clearInductiveAutocompleteOwnership();');
  });

  it('gates forward structural Tab but leaves reverse structural Tab unchanged', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    const bindings = manifest.contributes.keybindings as Array<{ command: string; when: string }>;
    const forward = bindings.find(({ command }) => command === 'snlDoc.inductive.openStyle');
    const reverse = bindings.find(({ command }) => command === 'snlDoc.inductive.previousField');
    expect(forward?.when).toContain('!snl.inductiveAutocompleteOwnsTab');
    expect(reverse?.when).not.toContain('snl.inductiveAutocompleteOwnsTab');
  });
});
