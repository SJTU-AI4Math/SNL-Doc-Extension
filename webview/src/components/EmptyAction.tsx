import React from 'react';
import { Button, type ButtonProps } from './Button';

export function EmptyAction({ label, icon = '+', className, ...props }: {
  label: React.ReactNode;
  icon?: React.ReactNode;
} & Omit<ButtonProps, 'children' | 'variant'>): React.ReactElement {
  return <Button {...props} variant="ghost" className={['snl-empty-action', className].filter(Boolean).join(' ')}>
    <span aria-hidden="true" className="snl-empty-action__icon">{icon}</span>
    <span>{label}</span>
  </Button>;
}
