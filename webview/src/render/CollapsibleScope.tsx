import React from 'react';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'collapsibleScope',
  {
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    expandAllIn: 'Expand all collapsible blocks in {scope}',
    collapseAllIn: 'Collapse all collapsible blocks in {scope}',
    defaultScope: 'rendered content'
  },
  {
    expandAll: '全部展开',
    collapseAll: '全部收起',
    expandAllIn: '展开{scope}中的所有可折叠块',
    collapseAllIn: '收起{scope}中的所有可折叠块',
    defaultScope: '渲染内容'
  }
);

interface CollapsibleRecord {
  depth: number;
  collapsed: boolean;
}

class CollapsibleStore {
  private readonly records = new Map<string, CollapsibleRecord>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): number => this.revision;

  register(id: string, depth: number, initiallyCollapsed: boolean): void {
    const current = this.records.get(id);
    if (current && current.depth === depth) return;
    this.records.set(id, { depth, collapsed: current?.collapsed ?? initiallyCollapsed });
    this.changed();
  }

  unregister(id: string): void {
    if (!this.records.delete(id)) return;
    this.changed();
  }

  collapsed(id: string, fallback: boolean): boolean {
    return this.records.get(id)?.collapsed ?? fallback;
  }

  toggle(id: string, atSameDepth: boolean): void {
    const target = this.records.get(id);
    if (!target) return;
    const next = !target.collapsed;
    if (atSameDepth) {
      for (const record of this.records.values()) {
        if (record.depth === target.depth) record.collapsed = next;
      }
    } else {
      target.collapsed = next;
    }
    this.changed();
  }

  setAll(collapsed: boolean): void {
    let didChange = false;
    for (const record of this.records.values()) {
      if (record.collapsed === collapsed) continue;
      record.collapsed = collapsed;
      didChange = true;
    }
    if (didChange) this.changed();
  }

  capabilities(): { count: number; canExpand: boolean; canCollapse: boolean } {
    let canExpand = false;
    let canCollapse = false;
    for (const record of this.records.values()) {
      if (record.collapsed) canExpand = true;
      else canCollapse = true;
    }
    return { count: this.records.size, canExpand, canCollapse };
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

interface ScopeContextValue {
  store: CollapsibleStore;
  depth: number;
}

const ScopeContext = React.createContext<ScopeContextValue | null>(null);

export interface CollapsibleScopeProps {
  children: React.ReactNode;
  /** Immutable identity of the containing render target. */
  resetKey?: React.Key;
  /** Human-readable context used by bulk-control accessible names. */
  label?: string;
  className?: string;
}

function ScopeContents({
  children,
  label,
  store,
  className
}: Omit<CollapsibleScopeProps, 'resetKey'> & { store: CollapsibleStore }): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  React.useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const { count, canExpand, canCollapse } = store.capabilities();
  const contextualLabel = label || t('defaultScope');

  return (
    <div
      className={['snl-collapsible-scope', className].filter(Boolean).join(' ')}
      data-snl-collapsible-scope-label={contextualLabel}
    >
      {count > 0 ? <div
        className="snl-collapsible-scope__controls"
        data-snl-collapsible-controls=""
        data-snl-collapsible-count={count}
      >
        <button
          type="button"
          className="snl-btn snl-btn--sm snl-btn--secondary"
          aria-label={t('expandAllIn', { scope: contextualLabel })}
          disabled={!canExpand}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            store.setAll(false);
          }}
        >
          {t('expandAll')}
        </button>
        <button
          type="button"
          className="snl-btn snl-btn--sm snl-btn--secondary"
          aria-label={t('collapseAllIn', { scope: contextualLabel })}
          disabled={!canCollapse}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            store.setAll(true);
          }}
        >
          {t('collapseAll')}
        </button>
      </div> : null}
      {children}
    </div>
  );
}

/**
 * One transient authored-Collapsible state domain. A nested provider reuses
 * its ancestor so recursive Entry/popover composition cannot duplicate chrome
 * or split same-depth operations into accidental sub-scopes.
 */
export function CollapsibleScope({
  children,
  resetKey = 'default',
  label,
  className
}: CollapsibleScopeProps): React.ReactElement {
  const parent = React.useContext(ScopeContext);
  const store = React.useMemo(() => new CollapsibleStore(), [resetKey]);
  const context = React.useMemo<ScopeContextValue>(() => ({ store, depth: 0 }), [store]);
  if (parent) return <>{children}</>;
  return (
    <ScopeContext.Provider value={context}>
      <ScopeContents store={store} label={label} className={className}>
        {children}
      </ScopeContents>
    </ScopeContext.Provider>
  );
}

export interface CollapsibleController {
  collapsed: boolean;
  bodyId: string;
  depth: number;
  toggle(event?: { ctrlKey?: boolean }): void;
  nest(children: React.ReactNode): React.ReactElement;
}

/** State/depth bridge used only by the authored Collapsible renderer. */
export function useCollapsibleController(
  initiallyCollapsed: boolean,
  enabled = true
): CollapsibleController {
  const context = React.useContext(ScopeContext);
  const reactId = React.useId();
  const id = `snl-collapsible-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const bodyId = `${id}-body`;
  const latestInitial = React.useRef(initiallyCollapsed);
  latestInitial.current = initiallyCollapsed;
  const [standaloneCollapsed, setStandaloneCollapsed] = React.useState(initiallyCollapsed);
  const store = context?.store;
  const depth = context?.depth ?? 0;

  React.useLayoutEffect(() => {
    if (!store || !enabled) return;
    store.register(id, depth, latestInitial.current);
    return () => store.unregister(id);
  }, [depth, enabled, id, store]);

  React.useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.snapshot ?? (() => 0),
    store?.snapshot ?? (() => 0)
  );

  const collapsed = store
    ? store.collapsed(id, initiallyCollapsed)
    : standaloneCollapsed;
  const childContext = React.useMemo<ScopeContextValue | null>(
    () => context ? { store: context.store, depth: depth + 1 } : null,
    [context, depth]
  );

  return {
    collapsed,
    bodyId,
    depth,
    toggle: (event) => {
      if (store) store.toggle(id, event?.ctrlKey === true);
      else setStandaloneCollapsed((current) => !current);
    },
    nest: (children) => childContext
      ? <ScopeContext.Provider value={childContext}>{children}</ScopeContext.Provider>
      : <>{children}</>
  };
}
