import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const styleObject = (
  opening: ts.JsxOpeningLikeElement,
  file: ts.SourceFile
): ts.ObjectLiteralExpression | undefined => {
  const style = opening.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText(file) === 'style'
  );
  if (!style || !ts.isJsxAttribute(style) ||
      !style.initializer || !ts.isJsxExpression(style.initializer) ||
      !style.initializer.expression) return undefined;
  let expression = style.initializer.expression;
  while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) ||
         ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return ts.isObjectLiteralExpression(expression) ? expression : undefined;
};

const objectPropertyValue = (
  object: ts.ObjectLiteralExpression | undefined,
  name: string,
  file: ts.SourceFile
): string | undefined => {
  let value: string | undefined;
  for (const property of object?.properties ?? []) {
    // Object spreads may overwrite every earlier key. A later explicit
    // assignment can make the target statically known again.
    if (ts.isSpreadAssignment(property)) {
      value = undefined;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isStringLiteral(property.name)
      ? property.name.text
      : property.name.getText(file);
    if (propertyName === name) value = property.initializer.getText(file);
  }
  return value;
};

const jsxStringAttribute = (
  opening: ts.JsxOpeningLikeElement,
  name: string,
  file: ts.SourceFile
): string | undefined => {
  const attribute = opening.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText(file) === name
  );
  return attribute && ts.isJsxAttribute(attribute) &&
    attribute.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : undefined;
};

/** One React app can back multiple Vite entries (Entry/Macro kind init/edit). */
const PANEL_APPS = [
  'App.tsx',
  'EntryInfoviewApp.tsx',
  'CreateLibraryApp.tsx',
  'DashboardApp.tsx',
  'InitKindsApp.tsx',
  'KindEditorApp.tsx',
  'CreateEntryApp.tsx',
  'CreateMacroPackageApp.tsx',
  'PackagePanelApp.tsx',
  'CreateMacroApp.tsx',
  'CreateRelationshipApp.tsx',
  'SnlGraphApp.tsx',
  'SnooglApp.tsx',
  'ExportOptionsApp.tsx'
];

describe('shared panel header coverage', () => {
  it('models JSX style spread and duplicate-property overwrite order', () => {
    const file = ts.createSourceFile(
      'fixture.tsx',
      "const x = <main style={{ padding: 0, ...PANEL_STYLE, padding: 2, height: '100vh' }} />;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let main: ts.JsxSelfClosingElement | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'main') main = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    const styles = main && styleObject(main, file);
    expect(objectPropertyValue(styles, 'padding', file)).toBe('2');
    expect(objectPropertyValue(styles, 'height', file)).toBe("'100vh'");

    const spreadLastFile = ts.createSourceFile(
      'spread-last.tsx',
      'const x = <main style={{ padding: 0, ...PANEL_STYLE }} />;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let spreadLastMain: ts.JsxSelfClosingElement | undefined;
    const findSpreadLast = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node)) spreadLastMain = node;
      ts.forEachChild(node, findSpreadLast);
    };
    findSpreadLast(spreadLastFile);
    expect(objectPropertyValue(
      spreadLastMain && styleObject(spreadLastMain, spreadLastFile),
      'padding',
      spreadLastFile
    )).toBeUndefined();
  });

  it('routes every webview panel app through PanelHeader', () => {
    for (const app of PANEL_APPS) {
      const text = source(`webview/src/${app}`);
      expect(text, app).toContain('<PanelHeader');
      expect(text, `${app} must not grow a second page title outside the shared header`)
        .not.toContain('<h1');
    }
  });

  it('has no live imports of the deleted PanelNav implementation', () => {
    for (const app of PANEL_APPS) {
      expect(source(`webview/src/${app}`), app).not.toContain("./components/PanelNav");
    }
  });

  it('pulls the sticky header through panel padding so it starts and stays at the true top', () => {
    const css = source('webview/src/components/ui.css');
    const geometryCss = css.replace(
      'calc(-1 * var(--snl-panel-header-top, 1.5rem))',
      '-24px'
    );
    expect(geometryCss).not.toBe(css);
    const dom = new JSDOM(
      `<style>${geometryCss}</style><main style="padding:1.5rem">` +
      '<nav class="snl-panel-header"></nav></main>',
      { pretendToBeVisual: true }
    );
    const bodyStyle = dom.window.getComputedStyle(dom.window.document.body);
    const headerStyle = dom.window.getComputedStyle(
      dom.window.document.querySelector<HTMLElement>('.snl-panel-header')!
    );
    expect(bodyStyle.margin).toBe('0px');
    expect(bodyStyle.padding).toBe('0px');
    expect(headerStyle.position).toBe('sticky');
    expect(headerStyle.top).toBe('0px');
    expect(headerStyle.marginTop).toBe('-24px');

    const graphFile = ts.createSourceFile(
      'SnlGraphApp.tsx',
      source('webview/src/SnlGraphApp.tsx'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let graphFunction: ts.FunctionDeclaration | undefined;
    graphFile.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'SnlGraphInner') {
        graphFunction = node;
      }
    });
    expect(graphFunction).toBeDefined();
    const graphMains: ts.JsxElement[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(graphFile) === 'main') {
        graphMains.push(node);
      }
      ts.forEachChild(node, visit);
    };
    if (graphFunction?.body) visit(graphFunction.body);
    const liveMains = graphMains.filter((main) =>
      objectPropertyValue(styleObject(main.openingElement, graphFile), 'height', graphFile) === "'100vh'"
    );
    expect(liveMains).toHaveLength(1);
    const liveMain = liveMains[0];
    expect(liveMain).toBeDefined();
    expect(objectPropertyValue(
      liveMain && styleObject(liveMain.openingElement, graphFile),
      'padding',
      graphFile
    )).toBe('0');
    const headerWrapper = liveMain?.children.find((child): child is ts.JsxElement =>
      ts.isJsxElement(child) && child.children.some((grandchild) =>
        ts.isJsxSelfClosingElement(grandchild) &&
        grandchild.tagName.getText(graphFile) === 'PanelHeader'
      )
    );
    expect(headerWrapper).toBeDefined();
    expect(objectPropertyValue(
      headerWrapper && styleObject(headerWrapper.openingElement, graphFile),
      '--snl-panel-header-top',
      graphFile
    )).toBe("'0px'");
  });

  it('does not classify ordinary snl-control buttons as read-only', () => {
    const css = source('webview/src/components/ui.css');
    const dom = new JSDOM(
      `<style>${css}</style>` +
      '<button id="trigger" class="snl-control snl-panel-header__language-trigger"></button>' +
      '<button id="item" class="snl-panel-header__language-item"></button>' +
      '<button id="disabled" class="snl-control" disabled></button>' +
      '<input id="readonly" class="snl-control" readonly>',
      { pretendToBeVisual: true }
    );
    const computedCursor = (id: string): string => dom.window.getComputedStyle(
      dom.window.document.getElementById(id)!
    ).cursor;
    expect(computedCursor('trigger')).toBe('pointer');
    expect(computedCursor('item')).toBe('pointer');
    expect(computedCursor('disabled')).toBe('not-allowed');
    expect(computedCursor('readonly')).toBe('not-allowed');
    expect(css).not.toContain('.snl-control:read-only');

    const headerFile = ts.createSourceFile(
      'PanelHeader.tsx',
      source('webview/src/components/PanelHeader.tsx'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const buttonClassIn = (functionName: string): string | undefined => {
      let result: string | undefined;
      headerFile.forEachChild((node) => {
        if (!ts.isFunctionDeclaration(node) || node.name?.text !== functionName) return;
        const findButton = (child: ts.Node): void => {
          if (result) return;
          if (ts.isJsxElement(child) &&
              child.openingElement.tagName.getText(headerFile) === 'button') {
            result = jsxStringAttribute(child.openingElement, 'className', headerFile);
            return;
          }
          ts.forEachChild(child, findButton);
        };
        if (node.body) findButton(node.body);
      });
      return result;
    };
    expect(buttonClassIn('LanguageSelector')?.split(/\s+/).sort()).toEqual([
      'snl-control',
      'snl-panel-header__language-trigger'
    ]);
    expect(buttonClassIn('LanguageMenuItem')).toBe('snl-panel-header__language-item');
  });
});
