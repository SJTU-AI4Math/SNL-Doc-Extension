import { describe, expect, it } from 'vitest';
import { formatMacroConflict } from './macroOutputI18n';

describe('SNL Macros output localization', () => {
  it('renders conflict diagnostics in the selected interface language', () => {
    expect(formatMacroConflict('en', 'eq', 'core', 'extra')).toBe(
      '[warn] macro name conflict: “eq” in packages core and extra. Last write wins (order-dependent).'
    );
    const chinese = formatMacroConflict('zh-CN', 'eq', 'core', 'extra');
    expect(chinese).toBe(
      '[警告] 宏名称冲突：“eq”同时出现在宏包 core 和 extra 中。将采用最后写入的定义（结果取决于顺序）。'
    );
    expect(chinese).not.toContain('Last write wins');
  });
});
