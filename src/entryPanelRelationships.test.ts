import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(__dirname, 'createEntryPanel.ts'),
  'utf8'
);

describe('Entry panel relationships plumbing', () => {
  it('reads relationships concurrently with the other context reads', () => {
    const fanout = source.slice(
      source.indexOf('await Promise.all(['),
      source.indexOf('const macros = macroBundle.macros;')
    );
    expect(fanout).toContain('readRelationships(root)');
    // A serial `await readRelationships(...)` outside the fan-out would
    // re-add the latency the concurrency exists to remove.
    expect(source).not.toMatch(/await\s+readRelationships\(/);
  });

  it('ships the filtered relationship rows in the context payload', () => {
    const payload = source.slice(
      source.indexOf("const payload = {"),
      source.indexOf('void this.panel.webview.postMessage(payload);')
    );
    expect(payload).toContain('relationships: relationshipRows');
    expect(source).toContain('selectEntryRelationships(');
  });

  it('sends no relationships in create mode (no identity yet)', () => {
    expect(source).toContain("this.mode === 'edit' ? this.id : ''");
  });
});
