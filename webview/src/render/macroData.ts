import { MacroDataDriver, type SnlMacro } from '@sjtu-ai4math/snl-basics/core';

/** Runtime v8 macro record used only behind query adapters. */
export type MacroRecord = Record<string, SnlMacro>;

/**
 * Build the sole macro-data source consumed by SNL-Basics views.
 * Records are ordered from lowest to highest precedence; lookup happens only
 * inside the injected query backend, never through a parallel View prop.
 */
export function createMacroDataDriver(...records: Array<MacroRecord | null | undefined>): MacroDataDriver {
  return new MacroDataDriver({
    queries: {
      query_macro: async ({ macro_name, signal }) => {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        for (let i = records.length - 1; i >= 0; i -= 1) {
          const macro = records[i]?.[macro_name];
          if (macro) return macro;
        }
        return null;
      }
    }
  });
}

/** Synchronous projection for Extension-local metadata/UI behavior. */
export function lookupMacro(
  macroName: string,
  ...records: Array<MacroRecord | null | undefined>
): SnlMacro | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const macro = records[i]?.[macroName];
    if (macro) return macro;
  }
  return undefined;
}
