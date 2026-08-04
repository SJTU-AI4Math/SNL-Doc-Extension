import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  contributes?: { commands?: Array<{ command?: string }> };
};
const extensionSource = readFileSync('src/extension.ts', 'utf8');

describe('data migration command lifecycle contract', () => {
  for (const command of ['snlDoc.checkDataVersion', 'snlDoc.repairData']) {
    it(`contributes, registers and disposes ${command}`, () => {
      expect(manifest.contributes?.commands?.some((item) => item.command === command)).toBe(true);
      expect(extensionSource).toContain(`'${command}'`);
    });
  }

  it('keeps both registered disposables in context subscriptions', () => {
    expect(extensionSource).toMatch(
      /context\.subscriptions\.push\([\s\S]*checkDataVersionCommand,[\s\S]*repairDataCommand/
    );
  });
});
