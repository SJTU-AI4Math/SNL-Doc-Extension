import React from 'react';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import type { SourceExportOptions } from '../../../src/sourceExport/types';

const M = defineUiMessages('sourceExportOptions', {
  enable: 'Include source code (read-only Monaco)', warning: 'Every HTML reader receives these source bytes. Read-only is not confidentiality. Review secrets and dependency licenses before exporting.',
  scope: 'Source scope', pointers: 'Pointer files only (complete files)', project: 'Filtered project snapshot (not necessarily buildable)', keep: 'Keep rules (override defaults, one per line)', exclude: 'Exclude rules (win over keep rules)', companion: 'Required additional license / notice files', external: 'Explicitly authorize external dependency roots (absolute directories)', fileLimit: 'Maximum file bytes', totalLimit: 'Maximum total source bytes', missing: 'Allow unavailable Pointer targets (show warnings and continue export)', mathlib: 'Use Mathlib example rules', available: 'Refresh and recapture the Library to enable source snapshots.', note: 'Rules use root-relative / paths, * and **. Defaults exclude .SNL_Doc, .git, .lake, build output and common credentials. Output is always excluded.'
}, {
  enable: '包含源代码（只读 Monaco）', warning: '每一位 HTML 阅读者都会收到这些源码字节。只读不是保密措施；导出前请检查凭据与依赖许可。',
  scope: '源码范围', pointers: '仅 Pointer 涉及的完整文件', project: '筛选后的完整项目结构（不保证可编译）', keep: '保留规则（覆盖默认排除，每行一条）', exclude: '排除规则（优先于保留规则）', companion: '必需的额外许可 / NOTICE 伴随文件', external: '明确授权的外部依赖根（绝对目录）', fileLimit: '每文件字节上限', totalLimit: '源码总字节上限', missing: '允许部分 Pointer 定位不可用（显示警告，继续导出）', mathlib: '填入 Mathlib 示例规则', available: '请刷新并重新捕获 Library，以启用源码快照。', note: '规则为根相对 / 路径，支持 * 和 **。默认排除 .SNL_Doc、.git、.lake、构建产物及常见凭据；当前输出始终排除。'
});
export function SourceExportFields({ value, onChange, available, disabled }: { value: SourceExportOptions; onChange(value: SourceExportOptions): void; available: boolean; disabled: boolean }): React.ReactElement {
  const t = useUiMessages(M);
  const update = (change: Partial<SourceExportOptions>) => onChange({ ...value, ...change });
  const fieldStyle: React.CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, #888)', padding: 6 };
  return <fieldset disabled={disabled} style={{ margin: '1rem 0', minWidth: 0 }}>
    <legend>{t('scope')}</legend>
    <label><input type="checkbox" checked={value.enabled} disabled={!available} onChange={e => update({ enabled: e.target.checked })} /> {t('enable')}</label>
    {!available && <p>{t('available')}</p>}
    {value.enabled && <>
      <p role="note">{t('warning')}</p>
      <label>{t('scope')}<select aria-label={t('scope')} value={value.scope} style={fieldStyle} onChange={e => update({ scope: e.target.value as SourceExportOptions['scope'] })}>
        <option value="pointer-files">{t('pointers')}</option><option value="project">{t('project')}</option>
      </select></label>
      <p>{t('note')}</p>
      {(['keep', 'exclude', 'companionFiles', 'allowedExternalRoots'] as const).map((key, i) => <label key={key} style={{ display: 'block', marginTop: 8 }}>
        {t((['keep', 'exclude', 'companion', 'external'] as const)[i])}
        <textarea aria-label={t((['keep', 'exclude', 'companion', 'external'] as const)[i])} rows={3} value={value[key].join('\n')} style={fieldStyle} spellCheck={false} onChange={e => update({ [key]: e.target.value.split('\n') })} />
      </label>)}
      <button type="button" onClick={() => update({ keep: ['.lake/packages/mathlib/Mathlib/**', '.lake/packages/mathlib/LICENSE', '.lake/packages/mathlib/lean-toolchain', '.lake/packages/mathlib/lake-manifest.json'], exclude: ['**/.lake/build/**', '**/.SNL_Doc/**', '**/.git/**', '**/node_modules/**'], companionFiles: ['.lake/packages/mathlib/LICENSE', '.lake/packages/mathlib/lean-toolchain', '.lake/packages/mathlib/lake-manifest.json'] })}>{t('mathlib')}</button>
      {(['maxFileBytes', 'maxTotalBytes'] as const).map((key, i) => <label key={key} style={{ display: 'block', marginTop: 8 }}>{t(i === 0 ? 'fileLimit' : 'totalLimit')}<input type="number" min="1" step="1" value={value[key]} style={fieldStyle} onChange={e => update({ [key]: Number(e.target.value) })} /></label>)}
      <label><input type="checkbox" checked={value.allowMissing} onChange={e => update({ allowMissing: e.target.checked })} /> {t('missing')}</label>
    </>}
  </fieldset>;
}
