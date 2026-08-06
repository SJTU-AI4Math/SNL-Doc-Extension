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
    const acknowledgement = updatedCase.indexOf("type: 'updated'");
    expect(acknowledgement).toBeGreaterThanOrEqual(0);
    expect(updatedCase.indexOf('await this.pushContext();', acknowledgement))
      .toBeGreaterThan(acknowledgement);
  });

  it('tags every directly-published Entry target message with targetGeneration', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'createEntryPanel.ts'), 'utf8');
    const targetTypes = new Set([
      'context', 'created', 'createCommitted', 'updated', 'duplicate',
      'notFound', 'unknownKind', 'invalid', 'noSnlDoc', 'noWorkspace',
      'error', 'packageCreated', 'packageCreateFailed'
    ]);
    const directPublications = Array.from(
      source.matchAll(/this\.panel\.webview\.postMessage\(\{([\s\S]*?)\}\)/g)
    );
    const untagged = directPublications.flatMap((match) => {
      const body = match[1];
      const type = /type:\s*'([^']+)'/.exec(body)?.[1];
      return type && targetTypes.has(type) && !body.includes('targetGeneration')
        ? [type]
        : [];
    });
    expect(untagged).toEqual([]);
  });
});
