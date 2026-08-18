import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const editorSources = [
  ['CreateEntryApp.tsx', 3],
  ['CreateMacroApp.tsx', 4]
] as const;

function jsxAttributes(source: string, tagName: string): string[][] {
  const file = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const results: string[][] = [];
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening?.tagName.getText(file) === tagName) {
      results.push(opening.attributes.properties.flatMap((property) =>
        ts.isJsxAttribute(property) ? [property.name.getText(file)] : []
      ));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return results;
}

describe('controlled editor input event ordering', () => {
  it.each(editorSources)('%s marks dirty after target input handlers', (file) => {
    const source = readFileSync(`webview/src/${file}`, 'utf8');
    const mainAttributes = jsxAttributes(source, 'main');
    expect(mainAttributes.filter((attributes) => attributes.includes('onInput'))).toHaveLength(1);
    expect(mainAttributes.every((attributes) => !attributes.includes('onInputCapture'))).toBe(true);
  });

  it.each(editorSources)('%s commits every native select during input before change fallback', (file, expected) => {
    const source = readFileSync(`webview/src/${file}`, 'utf8');
    const selects = jsxAttributes(source, 'select');
    expect(selects).toHaveLength(expected);
    for (const attributes of selects) {
      expect(attributes).toContain('onInput');
      expect(attributes).toContain('onChange');
    }
  });
});
