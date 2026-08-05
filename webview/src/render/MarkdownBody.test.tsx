import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownBody } from './MarkdownBody';

describe('MarkdownBody fenced code contrast', () => {
  it('puts dark foreground styles on fenced code before effects run', () => {
    const html = renderToStaticMarkup(
      <MarkdownBody source={'```ts\nconst answer = 42;\n```'} />
    );

    expect(html).toContain('<pre style="color:#24292f;background:#f6f8fa">');
    expect(html).toContain(
      '<code class="language-ts" style="color:#24292f">const answer = 42;'
    );
  });
});
