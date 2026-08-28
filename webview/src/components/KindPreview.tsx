import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { ThemedKindColoring } from '../../../src/kindColoring';
import { get_kind_color_scheme, use_preferences_revision } from '../runtime/preferencesRuntime';
export interface KindPreviewProps {
  coloring: ThemedKindColoring;
  name?: ReactNode;
  kindId?: string;
  onEditKind?: (id: string) => void;
  width?: CSSProperties['width'];
  className?: string;
  title?: string;
  style?: CSSProperties;
  compact?: boolean;
  allowOrdinaryClickThrough?: boolean;
}

/**
 * One visual and interaction primitive for Entry and Macro Kind surfaces.
 * Navigation is deliberately Ctrl-click-only; an ordinary click is contained
 * so a surrounding row or selector cannot perform a second action.
 */
export function KindPreview({
  coloring,
  name,
  kindId,
  onEditKind,
  width,
  className,
  title,
  style,
  compact = false,
  allowOrdinaryClickThrough = false
}: KindPreviewProps) {
  use_preferences_revision();
  const [hovered, setHovered] = useState(false);
  const [ctrlDown, setCtrlDown] = useState(false);
  const scheme = get_kind_color_scheme();
  const dark = scheme === 'dark';
  const colors = coloring[scheme];
  const navigable = typeof kindId === 'string' && kindId.length > 0 && !!onEditKind;

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Control') setCtrlDown(true);
    };
    const keyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Control' || !event.ctrlKey) setCtrlDown(false);
    };
    const blur = (): void => setCtrlDown(false);
    document.addEventListener('keydown', keyDown);
    document.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('keydown', keyDown);
      document.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const hoverBackground = ctrlDown
    ? (dark ? '#374151' : '#f3f4f6')
    : (dark ? '#1f2937' : '#fff');
  const handleClick = (event: MouseEvent<HTMLSpanElement>): void => {
    if (!navigable) return;
    if (event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      onEditKind(kindId);
    } else if (!allowOrdinaryClickThrough) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <span
      data-testid="kind-preview"
      data-kind-preview="true"
      data-kind-id={kindId}
      className={className}
      title={title}
      onMouseEnter={(event) => {
        setHovered(true);
        setCtrlDown(event.ctrlKey);
      }}
      onMouseLeave={() => setHovered(false)}
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: compact ? 0 : '0.4rem',
        boxSizing: 'border-box',
        width,
        minHeight: compact ? '1rem' : '1.25rem',
        padding: compact ? 0 : '0.1rem 0.45rem',
        borderRadius: '3px',
        border: `${compact ? 1 : 2}px solid ${colors.stroke}`,
        color: colors.stroke,
        backgroundColor: hovered ? hoverBackground : colors.background,
        boxShadow: hovered ? `inset 0 0 0 5px ${colors.stroke}` : 'none',
        cursor: hovered && ctrlDown && navigable ? 'pointer' : 'default',
        transition: 'background-color 150ms, box-shadow 150ms',
        verticalAlign: 'middle',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...style
      }}
    >
      {name}
    </span>
  );
}
