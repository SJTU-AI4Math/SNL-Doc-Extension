import { createHash } from 'node:crypto';
import { analyzeLatexTemplatePlaceholders } from './snlBasicsHostCompat';
import {
  CURRENT_DATA_VERSION,
  compareDataVersions,
  planDataMigrations,
  runDataMigrationChain,
  type DataMigration,
  type DataMigrationReport
} from './dataMigrationCore';
import {
  MACRO_STORAGE_VERSION,
  UNPACKAGED_PACKAGE_ID,
  assertPackageId,
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath,
  upgradeEntryEnvelopeSchema,
  upgradeMacroEnvelopeSchema,
  upgradePackageManifestSchema,
  type EntryEnvelope,
  type MacroEnvelope,
  type PackageManifest
} from './entityStorage';
import { assertThemedKindCatalogs, normalizeKindColoring } from './kindColoring';

export interface EntityStorageReceipt {
  legacy_backup_present: boolean;
  legacy_entries_present: boolean;
  entry_count: number;
  macro_package_count: number;
  macro_count: number;
  entries_digest: string;
  macro_packages_digest: string;
}

function semanticDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function makeEntityStorageReceipt(
  entries: unknown,
  macroPackages: Map<string, unknown>,
  legacyBackupPresent: boolean
): EntityStorageReceipt {
  const entryList = Array.isArray(entries) ? entries : [];
  const packages = [...macroPackages].sort(([left], [right]) => left.localeCompare(right));
  return {
    legacy_backup_present: legacyBackupPresent,
    legacy_entries_present: legacyBackupPresent && Array.isArray(entries),
    entry_count: entryList.length,
    macro_package_count: packages.length,
    macro_count: packages.reduce((count, [, value]) =>
      count + (isRecord(value) && isRecord(value.macros) ? Object.keys(value.macros).length : 0), 0),
    entries_digest: semanticDigest(entryList),
    macro_packages_digest: semanticDigest(packages)
  };
}
import { isSnlIdentifier } from './snlBasicsHostCompat';
import { is_valid_macro_i18n_string } from './localizedContent';

export interface WorkspaceDataSnapshot {
  config: Record<string, unknown>;
  /** key is the package filename including `.json`. */
  macroPackages: Map<string, unknown>;
  relationships: unknown;
  entries: unknown;
  packageManifests: Map<string, PackageManifest>;
  entryEntities: Map<string, EntryEnvelope>;
  macroEntities: Map<string, MacroEnvelope>;
}

export type MacroPackageSchemaVersion = '7' | '8' | '9' | '10' | '11';

export interface WorkspaceMigrationContext {
  data: WorkspaceDataSnapshot;
  canonicalizeMacroPackage(file: string, raw: unknown, targetVersion: MacroPackageSchemaVersion): unknown;
}

export type WorkspaceDataInspection = {
  status: 'missing' | 'invalid' | 'future' | 'current' | 'needsMigration';
  currentVersion: string | null;
  targetVersion: string;
  pending?: readonly DataMigration<WorkspaceMigrationContext>[];
  message: string;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function colorPair(value: Record<string, unknown>): { stroke: string; background: string } {
  const coloring = object(value.coloring);
  const fallback = typeof value.color === 'string' ? value.color : '#888888';
  return {
    stroke: typeof coloring.stroke === 'string' ? coloring.stroke : fallback,
    background: typeof coloring.background === 'string' ? coloring.background : fallback
  };
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must be an array of strings.`);
  }
}

function assertBackend(value: unknown, path: string): void {
  if (!isRecord(value) || typeof value.built_in !== 'string' || !isRecord(value.synthesis) ||
      (value.synthesis.mode !== 'formula' && value.synthesis.mode !== 'text') ||
      typeof value.synthesis.macro !== 'string') {
    throw new Error(`${path} must contain built_in and a valid synthesis { mode, macro }.`);
  }
}

function macroTemplateVariants(mode: unknown, template: unknown): string[] {
  if (typeof template === 'string') return [template];
  if (mode !== 'text' || !is_valid_macro_i18n_string(template) || !isRecord(template)) return [];
  const values = template.values;
  return isRecord(values)
    ? Object.values(values).filter((value): value is string => typeof value === 'string')
    : [];
}

function macroTemplateProjections(template: unknown, path: string): Record<string, unknown>[] {
  if (isRecord(template) && template.type === 'i18n') {
    const localizedFields = new Set(['type', 'default_language', 'values']);
    if (Object.keys(template).some((field) => !localizedFields.has(field)) ||
        typeof template.default_language !== 'string' || !template.default_language ||
        !isRecord(template.values) ||
        !Object.hasOwn(template.values, template.default_language) ||
        template.values[template.default_language] === undefined) {
      throw new Error(`${path} must be a valid localized whole-template value.`);
    }
    const projections = Object.values(template.values).filter((value) => value !== undefined);
    if (projections.length === 0 || !projections.every(isRecord)) {
      throw new Error(`${path} localized projections must be objects.`);
    }
    return projections as Record<string, unknown>[];
  }
  if (!isRecord(template)) throw new Error(`${path} must be a TemplateSpec object.`);
  return [template];
}

function assertMacroTemplateProjection(
  projection: Record<string, unknown>,
  path: string,
  dynamicArity: boolean
): void {
  if (Object.hasOwn(projection, 'type') ||
      !['formula_inline', 'formula_display', 'text', 'block'].includes(String(projection.mode))) {
    throw new Error(`${path}.mode is invalid.`);
  }
  if (typeof projection.body !== 'string' ||
      (projection.mode !== 'block' && projection.body.trim().length === 0)) {
    throw new Error(`${path}.body must be a non-empty string outside block mode.`);
  }
  const placeholderAnalysis = analyzeLatexTemplatePlaceholders(projection.body);
  if (placeholderAnalysis.invalid) {
    throw new Error(`${path}.body contains an out-of-range positional placeholder.`);
  }
  if (placeholderAnalysis.variadic !== dynamicArity) {
    throw new Error(`${path}.body variadic marker disagrees with the Macro arity contract.`);
  }
  if (projection.separator !== undefined && typeof projection.separator !== 'string') {
    throw new Error(`${path}.separator must be a string.`);
  }
  if (projection.block_template_name !== undefined &&
      (projection.mode !== 'block' || typeof projection.block_template_name !== 'string')) {
    throw new Error(`${path}.block_template_name is invalid.`);
  }
  if (projection.typst !== undefined) assertBackend(projection.typst, `${path}.typst`);
  if (projection.latex !== undefined) assertBackend(projection.latex, `${path}.latex`);
  if (projection.markdown !== undefined && typeof projection.markdown !== 'string') {
    throw new Error(`${path}.markdown must be a string.`);
  }
  if (projection.text !== undefined && typeof projection.text !== 'string') {
    throw new Error(`${path}.text must be a string.`);
  }
}

function macroTemplateArityContract(template: Record<string, unknown>): string {
  const analysis = analyzeLatexTemplatePlaceholders(String(template.body));
  return `${analysis.variadic ? 'dynamic' : 'fixed'}:${analysis.positional_arity}`;
}

export function assertCanonicalMacroPackage(
  file: string,
  raw: unknown,
  version: MacroPackageSchemaVersion
): asserts raw is Record<string, unknown> & { macros: Record<string, unknown> } {
  if (!isRecord(raw) || raw.version !== version || !isRecord(raw.macros)) {
    throw new Error(`${file} must be a canonical v${version} keyed Macro package.`);
  }
  for (const [macroName, value] of Object.entries(raw.macros)) {
    if (!isSnlIdentifier(macroName)) {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}] is not a valid SNL identifier.`);
    }
    if (!isRecord(value)) throw new Error(`${file}#macros[${JSON.stringify(macroName)}] must be an object.`);
    for (const styleOnly of [
      'style_name', 'mode', 'template', 'separator', 'block_template_name',
      'typst', 'latex', 'markdown', 'text',
      'tag', 'variadic_left', 'variadic_join', 'variadic_right',
      'react_renderer_key', 'display',
      'arity', 'katex_react', 'defaultStyle'
    ]) {
      if (Object.prototype.hasOwnProperty.call(value, styleOnly)) {
        throw new Error(
          `${file}#macros[${JSON.stringify(macroName)}].${styleOnly} is a recognized managed field not valid at Macro level in v${version}.`
        );
      }
    }
    if (typeof value.description !== 'string' || typeof value.dynamic_arity !== 'boolean') {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}] has invalid required fields.`);
    }
    if ((version === '10' || version === '11') &&
        (typeof value.kind !== 'string' || value.kind.length === 0 || value.kind === 'partial')) {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}].kind is not canonical Macro v${version}.`);
    }
    if ((version === '8' || version === '9') && value.kind !== undefined &&
        (typeof value.kind !== 'string' || value.kind.length === 0)) {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}].kind must be a non-empty string when present.`);
    }
    const source = value.source;
    if (!isRecord(source)) throw new Error(`${file}#macros[${JSON.stringify(macroName)}].source is required.`);
    assertStringArray(source.entries, `${file}#macros[${JSON.stringify(macroName)}].source.entries`);
    assertStringArray(source.urls, `${file}#macros[${JSON.stringify(macroName)}].source.urls`);
    assertStringArray(value.tags, `${file}#macros[${JSON.stringify(macroName)}].tags`);
    if (value.tags.some((tag: string) => tag.includes('\\'))) {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}].tags may not contain backslashes.`);
    }
    if (!Array.isArray(value.styles) || value.styles.length === 0) {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}].styles must be non-empty.`);
    }
    const names = new Set<string>();
    value.styles.forEach((styleValue, index) => {
      if (!isRecord(styleValue)) throw new Error(`${file} ${macroName} styles[${index}] must be an object.`);
      for (const macroOnly of [
        'kind', 'description', 'source', 'dynamic_arity', 'styles', 'default_style',
        'arity', 'katex_react', 'defaultStyle'
      ]) {
        if (Object.prototype.hasOwnProperty.call(styleValue, macroOnly)) {
          throw new Error(
            `${file} ${macroName} styles[${index}].${macroOnly} is a Macro-only managed field.`
          );
        }
      }
      if (version === '9' || version === '10') {
        for (const retired of [
          'tag', 'variadic_left', 'variadic_join', 'variadic_right',
          'react_renderer_key', 'display'
        ]) {
          if (Object.prototype.hasOwnProperty.call(styleValue, retired)) {
            throw new Error(
              `${file} ${macroName} styles[${index}].${retired} is a retired managed field not valid in v${version}.`
            );
          }
        }
      }
      const styleName = styleValue.style_name;
      if (typeof styleName !== 'string' || !isSnlIdentifier(styleName) || names.has(styleName)) {
        throw new Error(`${file} ${macroName} styles[${index}].style_name is invalid or duplicated.`);
      }
      names.add(styleName);
      if (version === '11') {
        assertStringArray(styleValue.tags, `${file} ${macroName} styles[${index}].tags`);
        if (styleValue.tags.some((tag: string) => tag.includes('\\'))) {
          throw new Error(`${file} ${macroName} styles[${index}].tags may not contain backslashes.`);
        }
        for (const retired of [
          'mode', 'separator', 'block_template_name', 'typst', 'latex', 'markdown', 'text',
          'tag', 'variadic_left', 'variadic_join', 'variadic_right',
          'react_renderer_key', 'display'
        ]) {
          if (Object.hasOwn(styleValue, retired)) {
            throw new Error(
              `${file} ${macroName} styles[${index}].${retired} is retired in v11; it belongs inside template.`
            );
          }
        }
        const currentStyleFields = new Set(['style_name', 'tags', 'template']);
        if (Object.keys(styleValue).some((field) => !currentStyleFields.has(field))) {
          throw new Error(
            `${file} ${macroName} styles[${index}] has fields outside the Macro v11 Style boundary.`
          );
        }
        const projections = macroTemplateProjections(
          styleValue.template,
          `${file} ${macroName} styles[${index}].template`
        );
        projections.forEach((projection, projectionIndex) => assertMacroTemplateProjection(
          projection,
          `${file} ${macroName} styles[${index}].template[${projectionIndex}]`,
          value.dynamic_arity === true
        ));
        if (new Set(projections.map(macroTemplateArityContract)).size !== 1) {
          throw new Error(
            `${file} ${macroName} styles[${index}].template projections must have identical arity.`
          );
        }
        return;
      }
      if (!['formula_inline', 'formula_display', 'text', 'block'].includes(String(styleValue.mode))) {
        throw new Error(`${file} ${macroName} styles[${index}].mode is invalid.`);
      }
      const templateValid = typeof styleValue.template === 'string' ||
        (version !== '8' && styleValue.mode === 'text' &&
          is_valid_macro_i18n_string(styleValue.template));
      if (!templateValid) {
        throw new Error(
          `${file} ${macroName} styles[${index}].template must be a string` +
          (version !== '8' && styleValue.mode === 'text' ? ' or a valid I18n value.' : '.')
        );
      }
      const variants = macroTemplateVariants(styleValue.mode, styleValue.template);
      if (variants.length === 0 || variants.some((template) => template.trim().length === 0)) {
        throw new Error(`${file} ${macroName} styles[${index}].template must be non-empty.`);
      }
      if (value.dynamic_arity && variants.some((template) => !template.includes('#*'))) {
        throw new Error(`${file} ${macroName} styles[${index}].template must contain #* for a dynamic Macro.`);
      }
      assertStringArray(styleValue.tags, `${file} ${macroName} styles[${index}].tags`);
      if (styleValue.tags.some((tag: string) => tag.includes('\\'))) {
        throw new Error(`${file} ${macroName} styles[${index}].tags may not contain backslashes.`);
      }
      if (styleValue.typst !== undefined) assertBackend(styleValue.typst, `${file} ${macroName} styles[${index}].typst`);
      if (styleValue.latex !== undefined) assertBackend(styleValue.latex, `${file} ${macroName} styles[${index}].latex`);
      if (styleValue.markdown !== undefined && typeof styleValue.markdown !== 'string') {
        throw new Error(`${file} ${macroName} styles[${index}].markdown must be a string.`);
      }
      if (styleValue.text !== undefined && typeof styleValue.text !== 'string') {
        throw new Error(`${file} ${macroName} styles[${index}].text must be a string.`);
      }
      if (styleValue.separator !== undefined && typeof styleValue.separator !== 'string') {
        throw new Error(`${file} ${macroName} styles[${index}].separator must be a string.`);
      }
      if (styleValue.block_template_name !== undefined &&
          (styleValue.mode !== 'block' || typeof styleValue.block_template_name !== 'string')) {
        throw new Error(`${file} ${macroName} styles[${index}].block_template_name is invalid.`);
      }
    });
    if (version === '8') {
      if (!isRecord(value.default_style)) {
        throw new Error(`${file} ${macroName}.default_style must be an object.`);
      }
      for (const [language, styleName] of Object.entries(value.default_style)) {
        if (!language.trim() || typeof styleName !== 'string' || !names.has(styleName)) {
          throw new Error(`${file} ${macroName}.default_style contains an invalid language or style.`);
        }
      }
    } else if ((version === '9' || version === '10' || version === '11') &&
        value.default_style !== undefined) {
      throw new Error(`${file} ${macroName}.default_style is not valid in Macro package v${version}.`);
    }
  }
}

function expectedCanonicalMacroNames(
  file: string,
  source: Record<string, unknown>
): string[] {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    if (!isRecord(value)) throw new Error(`${file} Macro ${JSON.stringify(key)} must be an object.`);
    if (typeof value.name === 'string' && value.name !== key) {
      throw new Error(
        `${file} Macro identity ${JSON.stringify(key)} disagrees with internal name ${JSON.stringify(value.name)}.`
      );
    }
    const isLegacySibling = 'katex_react' in value && !Array.isArray(value.styles);
    const dot = key.lastIndexOf('.');
    names.add(isLegacySibling && dot > 0 ? key.slice(0, dot) : key);
  }
  return [...names].sort();
}

function assertMacroIdentitiesPreserved(
  file: string,
  raw: unknown,
  canonical: Record<string, unknown>
): void {
  if (!isRecord(raw) || !isRecord(raw.macros)) return;
  const before = expectedCanonicalMacroNames(file, raw.macros);
  const after = Object.keys(canonical.macros as Record<string, unknown>).sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`${file} Macro identities changed during canonicalization.`);
  }
}

function migrate001To002(context: WorkspaceMigrationContext): void {
  const config = context.data.config;
  if (!Array.isArray(config.entry_kinds)) config.entry_kinds = [];
  if (!Array.isArray(config.macro_kinds)) config.macro_kinds = [];
}

function migrate002To003(context: WorkspaceMigrationContext): void {
  const config = context.data.config;
  config.entry_kinds = array(config.entry_kinds).map((value) => {
    const item = { ...object(value) };
    item.coloring = colorPair(item);
    if (item.numbering && typeof item.numbering === 'object') {
      const pattern = object(item.numbering).pattern;
      item.numbering = typeof pattern === 'string' ? pattern : '';
    } else if (typeof item.numbering !== 'string') {
      item.numbering = '';
    }
    if (typeof item.style !== 'string') item.style = '';
    delete item.color;
    return item;
  });
  config.macro_kinds = array(config.macro_kinds).map((value) => {
    const item = { ...object(value) };
    item.coloring = colorPair(item);
    if (typeof item.description !== 'string') item.description = '';
    delete item.color;
    return item;
  });
}

function migrate003To004(context: WorkspaceMigrationContext): void {
  const config = context.data.config;
  config.entry_kinds = array(config.entry_kinds).map((value) => {
    const item = { ...object(value) };
    item.coloring = colorPair(item);
    item.defaultCounterName =
      typeof item.defaultCounterName === 'string' ? item.defaultCounterName : '';
    if (typeof item.style !== 'string') item.style = '';
    delete item.color;
    delete item.numbering;
    return item;
  });
  config.macro_kinds = array(config.macro_kinds).map((value) => {
    const item = { ...object(value) };
    item.coloring = colorPair(item);
    if (typeof item.description !== 'string') item.description = '';
    delete item.color;
    return item;
  });
  for (const [file, raw] of context.data.macroPackages) {
    const canonical = context.canonicalizeMacroPackage(file, raw, '7');
    assertCanonicalMacroPackage(file, canonical, '7');
    assertMacroIdentitiesPreserved(file, raw, canonical);
    context.data.macroPackages.set(file, canonical);
  }
}

function migrate008To009ThemedKindColors(context: WorkspaceMigrationContext): void {
  const config = context.data.config;
  for (const field of ['entry_kinds', 'macro_kinds'] as const) {
    config[field] = array(config[field]).map((value, index) => {
      const item = { ...object(value) };
      const rawColoring = 'coloring' in item
        ? item.coloring
        : (typeof item.color === 'string'
          ? { stroke: item.color, background: item.color }
          : undefined);
      const coloring = object(rawColoring);
      const themed = 'light' in coloring || 'dark' in coloring;
      if (themed && ('stroke' in coloring || 'background' in coloring)) {
        throw new Error(
          `config.json#${field}[${index}].coloring must not mix legacy stroke/background with light/dark variants.`
        );
      }
      try {
        item.coloring = normalizeKindColoring(rawColoring);
      } catch (error) {
        throw new Error(
          `config.json#${field}[${index}].coloring is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      delete item.color;
      return item;
    });
  }
  assertThemedKindCatalogs(config);
}

function migrate004To005MacroV8(context: WorkspaceMigrationContext): void {
  for (const [file, raw] of context.data.macroPackages) {
    assertCanonicalMacroPackage(file, raw, '7');
    const canonical = context.canonicalizeMacroPackage(file, raw, '8');
    assertCanonicalMacroPackage(file, canonical, '8');
    assertMacroIdentitiesPreserved(file, raw, canonical);
    context.data.macroPackages.set(file, canonical);
  }
}

function addUnique<T>(map: Map<string, T>, path: string, value: T): void {
  const folded = path.toLowerCase();
  if ([...map.keys()].some((existing) => existing.toLowerCase() === folded)) {
    throw new Error(`Entity storage path collision at ${path}.`);
  }
  map.set(path, value);
}

function upgradePackageManifestForMigration(value: Record<string, unknown>): Record<string, unknown> {
  if (value.schema_version === 1) {
    const predecessor = { ...value };
    delete predecessor.schema_version;
    return upgradePackageManifestSchema(predecessor);
  }
  return upgradePackageManifestSchema(value);
}

function migrate005To006EntityStorage(context: WorkspaceMigrationContext): void {
  const data = context.data;
  if (Object.prototype.hasOwnProperty.call(data.config, 'entity_storage')) {
    throw new Error('config.json#entity_storage is reserved by workspace data version 0.0.6.');
  }
  const existingPackageManifests = new Map(data.packageManifests);
  const existingEntryEntities = new Map(data.entryEntities);
  const existingMacroEntities = new Map(data.macroEntities);
  const packageManifests = new Map<string, PackageManifest>();
  const entryEntities = new Map<string, EntryEnvelope>();
  const macroEntities = new Map<string, MacroEnvelope>();
  if (!Array.isArray(data.entries)) {
    throw new Error('entries.json must contain an array before per-entity migration.');
  }

  const entryIds = new Set<string>();
  for (const [index, value] of data.entries.entries()) {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
      throw new Error(`entries.json[${index}] must be an object with a non-empty id.`);
    }
    if (value.id !== value.id.trim()) {
      throw new Error(`entries.json[${index}] id must not have leading or trailing whitespace.`);
    }
    if ('package' in value) {
      throw new Error(`entries.json[${index}] uses reserved field "package" before package migration.`);
    }
    if (entryIds.has(value.id)) {
      throw new Error(`entries.json contains duplicate Entry identity ${JSON.stringify(value.id)}.`);
    }
    entryIds.add(value.id);
    const entry = {
      ...value,
      pointer: value.pointer ?? null,
      package: UNPACKAGED_PACKAGE_ID
    };
    addUnique(
      entryEntities,
      entryEntityPath(UNPACKAGED_PACKAGE_ID, value.id),
      makeEntryEnvelope(UNPACKAGED_PACKAGE_ID, entry)
    );
  }

  const foldedPackageIds = new Set<string>();
  for (const [file, raw] of [...data.macroPackages].sort(([a], [b]) => a.localeCompare(b))) {
    const packageId = file.replace(/\.json$/i, '');
    const folded = packageId.toLowerCase();
    if (foldedPackageIds.has(folded)) {
      throw new Error(`Macro package ids collide under case-folding: ${packageId}.`);
    }
    foldedPackageIds.add(folded);
    assertCanonicalMacroPackage(file, raw, '8');
    if ('format' in raw || 'id' in raw || 'schema_version' in raw) {
      throw new Error(
        `${file} uses reserved per-entity Package manifest fields "format", "id", or "schema_version".`
      );
    }
    const {
      version: _legacyVersion,
      macros,
      name: rawName,
      description: rawDescription,
      ...extensions
    } = raw;
    const manifest: PackageManifest = {
      ...extensions,
      ...makePackageManifest(
        packageId,
        typeof rawName === 'string' && rawName ? rawName : packageId,
        typeof rawDescription === 'string' ? rawDescription : ''
      )
    };
    addUnique(packageManifests, packageManifestPath(packageId), manifest);

    for (const [macroName, macroValue] of Object.entries(macros)) {
      if (!macroName || !isRecord(macroValue)) {
        throw new Error(`${file} Macro ${JSON.stringify(macroName)} must be an object.`);
      }
      if (macroName !== macroName.trim()) {
        throw new Error(`${file} Macro names must not have leading or trailing whitespace.`);
      }
      if ('name' in macroValue && macroValue.name !== macroName) {
        throw new Error(`${file} Macro key ${JSON.stringify(macroName)} disagrees with its name field.`);
      }
      const generatedEnvelope = makeMacroEnvelope(packageId, { ...macroValue, name: macroName });
      const { schema_version: _generatedSchema, ...legacyEnvelope } = generatedEnvelope;
      addUnique(
        macroEntities,
        macroEntityPath(packageId, macroName),
        legacyEnvelope as unknown as MacroEnvelope
      );
    }
  }

  addUnique(
    packageManifests,
    packageManifestPath(UNPACKAGED_PACKAGE_ID),
    makePackageManifest(
      UNPACKAGED_PACKAGE_ID,
      'Unpackaged',
      'Legacy Entries without an assigned package.',
      [...entryIds]
    )
  );
  const acceptCrashResidue = <T>(
    existing: Map<string, T>,
    expected: Map<string, T>,
    label: string
  ): void => {
    for (const [path, value] of existing) {
      if (!expected.has(path)) {
        throw new Error(`Conflicting partial migration residue in ${label}: ${path}.`);
      }
      const explicitlyCurrentMacro = label === 'macros' && isRecord(value) &&
        Object.hasOwn(value, 'schema_version');
      if (explicitlyCurrentMacro) {
        assertCurrentMacroEnvelope(path, value as unknown as MacroEnvelope);
      }
      const normalized = isRecord(value)
        ? label === 'packages'
          ? upgradePackageManifestForMigration(value)
          : label === 'entries'
            ? upgradeEntryEnvelopeSchema(value)
            : upgradeMacroEnvelopeSchema(value)
        : value;
      const expectedValue = expected.get(path)!;
      const legacyPackageWithoutMembership = label === 'packages' && isRecord(value) &&
        !Object.hasOwn(value, 'entry_ids');
      const normalizedExpected = explicitlyCurrentMacro
        ? migrateLegacyMacroEnvelopeToV11(
            context,
            path,
            expectedValue as unknown as MacroEnvelope,
            '8'
          )
        : isRecord(expectedValue)
          ? label === 'packages'
            ? upgradePackageManifestForMigration(expectedValue)
            : label === 'entries'
              ? upgradeEntryEnvelopeSchema(expectedValue)
              : upgradeMacroEnvelopeSchema(expectedValue)
          : expectedValue;
      if (legacyPackageWithoutMembership && isRecord(normalizedExpected)) {
        delete (normalizedExpected as Record<string, unknown>).entry_ids;
      }
      if (JSON.stringify(normalizedExpected) !== JSON.stringify(normalized)) {
        throw new Error(`Conflicting partial migration residue in ${label}: ${path}.`);
      }
    }
  };
  acceptCrashResidue(existingPackageManifests, packageManifests, 'packages');
  acceptCrashResidue(existingEntryEntities, entryEntities, 'entries');
  acceptCrashResidue(existingMacroEntities, macroEntities, 'macros');

  const generatedPackageIds = new Set(
    [...packageManifests.values()].map((manifest) => manifest.id)
  );
  const rawActive = data.config.active_macro_packages;
  let activePackageIds: string[];
  if (Object.prototype.hasOwnProperty.call(data.config, 'active_macro_packages')) {
    if (!Array.isArray(rawActive) || !rawActive.every((value) => typeof value === 'string')) {
      throw new Error('config.json#active_macro_packages must be an array of Package ID strings before migration.');
    }
    activePackageIds = rawActive.map((rawId) => {
      if (rawId !== rawId.trim()) {
        throw new Error('config.json#active_macro_packages contains a whitespace-padded Package ID.');
      }
      const packageId = rawId.replace(/\.json$/i, '');
      assertPackageId(packageId);
      if (packageId === UNPACKAGED_PACKAGE_ID || !generatedPackageIds.has(packageId)) {
        throw new Error(`Active Macro Package ${JSON.stringify(rawId)} has no generated Package manifest.`);
      }
      return packageId;
    });
  } else {
    activePackageIds = [...generatedPackageIds].filter((id) => id !== UNPACKAGED_PACKAGE_ID);
  }
  data.config.active_macro_packages = [...new Set(activePackageIds)]
    .sort((left, right) => left.localeCompare(right));

  data.packageManifests.clear();
  data.entryEntities.clear();
  data.macroEntities.clear();
  for (const [path, value] of packageManifests) data.packageManifests.set(path, value);
  for (const [path, value] of entryEntities) data.entryEntities.set(path, value);
  for (const [path, value] of macroEntities) data.macroEntities.set(path, value);

  data.config.entity_storage = {
    version: 1,
    legacy_backup_version: '0.0.5',
    entry_default_package: UNPACKAGED_PACKAGE_ID,
    receipt: makeEntityStorageReceipt(data.entries, data.macroPackages, true)
  };
}

function assertCurrentMacroEnvelope(path: string, envelope: MacroEnvelope): void {
  const declared = upgradeMacroEnvelopeSchema(envelope);
  if (declared.format !== 'snl-macro' || declared.version !== MACRO_STORAGE_VERSION ||
      typeof declared.package !== 'string' || !isRecord(declared.macro) ||
      typeof declared.macro.name !== 'string') {
    throw new Error(`${path} is not a valid explicitly versioned Macro envelope.`);
  }
  assertCanonicalMacroPackage(path, {
    version: '11',
    name: declared.package,
    macros: { [declared.macro.name]: declared.macro }
  }, '11');
}

function migrateLegacyMacroEnvelopeToV11(
  context: WorkspaceMigrationContext,
  path: string,
  envelope: MacroEnvelope,
  sourceVersion: '8' | '9' | '10'
): MacroEnvelope {
  const macroName = envelope.macro.name;
  if (typeof macroName !== 'string' || !macroName) {
    throw new Error(`${path} Macro entity is missing its name.`);
  }
  const { name: _name, ...macro } = envelope.macro;
  const sourcePackage = {
    version: sourceVersion,
    name: envelope.package,
    macros: { [macroName]: macro }
  };
  assertCanonicalMacroPackage(path, sourcePackage, sourceVersion);
  const canonical = context.canonicalizeMacroPackage(path, sourcePackage, '11');
  assertCanonicalMacroPackage(path, canonical, '11');
  const migrated = Object.hasOwn(canonical.macros, macroName)
    ? canonical.macros[macroName]
    : undefined;
  if (!isRecord(migrated)) {
    throw new Error(`${path} Macro identity ${JSON.stringify(macroName)} disappeared during v11 migration.`);
  }
  return {
    ...envelope,
    ...makeMacroEnvelope(envelope.package, { ...migrated, name: macroName })
  };
}

function migrateMacroEntitiesToV11(
  context: WorkspaceMigrationContext,
  sourceVersion: '8' | '9' | '10'
): void {
  for (const [path, envelope] of context.data.macroEntities) {
    if (Object.hasOwn(envelope, 'schema_version')) {
      assertCurrentMacroEnvelope(path, envelope);
      context.data.macroEntities.set(
        path,
        upgradeMacroEnvelopeSchema(envelope) as unknown as MacroEnvelope
      );
      continue;
    }
    context.data.macroEntities.set(
      path,
      migrateLegacyMacroEnvelopeToV11(context, path, envelope, sourceVersion)
    );
  }
}

function migrate0010To0011PackageMembership(context: WorkspaceMigrationContext): void {
  const membership = new Map<string, string[]>();
  const manifests = new Map<string, PackageManifest>();
  const explicitSuccessors = new Set<string>();
  for (const [path, raw] of context.data.packageManifests) {
    if (!isRecord(raw) || raw.format !== 'snl-package' || raw.version !== 1 ||
        typeof raw.id !== 'string' || typeof raw.name !== 'string' ||
        typeof raw.description !== 'string') {
      throw new Error(`${path} is not a valid predecessor Package manifest.`);
    }
    assertPackageId(raw.id);
    if (path !== packageManifestPath(raw.id)) {
      throw new Error(`${path} does not match Package identity ${JSON.stringify(raw.id)}.`);
    }
    const schemaVersion = (raw as unknown as { schema_version?: unknown }).schema_version;
    if (schemaVersion !== undefined && schemaVersion !== 1 && schemaVersion !== 2) {
      throw new Error(`${path} has unsupported Package schema_version ${String(schemaVersion)}.`);
    }
    if (schemaVersion === 2) {
      if (!Array.isArray(raw.entry_ids)) {
        throw new Error(`${path} explicit successor is missing Package entry_ids.`);
      }
      const validated = makePackageManifest(raw.id, raw.name, raw.description, raw.entry_ids as string[]);
      if (JSON.stringify(validated.entry_ids) !== JSON.stringify(raw.entry_ids)) {
        throw new Error(`${path} explicit successor has invalid Package entry_ids.`);
      }
      explicitSuccessors.add(raw.id);
    }
    if (manifests.has(raw.id)) {
      throw new Error(`Duplicate Package identity ${JSON.stringify(raw.id)}.`);
    }
    membership.set(raw.id, []);
    manifests.set(raw.id, raw as unknown as PackageManifest);
  }

  const entryIds = new Set<string>();
  for (const [path, raw] of context.data.entryEntities) {
    const upgraded = isRecord(raw) ? upgradeEntryEnvelopeSchema(raw) : raw;
    if (!isRecord(upgraded) || upgraded.format !== 'snl-entry' || upgraded.version !== 1 ||
        typeof upgraded.package !== 'string' || !isRecord(upgraded.entry) ||
        typeof upgraded.entry.id !== 'string' || !upgraded.entry.id ||
        upgraded.entry.package !== upgraded.package) {
      throw new Error(`${path} is not a valid Entry envelope for Package membership migration.`);
    }
    if (path !== entryEntityPath(upgraded.package, upgraded.entry.id)) {
      throw new Error(`${path} does not match Entry identity ${JSON.stringify(upgraded.entry.id)}.`);
    }
    if (entryIds.has(upgraded.entry.id)) {
      throw new Error(`Duplicate Entry identity ${JSON.stringify(upgraded.entry.id)}.`);
    }
    entryIds.add(upgraded.entry.id);
    const ownerMembership = membership.get(upgraded.package);
    if (!ownerMembership) {
      throw new Error(
        `Entry ${JSON.stringify(upgraded.entry.id)} references missing Package ${JSON.stringify(upgraded.package)}.`
      );
    }
    ownerMembership.push(upgraded.entry.id);
  }

  for (const [packageId, raw] of manifests) {
    const entryIdsForPackage = membership.get(packageId)!;
    entryIdsForPackage.sort((left, right) => left.localeCompare(right));
    if (explicitSuccessors.has(packageId) &&
        JSON.stringify(raw.entry_ids) !== JSON.stringify(entryIdsForPackage)) {
      throw new Error(
        `${packageManifestPath(packageId)} explicit successor entry_ids conflict with owner-derived membership.`
      );
    }
    context.data.packageManifests.set(packageManifestPath(packageId), {
      ...raw,
      ...makePackageManifest(packageId, raw.name, raw.description, entryIdsForPackage)
    });
  }
}

export const WORKSPACE_DATA_MIGRATIONS: readonly DataMigration<WorkspaceMigrationContext>[] = [
  {
    from: '0.0.1',
    to: '0.0.2',
    description: 'Add explicit Entry and Macro kind catalogs.',
    migrate: async (context) => { migrate001To002(context); }
  },
  {
    from: '0.0.2',
    to: '0.0.3',
    description: 'Normalize kind coloring and legacy numbering shapes.',
    migrate: async (context) => { migrate002To003(context); }
  },
  {
    from: '0.0.3',
    to: '0.0.4',
    description: 'Persist current kind fields and canonical Macro package v7 data.',
    migrate: async (context) => { migrate003To004(context); }
  },
  {
    from: '0.0.4',
    to: '0.0.5',
    description: 'Canonicalize Macro package v8 language default styles.',
    migrate: async (context) => { migrate004To005MacroV8(context); }
  },
  {
    from: '0.0.5',
    to: '0.0.6',
    description: 'Split aggregate Entries and Macros into stable per-entity package storage.',
    migrate: async (context) => { migrate005To006EntityStorage(context); }
  },
  {
    from: '0.0.6',
    to: '0.0.9',
    description: 'Upgrade Macro v8 entities to v11 and split Kind colors into theme variants.',
    migrate: async (context) => {
      migrateMacroEntitiesToV11(context, '8');
      migrate008To009ThemedKindColors(context);
    }
  },
  {
    from: '0.0.7',
    to: '0.0.9',
    description: 'Upgrade Macro v9 entities to v11 and split Kind colors into theme variants.',
    migrate: async (context) => {
      migrateMacroEntitiesToV11(context, '9');
      migrate008To009ThemedKindColors(context);
    }
  },
  {
    from: '0.0.8',
    to: '0.0.9',
    description: 'Upgrade Macro v10 entities to v11 and split Kind colors into theme variants.',
    migrate: async (context) => {
      migrateMacroEntitiesToV11(context, '10');
      migrate008To009ThemedKindColors(context);
    }
  },
  {
    from: '0.0.9',
    to: '0.0.10',
    description: 'Enable lazy per-file schema migration for split entity storage.',
    migrate: async () => {
      // Files written before 0.0.10 intentionally remain unmarked. Readers
      // treat an absent per-file marker as the unique legacy generation and
      // ordinary writes replace the complete file with the current marker.
    }
  },
  {
    from: '0.0.10',
    to: '0.0.11',
    description: 'Publish authoritative exact Entry membership in every Package manifest.',
    migrate: async (context) => { migrate0010To0011PackageMembership(context); }
  }
];

export function inspectWorkspaceData(config: unknown): WorkspaceDataInspection {
  if (config === null) {
    return {
      status: 'missing',
      currentVersion: null,
      targetVersion: CURRENT_DATA_VERSION,
      message: '.SNL_Doc/config.json does not exist.'
    };
  }
  if (!isRecord(config)) {
    return {
      status: 'invalid',
      currentVersion: null,
      targetVersion: CURRENT_DATA_VERSION,
      message: 'config.json must contain a JSON object.'
    };
  }
  const rawVersion = config.version;
  const currentVersion = rawVersion === undefined ? '0.0.1' : rawVersion;
  if (typeof currentVersion !== 'string') {
    return {
      status: 'invalid',
      currentVersion: null,
      targetVersion: CURRENT_DATA_VERSION,
      message: 'config.json#version must be a SemVer string.'
    };
  }
  try {
    const relation = compareDataVersions(currentVersion, CURRENT_DATA_VERSION);
    if (relation > 0) {
      return {
        status: 'future',
        currentVersion,
        targetVersion: CURRENT_DATA_VERSION,
        message: `Workspace data ${currentVersion} is newer than this Extension supports.`
      };
    }
    const pending = planDataMigrations(
      currentVersion,
      CURRENT_DATA_VERSION,
      WORKSPACE_DATA_MIGRATIONS
    );
    return pending.length === 0
      ? {
          status: 'current',
          currentVersion,
          targetVersion: CURRENT_DATA_VERSION,
          pending,
          message: `Workspace data is current (${CURRENT_DATA_VERSION}).`
        }
      : {
          status: 'needsMigration',
          currentVersion,
          targetVersion: CURRENT_DATA_VERSION,
          pending,
          message: `${pending.length} migration step${pending.length === 1 ? '' : 's'} required.`
        };
  } catch (error) {
    return {
      status: 'invalid',
      currentVersion,
      targetVersion: CURRENT_DATA_VERSION,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function assertWorkspaceDataWritable(
  config: unknown,
  options: { allowPendingMigration?: boolean } = {}
): void {
  const inspection = inspectWorkspaceData(config);
  if (inspection.status === 'missing') {
    throw new Error('.SNL_Doc/config.json does not exist.');
  }
  if (inspection.status === 'needsMigration' && !options.allowPendingMigration) {
    throw new Error(
      `Workspace data ${inspection.currentVersion} requires migration to ${CURRENT_DATA_VERSION} before ordinary writes.`
    );
  }
  if (inspection.status === 'future' || inspection.status === 'invalid') {
    throw new Error(inspection.message);
  }
}

export function assertJsonSnapshotUnchanged(
  expected: unknown,
  current: unknown,
  path: string
): void {
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error(`Refusing stale write to ${path}; the file changed after this edit began.`);
  }
}

export function assertWorkspaceDataVersionNotRegressed(
  currentConfig: unknown,
  nextConfig: unknown
): void {
  const current = inspectWorkspaceData(currentConfig);
  const next = inspectWorkspaceData(nextConfig);
  if (!current.currentVersion || !next.currentVersion ||
      ['missing', 'invalid', 'future'].includes(current.status) ||
      ['missing', 'invalid', 'future'].includes(next.status)) {
    throw new Error('Cannot compare invalid workspace data versions for a config write.');
  }
  if (compareDataVersions(next.currentVersion, current.currentVersion) < 0) {
    throw new Error(
      `Refusing to regress workspace data version ${current.currentVersion} to ${next.currentVersion}; ` +
      'the config was migrated after this edit began.'
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertCatalog(
  config: Record<string, unknown>,
  field: 'entry_kinds' | 'macro_kinds',
  required: boolean
): void {
  const value = config[field];
  if (value === undefined && !required) return;
  if (!Array.isArray(value)) {
    throw new Error(`config.json#${field} must be an array before migration.`);
  }
  value.forEach((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`config.json#${field}[${index}] must be an object with a non-empty id.`);
    }
  });
}

function assertMacroPackageShape(file: string, raw: unknown): void {
  const assertNamedArray = (items: unknown[]): void => {
    const names = new Set<string>();
    items.forEach((item, index) => {
      if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error(`${file} macros[${index}] must be an object with a non-empty name.`);
      }
      if (names.has(item.name)) {
        throw new Error(`${file} contains duplicate Macro identity ${JSON.stringify(item.name)}.`);
      }
      names.add(item.name);
    });
  };
  const assertMap = (map: Record<string, unknown>): void => {
    for (const [name, value] of Object.entries(map)) {
      if (!name || !isRecord(value)) {
        throw new Error(`${file} macros[${JSON.stringify(name)}] must be an object.`);
      }
    }
  };

  if (Array.isArray(raw)) {
    assertNamedArray(raw);
    return;
  }
  if (!isRecord(raw)) {
    throw new Error(`${file} must contain a Macro package object or legacy array.`);
  }
  if ('macros' in raw) {
    if (Array.isArray(raw.macros)) {
      assertNamedArray(raw.macros);
      return;
    }
    if (isRecord(raw.macros)) {
      assertMap(raw.macros);
      return;
    }
    throw new Error(`${file}#macros must be an array or keyed object.`);
  }
  const legacy = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !['version', 'name', 'description'].includes(key))
  );
  assertMap(legacy);
}

function preflightWorkspaceSnapshot(source: WorkspaceDataSnapshot): void {
  const inspection = inspectWorkspaceData(source.config);
  if (inspection.status !== 'needsMigration' && inspection.status !== 'current') {
    throw new Error(inspection.message);
  }
  const version = inspection.currentVersion ?? '0.0.1';
  assertCatalog(source.config, 'entry_kinds', compareDataVersions(version, '0.0.2') >= 0);
  assertCatalog(source.config, 'macro_kinds', compareDataVersions(version, '0.0.3') >= 0);
  for (const [file, raw] of source.macroPackages) {
    assertMacroPackageShape(file, raw);
  }
}

export function cloneWorkspaceDataSnapshot(source: WorkspaceDataSnapshot): WorkspaceDataSnapshot {
  return {
    config: structuredClone(source.config),
    macroPackages: new Map(
      [...source.macroPackages].map(([file, raw]) => [file, structuredClone(raw)])
    ),
    relationships: structuredClone(source.relationships),
    entries: structuredClone(source.entries),
    packageManifests: new Map(
      [...source.packageManifests].map(([path, value]) => [path, structuredClone(value)])
    ),
    entryEntities: new Map(
      [...source.entryEntities].map(([path, value]) => [path, structuredClone(value)])
    ),
    macroEntities: new Map(
      [...source.macroEntities].map(([path, value]) => [path, structuredClone(value)])
    )
  };
}

export async function migrateWorkspaceSnapshot(
  source: WorkspaceDataSnapshot,
  canonicalizeMacroPackage: (
    file: string,
    raw: unknown,
    targetVersion: MacroPackageSchemaVersion
  ) => unknown
): Promise<DataMigrationReport<WorkspaceMigrationContext>> {
  const inspection = inspectWorkspaceData(source.config);
  if (inspection.status === 'current') {
    return {
      from: CURRENT_DATA_VERSION,
      to: CURRENT_DATA_VERSION,
      applied: []
    };
  }
  if (inspection.status !== 'needsMigration' || !inspection.pending) {
    throw new Error(inspection.message);
  }
  preflightWorkspaceSnapshot(source);
  const working = cloneWorkspaceDataSnapshot(source);
  const context: WorkspaceMigrationContext = { data: working, canonicalizeMacroPackage };
  const report = await runDataMigrationChain(
    context,
    inspection.pending,
    async (version) => { working.config.version = version; }
  );
  source.config = working.config;
  source.macroPackages = working.macroPackages;
  source.relationships = working.relationships;
  source.entries = working.entries;
  source.packageManifests = working.packageManifests;
  source.entryEntities = working.entryEntities;
  source.macroEntities = working.macroEntities;
  return report;
}
