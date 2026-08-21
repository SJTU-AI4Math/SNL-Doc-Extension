import { describe, expect, it } from 'vitest';
import {
  assertTableRendererTransport,
  BLOCK_RENDERER_SPEC_PREFIX,
  parseBlockRendererSpec,
  serializeBlockRendererSpec,
  serializeTableRendererSpec,
} from './blockRendererSpec';

describe('parameterized block renderer specs', () => {
  it('round-trips a canonical, versioned enumerate spec', () => {
    const encoded = serializeBlockRendererSpec('enumerate', { marker: 'lower-alpha' });
    expect(encoded).toBe('snl-ext-preset:v1:enumerate?marker=lower-alpha');
    expect(parseBlockRendererSpec(encoded)).toEqual({
      name: 'enumerate', params: { marker: 'lower-alpha' }
    });
  });

  it('round-trips the 0.2 compatibility transport for table options', () => {
    const params = {
      composition: 'cells',
      'light-color': '#112233',
      'light-background': '#f1f2f3',
      'light-border': '#a1a2a3',
      'dark-color': '#ddeeff',
      'dark-background': '#101820',
      'dark-border': '#778899'
    };
    const encoded = serializeBlockRendererSpec('table', params);
    expect(encoded).toContain('snl-ext-preset:v1:table?composition=cells');
    expect(parseBlockRendererSpec(encoded)).toEqual({ name: 'table', params });
  });

  it('normalizes image asset paths and preserves accessible alt text', () => {
    const encoded = serializeBlockRendererSpec('image', {
      src: './.SNL_Doc/assets/figures/plot one.png',
      layout: 'inline',
      alt: 'Plot one'
    });
    expect(encoded).toBe(
      'snl-ext-preset:v1:image?src=figures%2Fplot%20one.png&layout=inline&alt=Plot%20one'
    );
    expect(parseBlockRendererSpec(encoded)).toEqual({
      name: 'image',
      params: { src: 'figures/plot one.png', layout: 'inline', alt: 'Plot one' }
    });
  });

  it('keeps legacy non-parameterized renderer keys compatible', () => {
    expect(parseBlockRendererSpec('table')).toEqual({ name: 'table', params: {} });
  });

  it('rejects malformed, unknown, and traversal-bearing protocol keys', () => {
    expect(() => parseBlockRendererSpec(
      'snl-ext-preset:v1:image?src=..%2Fsecret.png&layout=block&alt=secret'
    )).toThrow(/relative/i);
    expect(() => parseBlockRendererSpec(
      'snl-ext-preset:v1:image?src=%252e%252e%2Fsecret.png&layout=block&alt=secret'
    )).toThrow(/relative/i);
    expect(() => parseBlockRendererSpec(
      'snl-ext-preset:v1:image?src=dir%5Cfile.png&layout=block&alt=x'
    )).toThrow(/relative/i);
    expect(() => serializeBlockRendererSpec('image', {
      src: 'figure#draft.png', layout: 'block', alt: 'draft'
    })).toThrow(/relative/i);
    expect(() => parseBlockRendererSpec(
      'snl-ext-preset:v1:enumerate?marker=decimal&marker=disc'
    )).toThrow(/duplicate/i);
    expect(() => parseBlockRendererSpec(
      'snl-ext-preset:v1:enumerate?marker=decimal&surprise=1'
    )).toThrow(/unknown/i);
    expect(() => parseBlockRendererSpec('snl-ext-preset:v2:enumerate?marker=decimal'))
      .toThrow(/version/i);
  });

  it('round-trips a table with omitted CSS without undefined parameters', () => {
    const key = serializeTableRendererSpec({ composition: 'rows' })
    expect(key).toBe(`${BLOCK_RENDERER_SPEC_PREFIX}table?composition=rows`)
    const projection = {
      mode: 'block', body: '#*', block_template_name: key,
      table: { composition: 'rows' },
    }
    expect(() => assertTableRendererTransport(projection, 'template')).not.toThrow()
  })

});
