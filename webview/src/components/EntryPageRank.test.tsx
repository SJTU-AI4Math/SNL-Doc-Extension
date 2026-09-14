import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EntryPageRank, GlobalPageRankContext } from './EntryPageRank';
import { projectPageRank } from '../../../src/entryPageRankView';
afterEach(cleanup);
it('shows an explicitly global value and never reads an inherited score', () => {
  const view = { scope: 'workspace' as const, scores: { A: 0.125 }, converged: true, iterations: 5 };
  const r = render(<GlobalPageRankContext.Provider value={view}><EntryPageRank entryId="A" /></GlobalPageRankContext.Provider>);
  expect(screen.getByText('PageRank · workspace')).toBeTruthy();
  expect(screen.getByText('0.125000')).toBeTruthy();
  r.rerender(<GlobalPageRankContext.Provider value={view}><EntryPageRank entryId="constructor" /></GlobalPageRankContext.Provider>);
  expect(screen.getByText('Global result unavailable')).toBeTruthy();
});
it('does not silently turn missing or unconverged data into a score', () => {
  const r = render(<GlobalPageRankContext.Provider value={null}><EntryPageRank entryId="A" /></GlobalPageRankContext.Provider>);
  expect(screen.getByText('Global result unavailable')).toBeTruthy();
  r.rerender(<GlobalPageRankContext.Provider value={{scope:'workspace',scores:{A:0.5},converged:false,iterations:500}}><EntryPageRank entryId="A" /></GlobalPageRankContext.Provider>);
  expect(screen.getByText('Not converged')).toBeTruthy();
  expect(screen.queryByText('0.500000')).toBeNull();
});
it('stays absent outside a saved Reader context', () => {
  const r = render(<EntryPageRank entryId="A" />); expect(r.container.textContent).toBe('');
});
it('projects export identities without recomputing a local PageRank', () => {
  const view = {scope:'workspace' as const,scores:Object.fromEntries([['A',0.125],['private',0.75],['__proto__',0.125]]),converged:true,iterations:6};
  const p = projectPageRank(view,['A','__proto__']);
  expect(Object.keys(p.scores)).toEqual(['A','__proto__']); expect(p.scores.A).toBe(view.scores.A);
  expect(Object.hasOwn(p.scores,'__proto__')).toBe(true); expect(p.iterations).toBe(6);
  expect(Object.hasOwn(view.scores,'private')).toBe(true);
});
