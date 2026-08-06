import { describe, expect, it } from 'vitest';
import { CREATE_ENTRY_MESSAGES } from './CreateEntryApp';
import { createUiTranslator } from './i18n/uiMessages';

describe('Create Entry Chinese terminology', () => {
  it('localizes package, macro, canvas, and Infoview UI vocabulary', () => {
    const t = createUiTranslator('zh-CN', CREATE_ENTRY_MESSAGES);
    expect(t('package')).toBe('宏包');
    expect(t('viewInfoview')).toContain('信息视图');
    expect(t('guiCanvas')).toContain('画布');
    expect(t('macroActions')).toBe('宏操作');
    expect(t('cannotSavePackage')).not.toContain('Package');
    expect(t('cannotSaveCanvasSlot')).not.toContain('Macro');
  });
});