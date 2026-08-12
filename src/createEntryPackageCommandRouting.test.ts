import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('createEntryPackage command routing', () => {
  it('opens the dedicated Entry Package creation panel instead of the Entry/Macro editor', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'extension.ts'), 'utf8');
    const registration = source.match(
      /registerCommand\(\s*['"]snlDoc\.createEntryPackage['"][\s\S]*?\n\s*\);/
    )?.[0] ?? '';

    expect(registration).toContain('CreateEntryPackagePanel.createOrShow');
    expect(registration).not.toContain('CreateEntryPanel.createPackageOrShow');
    expect(registration).not.toContain('CreateMacroPackagePanel.createOrShow');
  });
});
