import { expect, it } from 'vitest';
import { isGlobalPageRankView, projectPageRank } from './entryPageRankView';
it('projects frozen global values without renormalizing the export closure', () => {
  const full = { scope: 'workspace' as const, converged: true, iterations: 8, scores: { Alpha: 0.125, Private: 0.875 } };
  const projected = projectPageRank(full, ['Alpha', 'missing']);
  expect(projected).toEqual({ scope: 'workspace', converged: true, iterations: 8, scores: { Alpha: 0.125 } });
  expect(isGlobalPageRankView(projected)).toBe(true);
  expect(JSON.stringify(projected)).not.toContain('Private');
  expect(full.scores.Private).toBe(0.875);
});
it('rejects malformed or locally recomputed metrics masquerading as global data', () => {
  for (const value of [null, [], { scope:'library',scores:{x:1},converged:true,iterations:1 },
    {scope:'workspace',scores:{x:NaN},converged:true,iterations:1},
    {scope:'workspace',scores:{x:1},converged:true,iterations:-1},
    {scope:'workspace',scores:{x:2},converged:true,iterations:1}]) expect(isGlobalPageRankView(value)).toBe(false);
});
it('keeps own prototype-like identities without admitting inherited values', () => {
  const scores = JSON.parse('{"__proto__":0.25,"constructor":0.75}');
  const selected = projectPageRank({scope:'workspace',scores,converged:true,iterations:1},['__proto__','constructor','toString']);
  expect(Object.keys(selected.scores)).toEqual(['__proto__','constructor']);
  expect(Object.getPrototypeOf(selected.scores)).toBe(Object.prototype);
});
