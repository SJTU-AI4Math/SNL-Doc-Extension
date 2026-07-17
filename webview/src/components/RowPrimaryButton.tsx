import React from 'react';
import { Button } from './Button';

export const ROW_PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  appearance: 'none',
  display: 'block',
  width: '100%',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'inherit',
  cursor: 'pointer'
};

export function RowPrimaryButton({
  label,
  onActivate,
  children,
  style
}: {
  label: string;
  onActivate: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <Button
      variant="ghost"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
      style={{ ...ROW_PRIMARY_BUTTON_STYLE, ...style }}
    >
      {children}
    </Button>
  );
}
