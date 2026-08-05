import React from 'react';
import { FormField, TextInput } from './FormControls';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'kind.fields',
  {
    immutableId: 'IDs are immutable; delete + recreate to rename',
    colorPicker: '{label} color picker',
    colorValue: '{label} color value',
    preview: '{name} preview'
  },
  {
    immutableId: 'ID 不可修改；如需重命名，请删除后重新创建',
    colorPicker: '{label}颜色选择器',
    colorValue: '{label}颜色值',
    preview: '{name}预览'
  }
);

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
  const t = useUiMessages(MESSAGES);
  return <FormField label={label}>
    <TextInput
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      readOnly={readOnly}
      mono={mono}
      title={readOnly ? t('immutableId') : undefined}
    />
  </FormField>;
}

export function ColorField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  return <div className="snl-field" style={{ flex: 1 }}>
    <label className="snl-field__label">{label}</label>
    <div style={{ display: 'flex', gap: '.4rem', alignItems: 'stretch' }}>
      <input
        type="color"
        aria-label={t('colorPicker', { label })}
        value={sanitizeForColorInput(value)}
        onChange={(event) => onChange(event.target.value)}
        className="snl-control"
        style={{ width: '2.5rem', padding: 0, background: 'transparent' }}
      />
      <TextInput
        value={value}
        aria-label={t('colorValue', { label })}
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
  const t = useUiMessages(MESSAGES);
  return <div style={{ marginBottom: '.9rem', padding: '.55rem .75rem', border: `2px solid ${stroke}`, background, color: '#000', borderRadius: 3, fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '.9rem' }}>
    {t('preview', { name })}
  </div>;
}
