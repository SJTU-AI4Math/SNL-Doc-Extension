import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEBVIEW_SRC = path.resolve(__dirname, '..');
const USER_COPY_ATTRIBUTES = new Set([
  'aria-label',
  'description',
  'emptyHint',
  'error',
  'hint',
  'label',
  'loadingLabel',
  'placeholder',
  'title'
]);

function productionTsxFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(absolute);
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) return [];
    return [absolute];
  });
}

function hasHumanLetters(value: string): boolean {
  if (!/[A-Za-z\u3400-\u9fff]/.test(value)) return false;
  if (/^(?:var|rgba?|url|rect)\(/.test(value)) return false;
  if (/--vscode|[{};]|^\.[A-Za-z_-]|^\[[^\]]+\]$/.test(value)) return false;
  if (/^[0-9.\s%a-z-]+$/.test(value)) return false;
  return /\s|[\u3400-\u9fff]|^[A-Z]|[…!?]/.test(value);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function displayLiteralViolations(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures: string[] = [];
  const report = (node: ts.Node, value: string): void => {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact && hasHumanLetters(compact)) {
      failures.push(`${path.relative(WEBVIEW_SRC, file)}:${lineOf(source, node)} ${JSON.stringify(compact)}`);
    }
  };
  const inspectDisplayExpression = (node: ts.Expression): void => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text);
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      inspectDisplayExpression(node.expression);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      inspectDisplayExpression(node.whenTrue);
      inspectDisplayExpression(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      inspectDisplayExpression(node.left);
      inspectDisplayExpression(node.right);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      report(node.head, node.head.text);
      for (const span of node.templateSpans) report(span.literal, span.literal.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxAttribute(node) && USER_COPY_ATTRIBUTES.has(node.name.getText(source))) {
      const initializer = node.initializer;
      if (initializer && ts.isStringLiteral(initializer)) report(initializer, initializer.text);
      if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
        inspectDisplayExpression(initializer.expression);
      }
    }
    if (ts.isJsxExpression(node) && node.parent &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && node.expression) {
      inspectDisplayExpression(node.expression);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return failures;
}

describe('Webview UI localization source gate', () => {
  it('contains no raw user-visible JSX copy outside message definitions', () => {
    const violations = productionTsxFiles(WEBVIEW_SRC).flatMap(displayLiteralViolations);
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
