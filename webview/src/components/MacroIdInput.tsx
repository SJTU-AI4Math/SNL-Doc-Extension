import React, {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef
} from 'react';

export interface MacroIdInputProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'rows'
> {
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  autoSize?: boolean;
}

/** Shared Macro-ID / SNL typing surface used by structural Entry editors. */
export const MacroIdInput = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  MacroIdInputProps
>(function MacroIdInput(
  {
    value,
    onChange,
    multiline = false,
    autoSize = false,
    style,
    className,
    ...props
  },
  forwardedRef
): React.ReactElement {
  const controlRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useImperativeHandle(forwardedRef, () => controlRef.current!, [multiline]);

  const lines = value.split('\n');
  const rows = Math.max(1, lines.length);
  const widthCh = Math.min(
    80,
    Math.max(12, ...lines.map((line) => line.length + 2))
  );

  useLayoutEffect(() => {
    if (!multiline || !autoSize) return;
    const textarea = controlRef.current as HTMLTextAreaElement | null;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, rows * 20 + 8)}px`;
  }, [value, multiline, autoSize, rows]);

  if (multiline) {
    return (
      <textarea
        {...props}
        ref={(element) => { controlRef.current = element; }}
        className={className}
        value={value}
        rows={autoSize ? rows : undefined}
        onChange={(event) => onChange(event.target.value)}
        style={{
          ...style,
          ...(autoSize ? {
            width: `${widthCh}ch`,
            maxWidth: style?.maxWidth ?? 'calc(100% - 1rem)',
            resize: 'none',
            overflow: 'hidden'
          } : {})
        }}
      />
    );
  }

  const inputProps = props as React.InputHTMLAttributes<HTMLInputElement>;
  return (
    <input
      {...inputProps}
      ref={(element) => { controlRef.current = element; }}
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={style}
      type={inputProps.type ?? 'text'}
    />
  );
});
