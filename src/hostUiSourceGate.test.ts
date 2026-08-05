import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname);
const NOTIFICATION_METHODS = new Set([
  'showInformationMessage', 'showWarningMessage', 'showErrorMessage'
]);

function files(): string[] {
  return fs.readdirSync(SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(SRC, name));
}

function line(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isRawCopy(node: ts.Expression): boolean {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isRawCopy(node.expression);
  if (ts.isConditionalExpression(node)) return isRawCopy(node.whenTrue) || isRawCopy(node.whenFalse);
  if (ts.isBinaryExpression(node)) return isRawCopy(node.left) || isRawCopy(node.right);
  if (ts.isArrayLiteralExpression(node)) return node.elements.some((item) => {
    if (ts.isStringLiteralLike(item)) return /\p{L}/u.test(item.text);
    return ts.isExpression(item) && isRawCopy(item);
  });
  return false;
}

function isRawHumanCopy(node: ts.Expression): boolean {
  if (ts.isStringLiteralLike(node)) return /\p{L}/u.test(node.text);
  return isRawCopy(node);
}

function audit(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const report = (node: ts.Node, kind: string): void => {
    failures.push(`${path.basename(file)}:${line(source, node)} ${kind}`);
  };
  const inspectMessageProperty = (object: ts.ObjectLiteralExpression): void => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText(source).replace(/["']/g, '');
      if ((name === 'message' || name === 'detail' || name === 'title' || name === 'placeHolder' ||
           name === 'prompt' || name === 'reason' || name === 'warnings') &&
          isRawHumanCopy(property.initializer)) {
        report(property.initializer, `raw ${name}`);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (NOTIFICATION_METHODS.has(method)) {
        const first = node.arguments[0];
        if (first && isRawCopy(first)) report(first, `raw ${method}`);
        for (const arg of node.arguments.slice(1)) {
          if (ts.isObjectLiteralExpression(arg)) inspectMessageProperty(arg);
        }
      }
      if (method === 'postMessage') {
        const first = node.arguments[0];
        if (first && ts.isObjectLiteralExpression(first)) inspectMessageProperty(first);
      }
      if (method === 'withProgress') {
        const first = node.arguments[0];
        if (first && ts.isObjectLiteralExpression(first)) inspectMessageProperty(first);
      }
      if (method === 'createWebviewPanel') {
        const title = node.arguments[1];
        if (title && isRawHumanCopy(title)) report(title, 'raw panel title');
      }
      if (method === 'showQuickPick' || method === 'showInputBox') {
        for (const arg of node.arguments) {
          if (ts.isObjectLiteralExpression(arg)) inspectMessageProperty(arg);
          else if (method === 'showQuickPick' && isRawCopy(arg)) report(arg, `raw ${method}`);
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'title' &&
        isRawHumanCopy(node.right)) {
      report(node.right, 'raw assigned title');
    }
    node.forEachChild(visit);
  };
  visit(source);
  return failures;
}

describe('Extension host UI localization source gate', () => {
  it('contains no directly-authored notification or postMessage prose', () => {
    const violations = files().flatMap(audit);
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
