import React from 'react';
import { Button, type ButtonProps } from './Button';

export interface DisclosureProps extends Omit<ButtonProps, 'children' | 'onClick' | 'variant'> {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  children: React.ReactNode;
}

export function Disclosure({
  expanded,
  controls,
  onToggle,
  children,
  style,
  ...buttonProps
}: DisclosureProps): React.ReactElement {
  return (
    <Button
      {...buttonProps}
      variant="ghost"
      style={{ justifyContent: 'flex-start', textAlign: 'left', ...style }}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {children}
    </Button>
  );
}
