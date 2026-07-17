import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ColorField, KindTextField, sanitizeForColorInput } from './KindFormFields';

describe('shared kind form fields', () => {
  it('normalizes unsupported color values for the native picker', () => {
    expect(sanitizeForColorInput('#12aBcF')).toBe('#12aBcF');
    expect(sanitizeForColorInput('red')).toBe('#888888');
  });

  it('uses shared form controls for text and color fields', () => {
    const text = renderToStaticMarkup(<KindTextField label="ID" value="x" onChange={() => {}} mono />);
    const color = renderToStaticMarkup(<ColorField label="Stroke" value="#123456" onChange={() => {}} />);
    expect(text).toContain('snl-control');
    expect(color).toContain('type="color"');
    expect(color).toContain('snl-control');
  });
});
