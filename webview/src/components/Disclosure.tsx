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
  ...buttonProps
}: DisclosureProps): React.ReactElement {
  return (
    <Button
      {...buttonProps}
      variant="ghost"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {children}
    </Button>
  );
}
