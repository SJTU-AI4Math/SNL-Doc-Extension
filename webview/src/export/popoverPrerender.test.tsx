import { describe, expect, it } from 'vitest';
import { fallbackFragment } from './popoverPrerender';

describe('popover pre-render fallback', () => {
  it('escapes the Entry id as an attribute and the title as text', () => {
    const html = fallbackFragment('x" onmouseover="boom', '<unsafe>');
    expect(html).toContain('data-entry-id="x&quot; onmouseover=&quot;boom"');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('onmouseover="boom"');
    expect(html).not.toContain('<unsafe>');
  });
});
