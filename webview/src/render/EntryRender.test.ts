import { describe, expect, it } from 'vitest';
import { entryContextRevision, type EntryData, type EntryOption } from './EntryRender';

const entry = (title: string, snl = 'x@ctx'): EntryData => ({
  id: 'e',
  kind: 'definition',
  title,
  content: { snl },
  contribution_info: null,
  pointer: null
});

const pool = (title: string, snl = '@x'): EntryOption[] => [
  { id: 'ctx', title, hasContent: true, snl }
];

describe('Entry context-driver revision', () => {
  it('ignores presentation-only changes but changes with context SNL', () => {
    expect(entryContextRevision(entry('A'), pool('Context A'))).toBe(
      entryContextRevision(entry('B'), pool('Context B'))
    );
    expect(entryContextRevision(entry('A'), pool('Context'),)).not.toBe(
      entryContextRevision(entry('A', 'y@ctx'), pool('Context'))
    );
    expect(entryContextRevision(entry('A'), pool('Context', '@x'))).not.toBe(
      entryContextRevision(entry('A'), pool('Context', '@y'))
    );
  });
});
