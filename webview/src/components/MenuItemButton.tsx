import React from 'react';
import { Button, type ButtonProps } from './Button';

export interface MenuItemButtonProps extends Omit<ButtonProps, 'variant' | 'size'> {
  danger?: boolean;
}

export const MenuItemButton = React.forwardRef<HTMLButtonElement, MenuItemButtonProps>(
  function MenuItemButton({ danger = false, className, children, ...props }, ref): React.ReactElement {
    return (
      <Button
        ref={ref}
        role="menuitem"
        variant="ghost"
        size="sm"
        className={['snl-menu-item', className].filter(Boolean).join(' ')}
        data-danger={danger || undefined}
        {...props}
      >
        {children}
      </Button>
    );
  }
);
