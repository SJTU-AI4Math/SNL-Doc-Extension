import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('editor-title cat navigation contribution', () => {
  it('opens navigation instead of Dashboard directly and keeps the cat icon', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    const commands = manifest.contributes.commands as Array<Record<string, unknown>>;
    const titleItems = manifest.contributes.menus['editor/title'] as Array<Record<string, unknown>>;
    const navigation = commands.find((item) => item.command === 'snlDoc.openNavigation');

    expect(navigation).toEqual(expect.objectContaining({
      command: 'snlDoc.openNavigation',
      icon: {
        light: 'media/icons/cat-light.svg',
        dark: 'media/icons/cat-dark.svg'
      }
    }));
    expect(titleItems).toContainEqual(expect.objectContaining({
      command: 'snlDoc.openNavigation',
      group: 'navigation@-100'
    }));
    expect(titleItems).not.toContainEqual(expect.objectContaining({
      command: 'snlDoc.openDashboard'
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      command: 'snlDoc.createEntryPackage'
    }));
  });
});