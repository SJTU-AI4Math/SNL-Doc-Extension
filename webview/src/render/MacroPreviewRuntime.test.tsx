// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MacroPreview, createMacroPreviewRuntime } from './MacroPreview';
import type { WireMacro } from './macroWire';

afterEach(cleanup);

function macro(name: string, body: string): WireMacro {
  return {
    name,
    description: '',
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    styles: [{
      style_name: 'default',
      tags: [],
      template: { mode: 'formula_inline', body }
    }],
    tags: []
  };
}

describe('Macro preview runtime', () => {
  it('shares one driver across previews and bounds repeated backend queries', async () => {
    const value = macro('shared', '\\mathrm{SHARED}');
    const runtime = createMacroPreviewRuntime({ macros: { shared: value }, language: 'en' });
    const driver = runtime.macroDataDriver;
    const view = render(
      <>
        {Array.from({ length: 6 }, (_, index) => (
          <MacroPreview
            key={index}
            macro={value}
            runtime={runtime}
            label={`shared preview ${index}`}
          />
        ))}
      </>
    );
    await waitFor(() => expect(view.container.textContent).toContain('SHARED'));
    expect(runtime.macroDataDriver).toBe(driver);
    expect(runtime.backendQueryCount()).toBeGreaterThan(0);
    expect(runtime.backendQueryCount()).toBeLessThanOrEqual(2);
  });

  it('isolates stale catalogs and honors cancellation', async () => {
    const oldMacro = macro('versioned', '\\mathrm{OLD}');
    const newMacro = macro('versioned', '\\mathrm{NEW}');
    const oldRuntime = createMacroPreviewRuntime({
      macros: { versioned: oldMacro },
      language: 'en'
    });
    const pendingOld = oldRuntime.macroDataDriver.query_macro({ macro_name: 'versioned' });
    const newRuntime = createMacroPreviewRuntime({
      macros: { versioned: newMacro },
      language: 'en'
    });
    expect(newRuntime.macroDataDriver).not.toBe(oldRuntime.macroDataDriver);
    expect((await pendingOld)?.styles[0].template).toMatchObject({ body: '\\mathrm{OLD}' });
    expect((await newRuntime.macroDataDriver.query_macro({ macro_name: 'versioned' }))
      ?.styles[0].template).toMatchObject({ body: '\\mathrm{NEW}' });

    const controller = new AbortController();
    controller.abort(new DOMException('stale catalog', 'AbortError'));
    await expect(newRuntime.macroDataDriver.query_macro({
      macro_name: 'versioned',
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('constructs one provider-scoped runtime in each Create surface', () => {
    for (const file of ['CreateEntryApp.tsx', 'CreateMacroApp.tsx']) {
      const source = readFileSync(`webview/src/${file}`, 'utf8');
      expect(source.match(/createMacroPreviewRuntime\(/g), file).toHaveLength(1);
      expect(source.match(/<MacroPreviewRuntimeProvider/g), file).toHaveLength(1);
    }
  });
});
