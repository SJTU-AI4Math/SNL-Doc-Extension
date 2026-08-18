import React from 'react';
import { Button } from './Button';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

const MESSAGES = defineUiMessages('structuralTreeControls', {
  expandAll: 'Expand all',
  collapseAll: 'Collapse all'
}, {
  expandAll: '全部展开',
  collapseAll: '全部折叠'
});

export function StructuralTreeControls({
  canExpand,
  canCollapse,
  onExpandAll,
  onCollapseAll
}: {
  canExpand: boolean;
  canCollapse: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  return (
    <div
      className="snl-structural-tree-controls"
      style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.35rem', marginBottom: '0.4rem' }}
    >
      <Button type="button" variant="secondary" size="sm" disabled={!canExpand} onClick={onExpandAll}>
        {t('expandAll')}
      </Button>
      <Button type="button" variant="secondary" size="sm" disabled={!canCollapse} onClick={onCollapseAll}>
        {t('collapseAll')}
      </Button>
    </div>
  );
}
