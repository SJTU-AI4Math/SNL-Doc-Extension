import React from 'react';
import { IconButton } from './IconButton';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import './TreeNodeActionDashboard.css';

const MESSAGES = defineUiMessages(
  'treeNodeActions',
  {
    moveUp: 'Move up', moveUpUnavailable: 'Move up unavailable',
    moveDown: 'Move down', moveDownUnavailable: 'Move down unavailable',
    outdent: 'Outdent', outdentUnavailable: 'Outdent unavailable',
    indent: 'Indent', indentUnavailable: 'Indent unavailable',
    addParent: 'Add parent node', addChild: 'Add child node', addSibling: 'Add sibling node',
    deleteSubtree: 'Delete subtree', deleteUnavailable: 'Delete unavailable'
  },
  {
    moveUp: '上移', moveUpUnavailable: '无法上移',
    moveDown: '下移', moveDownUnavailable: '无法下移',
    outdent: '减少缩进', outdentUnavailable: '无法减少缩进',
    indent: '增加缩进', indentUnavailable: '无法增加缩进',
    addParent: '添加父节点', addChild: '添加子节点', addSibling: '添加同级节点',
    deleteSubtree: '删除子树', deleteUnavailable: '无法删除'
  }
);

export type TreeNodeAction =
  | 'moveUp'
  | 'outdent'
  | 'addParent'
  | 'addChild'
  | 'addSibling'
  | 'indent'
  | 'moveDown'
  | 'delete';

export type TreeDirectionalAction = 'moveUp' | 'moveDown' | 'indent' | 'outdent';

/** Semantic command emitted by pointer or keyboard activation of the grid. */
export type TreeNodeActionCommand =
  | { kind: TreeDirectionalAction; toEdge: boolean }
  | { kind: Exclude<TreeNodeAction, TreeDirectionalAction> };

/** Reserved shared command shape for a future drag-and-drop input adapter. */
export interface TreeDropCommand {
  kind: 'drop';
  sourceId: string;
  targetId: string;
  placement: 'before' | 'inside' | 'after';
}

export type TreeStructuralCommand = TreeNodeActionCommand | TreeDropCommand;

export interface TreeNodeActionCapabilities {
  canMoveUp: boolean;
  canMoveDown: boolean;
  canIndent: boolean;
  canOutdent: boolean;
  canAddParent: boolean;
  canAddChild: boolean;
  canAddSibling: boolean;
  canDelete: boolean;
}

export interface TreeNodeActionDashboardProps {
  capabilities: TreeNodeActionCapabilities;
  onAction: (command: TreeNodeActionCommand) => void;
  /** Domain content outside the fixed grid, such as a persistent metric. */
  leadingActions?: React.ReactNode;
  /** Domain action occupying the bottom-left grid cell, such as Macro edit/create. */
  bottomLeftAction?: React.ReactNode;
  className?: string;
}

export function TreeNodeActionDashboard({
  capabilities,
  onAction,
  leadingActions,
  bottomLeftAction,
  className
}: TreeNodeActionDashboardProps): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const dispatchDirectional = (
    kind: TreeDirectionalAction,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    onAction({ kind, toEdge: event.ctrlKey || event.metaKey });
  };

  return (
    <div
      className={['snl-tree-operation-cluster', className].filter(Boolean).join(' ')}
      data-snl-shared-tree-dashboard
    >
      {leadingActions}
      <div className="snl-tree-operation-dial">
        <IconButton
          icon="add-parent"
          label={t('addParent')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--add-parent"
          data-snl-tree-action="addParent"
          onClick={() => onAction({ kind: 'addParent' })}
          disabled={!capabilities.canAddParent}
        />
        <IconButton
          icon="move-up"
          label={t('moveUp')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--up"
          onClick={(event) => dispatchDirectional('moveUp', event)}
          disabled={!capabilities.canMoveUp}
          title={capabilities.canMoveUp ? t('moveUp') : t('moveUpUnavailable')}
        />
        <IconButton
          icon="delete"
          label={t('deleteSubtree')}
          variant="destructive"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--delete snl-tree-delete-action"
          onClick={() => onAction({ kind: 'delete' })}
          disabled={!capabilities.canDelete}
          title={capabilities.canDelete ? t('deleteSubtree') : t('deleteUnavailable')}
        />
        <IconButton
          icon="outdent"
          label={t('outdent')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--outdent"
          onClick={(event) => dispatchDirectional('outdent', event)}
          disabled={!capabilities.canOutdent}
          title={capabilities.canOutdent ? t('outdent') : t('outdentUnavailable')}
        />
        <IconButton
          icon="add-sibling"
          label={t('addSibling')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--add-sibling"
          data-snl-tree-action="addSibling"
          onClick={() => onAction({ kind: 'addSibling' })}
          disabled={!capabilities.canAddSibling}
        />
        <IconButton
          icon="indent"
          label={t('indent')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--indent"
          onClick={(event) => dispatchDirectional('indent', event)}
          disabled={!capabilities.canIndent}
          title={capabilities.canIndent ? t('indent') : t('indentUnavailable')}
        />
        <span
          className="snl-tree-dial-action-slot snl-tree-dial-action--domain"
          data-snl-dashboard-bottom-left
        >
          {bottomLeftAction}
        </span>
        <IconButton
          icon="move-down"
          label={t('moveDown')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--down"
          onClick={(event) => dispatchDirectional('moveDown', event)}
          disabled={!capabilities.canMoveDown}
          title={capabilities.canMoveDown ? t('moveDown') : t('moveDownUnavailable')}
        />
        <IconButton
          icon="add-child"
          label={t('addChild')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--add-child"
          data-snl-tree-action="addChild"
          onClick={() => onAction({ kind: 'addChild' })}
          disabled={!capabilities.canAddChild}
        />
      </div>
    </div>
  );
}
