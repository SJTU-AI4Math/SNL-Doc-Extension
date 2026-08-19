import { MacroDataDriver, type SnlMacro } from '@sjtu-ai4math/snl-basics/core';
import { get_kind_color_scheme } from '../runtime/preferencesRuntime';

/** Runtime v8 macro record used only behind query adapters. */
export type MacroRecord = Record<string, SnlMacro>;

/**
 * Build the sole macro-data source consumed by SNL-Basics views.
 * Records are ordered from lowest to highest precedence; lookup happens only
 * inside the injected query backend, never through a parallel View prop.
 */
export function createMacroDataDriver(
  ...records: Array<MacroRecord | null | undefined>
): MacroDataDriver;
export function createMacroDataDriver(
  records: Array<MacroRecord | null | undefined>,
  onBackendQuery: (macroName: string) => void
): MacroDataDriver;
export function createMacroDataDriver(
  ...args: Array<
    MacroRecord | null | undefined |
    Array<MacroRecord | null | undefined> |
    ((macroName: string) => void)
  >
): MacroDataDriver {
  const instrumented = Array.isArray(args[0]) && typeof args[1] === 'function';
  const records = (instrumented ? args[0] : args) as Array<MacroRecord | null | undefined>;
  const onBackendQuery = instrumented ? args[1] as (macroName: string) => void : undefined;
  const resolved = instrumented ? new Map<string, SnlMacro | null>() : undefined;
  return new MacroDataDriver({
    context_reader: () => ({ color_scheme: get_kind_color_scheme() }),
    queries: {
      query_macro: async ({ macro_name, signal }) => {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        if (resolved?.has(macro_name)) return resolved.get(macro_name) ?? null;
        onBackendQuery?.(macro_name);
        for (let i = records.length - 1; i >= 0; i -= 1) {
          const record = records[i];
          if (record && Object.hasOwn(record, macro_name)) {
            const macro = record[macro_name] ?? null;
            resolved?.set(macro_name, macro);
            return macro;
          }
        }
        resolved?.set(macro_name, null);
        return null;
      }
    }
  });
}
