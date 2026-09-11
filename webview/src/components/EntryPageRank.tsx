import { createContext, useContext, type ReactElement } from 'react';
import type { GlobalPageRankView } from '../../../src/entryPageRankView';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

/** undefined: not a saved Reader; null: a Reader whose global result is unavailable. */
export const GlobalPageRankContext = createContext<GlobalPageRankView | null | undefined>(undefined);
const MESSAGES = defineUiMessages('entryPageRank', {
  label: 'PageRank · workspace', missing: 'Global result unavailable', unconverged: 'Not converged',
  explanation: 'Dependency centrality over the whole workspace, not mathematical quality or a score recomputed on this view.'
}, {
  label: 'PageRank · 全工作区', missing: '全局结果不可用', unconverged: '尚未收敛',
  explanation: '基于全工作区依赖图的中心性，不代表数学质量，也不是在当前视图内重算的分数。'
});
export function EntryPageRank({ entryId, view: provided }: { entryId: string; view?: GlobalPageRankView | null }): ReactElement | null {
  const inherited = useContext(GlobalPageRankContext);
  const result = provided === undefined ? inherited : provided;
  const t = useUiMessages(MESSAGES);
  if (result === undefined) return null;
  const score = result?.scope === 'workspace' && Object.hasOwn(result.scores, entryId) ? result.scores[entryId] : undefined;
  const valid = typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1;
  const state = !valid ? 'unavailable' : !result?.converged ? 'unconverged' : 'ready';
  return <div className="entry-page-rank" data-state={state} title={t('explanation')}
    style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: '0.85em', opacity: 0.8, marginBlock: 4 }}>
    <span>{t('label')}</span>
    <span>{state === 'ready' ? score!.toPrecision(6) : t(state === 'unconverged' ? 'unconverged' : 'missing')}</span>
  </div>;
}
