import React, { useId } from 'react';
import './ui.css';

export interface FormFieldProps {
  id?: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  children: React.ReactElement<React.InputHTMLAttributes<HTMLInputElement> & React.SelectHTMLAttributes<HTMLSelectElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>>;
}

export function FormField({ id, label, hint, error, required, children }: FormFieldProps): React.ReactElement {
  const generatedId = useId();
  const controlId = id ?? `snl-field-${generatedId.replace(/:/g, '')}`;
  const describedBy = [hint ? `${controlId}-hint` : '', error ? `${controlId}-error` : '']
    .filter(Boolean)
    .join(' ') || undefined;
  return (
    <div className="snl-field">
      {label ? <label className="snl-field__label" htmlFor={controlId}>{label}{required ? ' *' : ''}</label> : null}
      {React.cloneElement(children, {
        id: controlId,
        required,
        'aria-invalid': error ? true : children.props['aria-invalid'],
        'aria-describedby': describedBy ?? children.props['aria-describedby']
      })}
      {hint ? <div id={`${controlId}-hint`} className="snl-field__hint">{hint}</div> : null}
      {error ? <div id={`${controlId}-error`} className="snl-field__error">{error}</div> : null}
    </div>
  );
}

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  fullWidth?: boolean;
}
export function TextInput({ mono, fullWidth = true, className, ...props }: TextInputProps): React.ReactElement {
  return <input {...props} className={['snl-control', mono && 'snl-control--mono', fullWidth && 'snl-control--full', className].filter(Boolean).join(' ')} />;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> { fullWidth?: boolean; }
export function Select({ fullWidth = true, className, ...props }: SelectProps): React.ReactElement {
  return <select {...props} className={['snl-control', fullWidth && 'snl-control--full', className].filter(Boolean).join(' ')} />;
}

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { mono?: boolean; fullWidth?: boolean; }
export function TextArea({ mono, fullWidth = true, className, ...props }: TextAreaProps): React.ReactElement {
  return <textarea {...props} className={['snl-control', mono && 'snl-control--mono', fullWidth && 'snl-control--full', className].filter(Boolean).join(' ')} />;
}

export type AlertSeverity = 'info' | 'success' | 'warning' | 'error';
export function Alert({ severity, children, className }: { severity: AlertSeverity; children: React.ReactNode; className?: string }): React.ReactElement {
  return <div className={['snl-alert', `snl-alert--${severity}`, className].filter(Boolean).join(' ')} role={severity === 'error' ? 'alert' : 'status'} aria-live={severity === 'error' ? 'assertive' : 'polite'}>{children}</div>;
}

export function EmptyState({ title, description, action, compact = false }: { title?: React.ReactNode; description: React.ReactNode; action?: React.ReactNode; compact?: boolean }): React.ReactElement {
  return <div className={`snl-empty-state${compact ? ' snl-empty-state--compact' : ''}`}>
    {title ? <strong className="snl-empty-state__title">{title}</strong> : null}
    <div className="snl-empty-state__description">{description}</div>
    {action ? <div className="snl-empty-state__action">{action}</div> : null}
  </div>;
}
