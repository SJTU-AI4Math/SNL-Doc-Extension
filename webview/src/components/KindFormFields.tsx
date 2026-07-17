import React from 'react';
import { FormField, TextInput } from './FormControls';

export function sanitizeForColorInput(value: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : '#888888';
}

export function KindTextField({ label, value, onChange, placeholder, mono, readOnly }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  readOnly?: boolean;
}): React.ReactElement {
  return <FormField label={label}>
    <TextInput
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      readOnly={readOnly}
      mono={mono}
      title={readOnly ? 'IDs are immutable; delete + recreate to rename' : undefined}
    />
  </FormField>;
}

export function ColorField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return <div className="snl-field" style={{ flex: 1 }}>
    <label className="snl-field__label">{label}</label>
    <div style={{ display: 'flex', gap: '.4rem', alignItems: 'stretch' }}>
      <input
        type="color"
        aria-label={`${label} color picker`}
        value={sanitizeForColorInput(value)}
        onChange={(event) => onChange(event.target.value)}
        className="snl-control"
        style={{ width: '2.5rem', padding: 0, background: 'transparent' }}
      />
      <TextInput
        value={value}
        aria-label={`${label} color value`}
        onChange={(event) => onChange(event.target.value)}
        mono
        style={{ flex: 1 }}
      />
    </div>
  </div>;
}

export function ColorPreview({ stroke, background, name }: {
  stroke: string;
  background: string;
  name: string;
}): React.ReactElement {
  return <div style={{ marginBottom: '.9rem', padding: '.55rem .75rem', border: `2px solid ${stroke}`, background, color: '#000', borderRadius: 3, fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '.9rem' }}>
    {name} preview
  </div>;
}
