import React from 'react';
import './ui.css';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  style?: React.CSSProperties;
  loading?: boolean;
  loadingLabel?: React.ReactNode;
}

/** Single exit for every webview button; interaction styling lives in ui.css. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className,
  title,
  disabled,
  loading = false,
  loadingLabel,
  type = 'button',
  onClick,
  'aria-disabled': ariaDisabled,
  ...rest
}, ref): React.ReactElement {
  const unavailable = ariaDisabled === true || ariaDisabled === 'true';
  const classes = ['snl-btn', `snl-btn--${variant}`, `snl-btn--${size}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type={type}
      title={title}
      aria-busy={loading || undefined}
      aria-disabled={ariaDisabled}
      disabled={disabled || loading}
      className={classes}
      onClick={unavailable ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : onClick}
      {...rest}
    >
      {loading ? (loadingLabel ?? children) : children}
    </button>
  );
});
