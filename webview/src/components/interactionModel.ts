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
    padding: depth > 0 ? `0.3rem 0 0.3rem ${depth * 1.5}rem` : '0.3rem 0'
  };
}

export function treeDisclosureA11y(
  expanded: boolean,
  controls: string
): { 'aria-expanded': boolean; 'aria-controls': string } {
  return { 'aria-expanded': expanded, 'aria-controls': controls };
}

export const TREE_OUTLINE_TOOLBAR_CSS = `
  .snl-outline-row-toolbar {
    opacity: 0;
    pointer-events: none;
    transition: opacity 90ms ease-in;
  }
  .snl-outline-row:hover .snl-outline-row-toolbar,
  .snl-outline-row:focus-within .snl-outline-row-toolbar {
    opacity: 1;
    pointer-events: auto;
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
  filters: { kindId?: string };
}

export function queryKey(query: SearchQueryShape): string {
  return JSON.stringify([query.q, query.mode, query.filters.kindId ?? null]);
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
