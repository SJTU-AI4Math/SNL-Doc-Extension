import React from 'react';
import { Button, type ButtonProps } from './Button';

export type TabVariant = 'underline' | 'pill';

export interface TabButtonProps extends Omit<ButtonProps, 'variant' | 'role'> {
  active: boolean;
  tabVariant?: TabVariant;
}

export function TabButton({
  active,
  tabVariant = 'underline',
  className,
  children,
  ...props
}: TabButtonProps): React.ReactElement {
  return (
    <Button
      variant="ghost"
      aria-pressed={active}
      tabIndex={active ? 0 : -1}
      data-active={active ? 'true' : 'false'}
      data-segmented-button="true"
      data-tab-variant={tabVariant}
      className={['snl-tab', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </Button>
  );
}

export const TabList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function TabList({ className, onKeyDown, ...props }, ref): React.ReactElement {
  return (
    <div
      ref={ref}
      role="group"
      className={['snl-tab-list', className].filter(Boolean).join(' ')}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        const origin = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-segmented-button="true"]');
        if (!origin || !event.currentTarget.contains(origin)) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
          '[data-segmented-button="true"]:not(:disabled)'
        )];
        if (tabs.length === 0) return;
        const current = Math.max(0, tabs.indexOf(origin));
        const next = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : event.key === 'ArrowLeft'
              ? (current - 1 + tabs.length) % tabs.length
              : (current + 1) % tabs.length;
        event.preventDefault();
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
      {...props}
    />
  );
});
