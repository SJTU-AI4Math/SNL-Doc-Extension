import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireThemedKindColoring, type ThemedKindColoring } from './kindColoring';

export const KIND_PRESET_SCHEMA = 'snl-doc.kind-preset' as const;
export const KIND_PRESET_VERSION = 2 as const;

export type KindPresetDomain = 'entry' | 'macro';

export interface EntryPresetKind {
  id: string;
  name: string;
  coloring: ThemedKindColoring;
  defaultCounterName: string;
  style: string;
}

export interface MacroPresetKind {
  id: string;
  name: string;
  description: string;
  coloring: ThemedKindColoring;
}

export interface KindPresetPackage<D extends KindPresetDomain = KindPresetDomain> {
  schema: typeof KIND_PRESET_SCHEMA;
  version: typeof KIND_PRESET_VERSION;
  domain: D;
  id: string;
  copyKeys: { label: string; description: string };
  kinds: D extends 'entry' ? EntryPresetKind[] : MacroPresetKind[];
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COPY_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const PLACEHOLDER_PATTERN = /\b(?:placeholder|todo|tbd)\b/i;
const COPY_KEY_PAIRS: Record<KindPresetDomain, ReadonlySet<string>> = {
  entry: new Set([
    'fulcrumLabel:fulcrumDescription', 'leanLabel:leanDescription',
    'tsLabel:tsDescription', 'pythonLabel:pythonDescription'
  ]),
  macro: new Set(['basicsLabel:basicsDescription'])
};

function fail(path: string, message: string): never {
  throw new Error(`Invalid Kind preset package ${path}: ${message}`);
}

function objectAt(value: unknown, path: string, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, `${field} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, `${field} must be a non-empty string`);
  return value;
}

function validateColoring(value: unknown, path: string, field: string): ThemedKindColoring {
  try {
    const coloring = requireThemedKindColoring(value, field);
    for (const scheme of ['light', 'dark'] as const) {
      nonEmptyString(coloring[scheme].stroke, path, `${field}.${scheme}.stroke`);
      nonEmptyString(coloring[scheme].background, path, `${field}.${scheme}.background`);
    }
    return coloring;
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

function validateEntryKind(value: unknown, path: string, index: number): EntryPresetKind {
  const field = `kinds[${index}]`;
  const kind = objectAt(value, path, field);
  const id = nonEmptyString(kind.id, path, `${field}.id`);
  if (!ID_PATTERN.test(id)) fail(path, `${field}.id is not a canonical id`);
  return {
    id,
    name: nonEmptyString(kind.name, path, `${field}.name`),
    coloring: validateColoring(kind.coloring, path, `${field}.coloring`),
    defaultCounterName: nonEmptyString(kind.defaultCounterName, path, `${field}.defaultCounterName`),
    style: typeof kind.style === 'string' ? kind.style : fail(path, `${field}.style must be a string`)
  };
}

function validateMacroKind(value: unknown, path: string, index: number): MacroPresetKind {
  const field = `kinds[${index}]`;
  const kind = objectAt(value, path, field);
  const id = nonEmptyString(kind.id, path, `${field}.id`);
  if (!ID_PATTERN.test(id)) fail(path, `${field}.id is not a canonical id`);
  return {
    id,
    name: nonEmptyString(kind.name, path, `${field}.name`),
    description: nonEmptyString(kind.description, path, `${field}.description`),
    coloring: validateColoring(kind.coloring, path, `${field}.coloring`)
  };
}

function parsePackage<D extends KindPresetDomain>(path: string, expectedDomain: D): KindPresetPackage<D> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    fail(path, `could not parse JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const value = objectAt(parsed, path, 'package');
  if (value.schema !== KIND_PRESET_SCHEMA) fail(path, `schema must be ${KIND_PRESET_SCHEMA}`);
  if (value.version !== KIND_PRESET_VERSION) fail(path, `version must be ${KIND_PRESET_VERSION}`);
  if (value.domain !== expectedDomain) fail(path, `domain must be ${expectedDomain}`);
  const id = nonEmptyString(value.id, path, 'id');
  if (!ID_PATTERN.test(id)) fail(path, 'id is not a canonical id');
  const copy = objectAt(value.copyKeys, path, 'copyKeys');
  const label = nonEmptyString(copy.label, path, 'copyKeys.label');
  const description = nonEmptyString(copy.description, path, 'copyKeys.description');
  if (!COPY_KEY_PATTERN.test(label) || !COPY_KEY_PATTERN.test(description)) fail(path, 'copy keys must be canonical identifiers');
  if (PLACEHOLDER_PATTERN.test(label) || PLACEHOLDER_PATTERN.test(description)) fail(path, 'copy keys must not be placeholders');
  if (!COPY_KEY_PAIRS[expectedDomain].has(`${label}:${description}`)) fail(path, 'copy keys are not registered for this domain');
  if (!Array.isArray(value.kinds) || value.kinds.length === 0) fail(path, 'kinds must be a non-empty array');
  const kinds = value.kinds.map((kind, index) => expectedDomain === 'entry'
    ? validateEntryKind(kind, path, index)
    : validateMacroKind(kind, path, index));
  const kindIds = new Set<string>();
  for (const kind of kinds) {
    if (kindIds.has(kind.id)) fail(path, `duplicate kind id: ${kind.id}`);
    kindIds.add(kind.id);
  }
  return { schema: KIND_PRESET_SCHEMA, version: KIND_PRESET_VERSION, domain: expectedDomain, id, copyKeys: { label, description }, kinds } as KindPresetPackage<D>;
}

/** Load and independently validate every JSON package for one Kind domain. */
export function loadKindPresetPackages<D extends KindPresetDomain>(
  resourcesRoot: string,
  domain: D
): KindPresetPackage<D>[] {
  const directory = join(resourcesRoot, domain);
  let files: string[];
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw new Error(`Could not load ${domain} Kind preset packages from ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (files.length === 0) throw new Error(`No ${domain} Kind preset packages found in ${directory}`);
  const presets = files.map((file) => parsePackage(join(directory, file), domain));
  const presetIds = new Set<string>();
  for (const preset of presets) {
    if (presetIds.has(preset.id)) fail(directory, `duplicate preset id: ${preset.id}`);
    presetIds.add(preset.id);
  }
  return presets.sort((left, right) => left.id.localeCompare(right.id));
}
