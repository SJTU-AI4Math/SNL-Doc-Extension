import type { ThemedKindColoring, KindColoringVariant } from '../../../src/kindColoring';
import { get_kind_color_scheme } from '../runtime/preferencesRuntime';

export function resolveWebviewKindColoring(coloring: ThemedKindColoring): KindColoringVariant {
  const variant = coloring[get_kind_color_scheme()];
  return { stroke: variant.stroke, background: variant.background };
}
