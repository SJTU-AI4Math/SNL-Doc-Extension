import React from 'react';
import { Button } from './Button';

export function Disclosure({
  expanded,
  controls,
  onToggle,
  children,
  className,
  style,
  title
}: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}): React.ReactElement {
  return (
    <Button
      variant="ghost"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className={className}
      style={style}
      title={title}
    >
      {children}
    </Button>
  );
}
