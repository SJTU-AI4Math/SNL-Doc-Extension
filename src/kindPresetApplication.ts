interface PresetKind {
  coloring: { stroke: string; background: string };
}

interface KindPreset<K extends PresetKind> {
  id: string;
  kinds: readonly K[];
}

export type PreparedKindPresetApplication<K> =
  | { status: 'applied'; kinds: K[] }
  | { status: 'nonEmpty'; existing: number }
  | { status: 'unknownPreset'; presetId: string };

/**
 * Resolve a preset against an existing catalog without mutating either input.
 * This is the shared empty-catalog-only policy for entry and macro kinds.
 */
export function prepareKindPresetApplication<K extends PresetKind>(
  presets: readonly KindPreset<K>[],
  presetId: string,
  existing: readonly unknown[]
): PreparedKindPresetApplication<K> {
  const preset = presets.find((candidate) => candidate.id === presetId);
  if (!preset) return { status: 'unknownPreset', presetId };
  if (existing.length > 0) return { status: 'nonEmpty', existing: existing.length };
  return {
    status: 'applied',
    kinds: preset.kinds.map((kind) => ({
      ...kind,
      coloring: { ...kind.coloring }
    }))
  };
}
