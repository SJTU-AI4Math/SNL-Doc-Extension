// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelNav } from './PanelNav';
import { apply_preferences_snapshot } from '../runtime/preferencesRuntime';
import type { VsCodeApi } from '../vscodeApi';

const api = { postMessage: () => undefined } as unknown as VsCodeApi;

const back = {
  label: {
    type: 'i18n' as const,
    default_language: 'en',
    values: { en: 'Back', 'zh-CN': '返回' }
  },
  message: { type: 'back' }
};

afterEach(cleanup);

describe('PanelNav localization', () => {
  it('re-renders localized UI text after a preference snapshot', async () => {
    document.documentElement.lang = 'en';
    const view = render(<PanelNav vsApi={api} back={back} />);
    expect(view.container.textContent).toContain('Back');
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot',
      revision: 100,
      preferences: { language: 'zh-CN', color_scheme: 'dark', motion: 'reduced' }
    });
    await waitFor(() => expect(view.container.textContent).toContain('返回'));
    expect(view.getByRole('navigation').getAttribute('aria-label')).toBe('面板导航');
  });
});
