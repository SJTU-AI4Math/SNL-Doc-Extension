import React from 'react';
import { Button, type ButtonProps } from './Button';
import { Icon, type IconName } from './Icon';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label'> {
  icon: IconName;
  label: string;
}

/** Compact icon-only action. A label is mandatory because the SVG is decorative. */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ icon, label, title, className, ...props }, ref): React.ReactElement {
    return (
      <Button
        ref={ref}
        aria-label={label}
        title={title ?? label}
        className={['snl-btn--icon', className].filter(Boolean).join(' ')}
        {...props}
      >
        <Icon name={icon} />
      </Button>
    );
  }
);
