import { expect, it } from 'vitest';
import { isEntryDataPayload } from './entryPayloadValidation';
const entry = { id: 'tagged', kind: 'definition', title: '', content: {}, pointer: null };
it('accepts absent and exact string tags at the reader/HTML detail wire boundary', () => {
  expect(isEntryDataPayload(entry)).toBe(true);
  expect(isEntryDataPayload({ ...entry, tags: ['', ' a,b ', '__proto__', '中文', 'a', 'a'] })).toBe(true);
});
it.each([null, 'csv', ['good', false], undefined].map(tags => [tags]))('rejects malformed tags %j at the reader boundary', tags => {
  expect(isEntryDataPayload({ ...entry, tags })).toBe(false);
});
