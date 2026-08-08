import { describe, expect, it } from 'vitest';
import { kindEditorDescriptor, normalizeEditorColoring } from './KindEditorApp';

describe('kindEditorDescriptor', () => {
  it('describes entry-only and macro-only fields without duplicating the editor', () => {
    expect(kindEditorDescriptor('entry').extraFields).toEqual(['defaultCounterName', 'style']);
    expect(kindEditorDescriptor('macro').extraFields).toEqual(['description']);
  });
  it('loads nested theme colors and duplicates legacy flat colors', () => {
    expect(normalizeEditorColoring({ light: { stroke: '#1', background: '#2' }, dark: { stroke: '#3', background: '#4' } })).toEqual({ lightStroke: '#1', lightBackground: '#2', darkStroke: '#3', darkBackground: '#4' });
    expect(normalizeEditorColoring({ stroke: '#5', background: '#6' })).toEqual({ lightStroke: '#5', lightBackground: '#6', darkStroke: '#5', darkBackground: '#6' });
  });
});
