import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(resolve(__dirname, '..', relative), 'utf8');
}

describe('authored Collapsible production scope wiring', () => {
  it('wraps Macro and Package previews in an explicit CollapsibleScope', () => {
    const macro = source('CreateMacroApp.tsx');
    const sharedPreview = source('render/MacroPreview.tsx');
    expect(macro).toContain('<CollapsibleScope');
    expect(macro).toMatch(/<CollapsibleScope[\s\S]*?<SnlSyntaxTreeView/);
    expect(sharedPreview).toContain('<CollapsibleScope');
    expect(sharedPreview).toMatch(/<CollapsibleScope[\s\S]*?\{view\}/);
    expect(source('PackagePanelApp.tsx')).toContain('<MacroPreview');
  });

  it('uses one scope around the Canvas rather than one per recursive tree view', () => {
    const canvas = source('CreateEntryApp.tsx');
    expect(canvas).toContain("label={t('canvasAria')}");
    expect((canvas.match(/<CollapsibleScope/g) ?? [])).toHaveLength(1);
  });
});
