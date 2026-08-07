import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
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
    chooseAddPosition: 'Choose add position', addNodePosition: 'Add node position',
    addParent: 'Add parent node', addChild: 'Add child node', addSibling: 'Add sibling node',
    deleteSubtree: 'Delete subtree'
  },
  {
    moveUp: '上移', moveUpUnavailable: '无法上移',
    moveDown: '下移', moveDownUnavailable: '无法下移',
    outdent: '减少缩进', outdentUnavailable: '无法减少缩进',
    indent: '增加缩进', indentUnavailable: '无法增加缩进',
    chooseAddPosition: '选择添加位置', addNodePosition: '添加节点位置',
    addParent: '添加父节点', addChild: '添加子节点', addSibling: '添加同级节点',
    deleteSubtree: '删除子树'
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

/** Semantic command emitted by pointer or keyboard activation of the dial. */
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
  /** Domain-specific actions, such as opening the Macro editor. */
  leadingActions?: React.ReactNode;
  className?: string;
}

export function TreeNodeActionDashboard({
  capabilities,
  onAction,
  leadingActions,
  className
}: TreeNodeActionDashboardProps): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [activeAddAction, setActiveAddAction] = useState<
    'addParent' | 'addChild' | 'addSibling'
  >('addParent');
  const addControlRef = useRef<HTMLDivElement>(null);
  const addMenuId = React.useId();

  useEffect(() => {
    if (!addMenuOpen) return;
    addControlRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"][tabindex="0"]:not(:disabled)')
      ?.focus();
    const closeOutside = (event: MouseEvent): void => {
      if (!addControlRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [addMenuOpen]);

  const dispatchAdd = (
    action: 'addParent' | 'addChild' | 'addSibling'
  ): void => {
    setAddMenuOpen(false);
    onAction({ kind: action });
    window.requestAnimationFrame(() => {
      addControlRef.current
        ?.querySelector<HTMLButtonElement>('[data-snl-add-position-trigger]')
        ?.focus();
    });
  };

  const menuCapabilities = [
    ['addParent', capabilities.canAddParent, t('addParent')],
    ['addChild', capabilities.canAddChild, t('addChild')],
    ['addSibling', capabilities.canAddSibling, t('addSibling')]
  ] as const;
  const canAddAnywhere = menuCapabilities.some(([, enabled]) => enabled);
  const toggleAddMenu = (): void => {
    if (!addMenuOpen) {
      const firstEnabled = menuCapabilities.find(([, enabled]) => enabled);
      if (firstEnabled) setActiveAddAction(firstEnabled[0]);
    }
    setAddMenuOpen((open: boolean) => !open);
  };
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
      <div ref={addControlRef} className="snl-tree-operation-dial">
        <IconButton
          icon="move-up"
          label={t('moveUp')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--up"
          onClick={(event: React.MouseEvent<HTMLButtonElement>) => dispatchDirectional('moveUp', event)}
          disabled={!capabilities.canMoveUp}
          title={capabilities.canMoveUp ? t('moveUp') : t('moveUpUnavailable')}
        />
        <IconButton
          icon="outdent"
          label={t('outdent')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--outdent"
          onClick={(event: React.MouseEvent<HTMLButtonElement>) => dispatchDirectional('outdent', event)}
          disabled={!capabilities.canOutdent}
          title={capabilities.canOutdent ? t('outdent') : t('outdentUnavailable')}
        />
        <IconButton
          icon="add"
          label={t('chooseAddPosition')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--add"
          onClick={toggleAddMenu}
          disabled={!canAddAnywhere}
          title={t('chooseAddPosition')}
          data-snl-add-position-trigger
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
          aria-controls={addMenuOpen ? addMenuId : undefined}
        />
        <IconButton
          icon="indent"
          label={t('indent')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--indent"
          onClick={(event: React.MouseEvent<HTMLButtonElement>) => dispatchDirectional('indent', event)}
          disabled={!capabilities.canIndent}
          title={capabilities.canIndent ? t('indent') : t('indentUnavailable')}
        />
        <IconButton
          icon="move-down"
          label={t('moveDown')}
          variant="ghost"
          size="sm"
          className="snl-tree-dial-action snl-tree-dial-action--down"
          onClick={(event: React.MouseEvent<HTMLButtonElement>) => dispatchDirectional('moveDown', event)}
          disabled={!capabilities.canMoveDown}
          title={capabilities.canMoveDown ? t('moveDown') : t('moveDownUnavailable')}
        />
        {addMenuOpen ? (
          <div
            id={addMenuId}
            role="menu"
            aria-label={t('addNodePosition')}
            className="snl-tree-add-menu"
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (!next || !addControlRef.current?.contains(next)) setAddMenuOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setAddMenuOpen(false);
                addControlRef.current
                  ?.querySelector<HTMLButtonElement>('[data-snl-add-position-trigger]')
                  ?.focus();
                return;
              }
              if (event.key === 'Tab') {
                // Preserve native forward/reverse traversal, but prevent a
                // keyboard-owning tree from reinterpreting the same key.
                event.stopPropagation();
                window.requestAnimationFrame(() => setAddMenuOpen(false));
                return;
              }
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
              );
              if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                event.stopPropagation();
                const item = items[event.key === 'Home' ? 0 : items.length - 1] as
                  | HTMLButtonElement
                  | undefined;
                if (item) {
                  setActiveAddAction(item.dataset.snlAddAction as typeof activeAddAction);
                  item.focus();
                }
                return;
              }
              if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
              const item = items[(current + step + items.length) % items.length] as
                | HTMLButtonElement
                | undefined;
              if (item) {
                setActiveAddAction(item.dataset.snlAddAction as typeof activeAddAction);
                item.focus();
              }
            }}
          >
            {menuCapabilities.map(([action, enabled, label]) => (
              <Button
                key={action}
                role="menuitem"
                variant="secondary"
                size="sm"
                aria-label={label}
                disabled={!enabled}
                tabIndex={enabled && action === activeAddAction ? 0 : -1}
                data-snl-add-action={action}
                onFocus={() => setActiveAddAction(action)}
                onClick={() => dispatchAdd(action)}
                title={label}
              >
                {label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {capabilities.canDelete ? (
        <IconButton
          icon="delete"
          label={t('deleteSubtree')}
          variant="destructive"
          size="sm"
          className="snl-tree-compact-action snl-tree-delete-action"
          onClick={() => onAction({ kind: 'delete' })}
          title={t('deleteSubtree')}
        />
      ) : null}
    </div>
  );
}
