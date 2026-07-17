import { describe, expect, it } from 'vitest';
import { kindEditorDescriptor } from './KindEditorApp';

describe('kindEditorDescriptor', () => {
  it('describes entry-only and macro-only fields without duplicating the editor', () => {
    expect(kindEditorDescriptor('entry').extraFields).toEqual(['defaultCounterName', 'style']);
    expect(kindEditorDescriptor('macro').extraFields).toEqual(['description']);
  });
});
