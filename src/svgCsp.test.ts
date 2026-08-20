import { describe, expect, it } from 'vitest';
import { panel_content_security_policy } from './panelHtml';

describe('SVG asset bridge CSP', () => {
  it('keeps panels local-only with no network connection permission', () => {
    const policy = panel_content_security_policy('nonce', 'vscode-webview://unit');
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/(?:^|;)\s*connect-src\b/);
    expect(policy).not.toContain('http:');
    expect(policy).not.toContain('https:');
  });
});
