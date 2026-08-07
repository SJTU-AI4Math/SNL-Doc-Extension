import type React from 'react';

export interface TreeRowCapabilities {
  canIndent: boolean;
  canOutdent: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export function treeRowCapabilities(
  siblingIndex: number,
  siblingCount: number,
  hasParent: boolean
): TreeRowCapabilities {
  return {
    canIndent: siblingIndex > 0,
    canOutdent: hasParent,
    canMoveUp: siblingIndex > 0,
    canMoveDown: siblingIndex + 1 < siblingCount
  };
}

export function treeRowStyle(depth: number): React.CSSProperties {
  return {
    paddingTop: '0.3rem',
    paddingRight: 0,
    paddingBottom: '0.3rem',
    paddingLeft: depth > 0 ? `${depth * 1.5}rem` : 0
  };
}

export function treeDisclosureA11y(
  expanded: boolean,
  controls: string
): { 'aria-expanded': boolean; 'aria-controls': string } {
  return { 'aria-expanded': expanded, 'aria-controls': controls };
}

export const TREE_OUTLINE_TOOLBAR_CSS = `
  .snl-outline-row {
    position: relative;
    overflow: visible;
    transition: padding-right 90ms ease-in, padding-bottom 90ms ease-in;
  }
  .snl-outline-row-toolbar {
    position: absolute;
    z-index: 10;
    top: 50%;
    right: 0.3rem;
    transform: translateY(-50%);
    opacity: 0;
    pointer-events: none;
    transition: opacity 90ms ease-in;
  }
  .snl-outline-row:hover .snl-outline-row-toolbar,
  .snl-outline-row:focus-within .snl-outline-row-toolbar {
    opacity: 1;
    pointer-events: auto;
  }
  .snl-outline-row:hover,
  .snl-outline-row:focus-within {
    padding-right: 8.4rem !important;
  }
  @container snl-outline (max-width: 30rem) {
    .snl-outline-row:hover,
    .snl-outline-row:focus-within {
      padding-right: 0 !important;
      padding-bottom: 4.9rem !important;
    }
    .snl-outline-row-toolbar {
      top: auto;
      right: 0.3rem;
      bottom: 0.2rem;
      transform: none;
    }
  }
  @media (hover: none), (pointer: coarse) {
    .snl-outline-row {
      padding-right: 0 !important;
      padding-bottom: 4.9rem !important;
    }
    .snl-outline-row-toolbar {
      top: auto;
      right: 0.3rem;
      bottom: 0.2rem;
      transform: none;
      opacity: 1;
      pointer-events: auto;
    }
    .snl-outline-row:has(.snl-tree-add-menu) {
      padding-bottom: 6.9rem !important;
    }
    .snl-outline-row:has(.snl-tree-add-menu) .snl-outline-row-toolbar {
      bottom: 2.15rem;
    }
  }
`;

export function shouldStopRowActivation(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function formatDirectionalLabel(
  direction: 'back' | 'forward',
  label: string
): string {
  const trimmed = label.trim();
  if (direction === 'back') {
    return /^[←‹]/u.test(trimmed) ? trimmed : `← ${trimmed}`;
  }
  return /[→›]$/u.test(trimmed) ? trimmed : `${trimmed} →`;
}

export interface ListboxKeyResult {
  index: number;
  activate?: boolean;
  blur?: boolean;
}

export function listboxKeyAction(
  key: string,
  currentIndex: number,
  resultCount: number
): ListboxKeyResult | null {
  if (resultCount <= 0) {
    return key === 'Escape' ? { index: 0, blur: true } : null;
  }
  const index = Math.min(Math.max(currentIndex, 0), resultCount - 1);
  switch (key) {
    case 'ArrowDown':
      return { index: (index + 1) % resultCount };
    case 'ArrowUp':
      return { index: (index - 1 + resultCount) % resultCount };
    case 'Home':
      return { index: 0 };
    case 'End':
      return { index: resultCount - 1 };
    case 'Enter':
      return { index, activate: true };
    case 'Escape':
      return { index, blur: true };
    default:
      return null;
  }
}

export interface SearchQueryShape {
  q: string;
  mode: string;
  filters: { kindId?: string; counterpartId?: string };
}

export function queryKey(query: SearchQueryShape): string {
  return JSON.stringify([
    query.q,
    query.mode,
    query.filters.kindId ?? null,
    query.filters.counterpartId ?? null
  ]);
}

export function matchesPendingQuery(
  pendingKey: string | null,
  query: SearchQueryShape
): boolean {
  return pendingKey !== null && pendingKey === queryKey(query);
}

export interface EntitySearchKeyResult {
  index: number;
  open: boolean;
  blur?: boolean;
}

export function entitySearchKeyAction(
  key: string,
  currentIndex: number,
  resultCount: number,
  open: boolean
): EntitySearchKeyResult | null {
  const safeIndex = resultCount > 0
    ? Math.min(Math.max(currentIndex, 0), resultCount - 1)
    : 0;
  switch (key) {
    case 'ArrowDown':
      if (resultCount === 0) return { index: 0, open: false };
      return {
        index: open ? Math.min(safeIndex + 1, resultCount - 1) : 0,
        open: true
      };
    case 'ArrowUp':
      if (resultCount === 0) return { index: 0, open: false };
      return { index: Math.max(safeIndex - 1, 0), open: true };
    case 'Escape':
      return { index: safeIndex, open: false, blur: true };
    default:
      return null;
  }
}
