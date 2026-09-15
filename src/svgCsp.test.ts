import { describe, expect, it } from 'vitest';
import { panel_content_security_policy } from './panelHtml';

function assertLocalSvgPolicy(policy: string): void {
  const directives = policy.split(';').map(part => part.trim().split(/\s+/));
  expect(directives.filter(([name]) => name === 'default-src')).toEqual([["default-src", "'none'"]]);
  expect(directives.some(([name]) => name === 'connect-src')).toBe(false);
  expect(policy).not.toMatch(/https?:|wss?:|(?:^|\s)\*(?:\s|$)/i);
  expect(directives.find(([name]) => name === 'img-src')).toEqual(['img-src', 'vscode-webview://unit', 'data:']);
}

describe('SVG asset bridge CSP', () => {
  it('keeps default deny and SVG resources local, without network connections', () => {
    assertLocalSvgPolicy(panel_content_security_policy('nonce', 'vscode-webview://unit'));
  });
  it.each(['default', 'connect', 'image'] as const)('rejects the independent %s policy mutant', axis => {
    const policy = panel_content_security_policy('nonce', 'vscode-webview://unit');
    assertLocalSvgPolicy(policy); // valid production policy first; no invalid-fixture early return
    const mutant = axis === 'default' ? policy.replace("default-src 'none'", "default-src *")
      : axis === 'connect' ? policy + '; connect-src https:'
      : policy.replace('img-src ', 'img-src https: ');
    expect(mutant).not.toBe(policy);
    expect(() => assertLocalSvgPolicy(mutant)).toThrow();
    assertLocalSvgPolicy(policy);
  });
});
