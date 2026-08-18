import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  contributes: { commands: Array<{ command: string }>; keybindings: Array<{ command: string; key: string; when: string }> };
};

const expected = new Map([
  ['snlDoc.inductive.moveUp', 'alt+up'],
  ['snlDoc.inductive.moveDown', 'alt+down'],
  ['snlDoc.inductive.outdent', 'alt+left'],
  ['snlDoc.inductive.indent', 'alt+right'],
  ['snlDoc.inductive.extractSelection', 'alt+x'],
  ['snlDoc.inductive.addParent', 'alt+p'],
  ['snlDoc.inductive.addSibling', 'alt+s'],
  ['snlDoc.inductive.openStyle', 'tab'],
  ['snlDoc.inductive.previousField', 'shift+tab'],
  ['snlDoc.inductive.nextNode', 'enter'],
  ['snlDoc.inductive.undo', 'ctrl+z']
]);

describe('Inductive editor VS Code keybindings', () => {
  it('contributes one customizable command and scoped default per semantic action', () => {
    const commands = new Set(pkg.contributes.commands.map(({ command }) => command));
    for (const [command, key] of expected) {
      expect(commands.has(command), command).toBe(true);
      const binding = pkg.contributes.keybindings.find((item) => item.command === command);
      expect(binding?.key).toBe(key);
      expect(binding?.when).toContain('activeWebviewPanelId == snlCreateEntry');
      expect(binding?.when).toContain('snlDoc.inductiveInputFocus');
    }
  });
});
