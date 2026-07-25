import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CreateEntryPanel update roundtrip', () => {
  it('acknowledges an update and then pushes authoritative context explicitly', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'createEntryPanel.ts'), 'utf8');
    const updatedCase = source.slice(
      source.indexOf("case 'updated':"),
      source.indexOf("case 'notFound':")
    );
    expect(updatedCase).toContain("type: 'updated'");
    expect(updatedCase).toContain('await this.pushContext();');
    expect(updatedCase.indexOf("type: 'updated'"))
      .toBeLessThan(updatedCase.indexOf('await this.pushContext();'));
  });
});
