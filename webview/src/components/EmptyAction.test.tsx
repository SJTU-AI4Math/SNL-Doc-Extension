import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyAction } from './EmptyAction';

describe('EmptyAction', () => {
  it('is a native shared button instead of a div with hand-written keyboard handlers', () => {
    const html = renderToStaticMarkup(<EmptyAction label="Add item" onClick={() => {}} />);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('snl-btn');
    expect(html).toContain('snl-empty-action');
  });
});
