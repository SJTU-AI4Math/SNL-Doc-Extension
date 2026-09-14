import React, { useState } from 'react';
import { IconButton } from './IconButton';
import { RowPrimaryButton } from './RowPrimaryButton';

export const CELL: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  borderBottom:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
  textAlign: 'left',
  verticalAlign: 'middle'
};
export const HEAD: React.CSSProperties = { ...CELL, fontWeight: 600, opacity: 0.85 };
export const MONO: React.CSSProperties = {
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  opacity: 0.75
};

/**
 * Trash-icon cell for a Dashboard table row. Placed inside a
 * {@link ClickableRow} — stopPropagation is critical because the surrounding
 * row treats any click as "open this entity", and we absolutely do not want
 * clicking Delete to also open the editor for the doomed row.
 *
 * Cat 2026-07-09: every entity type (entry / library / entry-kind /
 * macro-kind / macro-package) grows a matching Delete action. The confirm
 * modal + reference reporting lives in extension.ts commands; here we just
 * post the intent.
 */
export function RowDeleteCell({
  onDelete,
  label
}: {
  onDelete: () => void;
  label: string;
}): React.ReactElement {
  return (
    <td
      style={{ ...CELL, textAlign: 'right', width: '2.5rem' }}
      onClick={(e) => e.stopPropagation()}
    >
      <IconButton
        icon="delete"
        label={label}
        variant="destructive"
        size="sm"
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        onKeyDown={(e) => {
          // Keep deletion keystrokes local; native button activation emits
          // the click handled above without opening the surrounding row.
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
          }
        }}
      />
    </td>
  );
}

/** Whole-row pointer activation; the primary native button owns Tab/Enter/Space. */
export function ClickableRow({
  label,
  onActivate,
  primaryCellIndex,
  primaryButtonStyle,
  rowId,
  children
}: {
  label: string;
  onActivate: () => void;
  primaryCellIndex: number;
  primaryButtonStyle?: React.CSSProperties;
  rowId?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const cells = React.Children.toArray(children) as React.ReactElement<{
    children?: React.ReactNode;
  }>[];
  const primaryCell = cells[primaryCellIndex];
  if (primaryCell) {
    cells[primaryCellIndex] = React.cloneElement(
      primaryCell,
      {},
      <RowPrimaryButton label={label} onActivate={onActivate} style={primaryButtonStyle}>
        {primaryCell.props.children}
      </RowPrimaryButton>
    );
  }
  return (
    <tr
      data-row-id={rowId}
      onClick={onActivate}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
          : 'transparent'
      }}
    >
      {cells}
    </tr>
  );
}
