import { createHash } from 'node:crypto';
import {
  CURRENT_DATA_VERSION,
  compareDataVersions,
  planDataMigrations,
  runDataMigrationChain,
  type DataMigration,
  type DataMigrationReport
} from './dataMigrationCore';
import {
  UNPACKAGED_PACKAGE_ID,
  assertPackageId,
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath,
  type EntryEnvelope,
  type MacroEnvelope,
  type PackageManifest
} from './entityStorage';

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
import { isSnlIdentifier } from '@sjtu-ai4math/snl-basics/core';

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

export interface WorkspaceMigrationContext {
  data: WorkspaceDataSnapshot;
  canonicalizeMacroPackage(file: string, raw: unknown, targetVersion: '7' | '8'): unknown;
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

function assertCanonicalMacroPackage(
  file: string,
  raw: unknown,
  version: '7' | '8'
): asserts raw is Record<string, unknown> & { macros: Record<string, unknown> } {
  if (!isRecord(raw) || raw.version !== version || !isRecord(raw.macros)) {
    throw new Error(`${file} must be a canonical v${version} keyed Macro package.`);
  }
  for (const [macroName, value] of Object.entries(raw.macros)) {
    if (!isSnlIdentifier(macroName)) {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}] is not a valid SNL identifier.`);
    }
    if (!isRecord(value)) throw new Error(`${file}#macros[${JSON.stringify(macroName)}] must be an object.`);
    if (typeof value.description !== 'string' || typeof value.dynamic_arity !== 'boolean') {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}] has invalid required fields.`);
    }
    const source = value.source;
    if (!isRecord(source)) throw new Error(`${file}#macros[${JSON.stringify(macroName)}].source is required.`);
    assertStringArray(source.entries, `${file}#macros[${JSON.stringify(macroName)}].source.entries`);
    assertStringArray(source.urls, `${file}#macros[${JSON.stringify(macroName)}].source.urls`);
    assertStringArray(value.tags, `${file}#macros[${JSON.stringify(macroName)}].tags`);
    if (!Array.isArray(value.styles) || value.styles.length === 0) {
      throw new Error(`${file}#macros[${JSON.stringify(macroName)}].styles must be non-empty.`);
    }
    const names = new Set<string>();
    value.styles.forEach((styleValue, index) => {
      if (!isRecord(styleValue)) throw new Error(`${file} ${macroName} styles[${index}] must be an object.`);
      const styleName = styleValue.style_name;
      if (typeof styleName !== 'string' || !isSnlIdentifier(styleName) || names.has(styleName)) {
        throw new Error(`${file} ${macroName} styles[${index}].style_name is invalid or duplicated.`);
      }
      names.add(styleName);
      if (!['formula_inline', 'formula_display', 'text', 'block'].includes(String(styleValue.mode))) {
        throw new Error(`${file} ${macroName} styles[${index}].mode is invalid.`);
      }
      if (typeof styleValue.template !== 'string') {
        throw new Error(
          `${file} ${macroName} styles[${index}].template must be a string; ` +
          'split localized Macro templates manually before migration.'
        );
      }
      assertStringArray(styleValue.tags, `${file} ${macroName} styles[${index}].tags`);
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
          throw new Error(`${file} ${macroName}.default_style[${JSON.stringify(language)}] is invalid.`);
        }
      }
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
    const entry = { ...value, package: UNPACKAGED_PACKAGE_ID };
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
    if ('format' in raw || 'id' in raw) {
      throw new Error(`${file} uses reserved per-entity Package manifest fields "format" or "id".`);
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
      addUnique(
        macroEntities,
        macroEntityPath(packageId, macroName),
        makeMacroEnvelope(packageId, { ...macroValue, name: macroName })
      );
    }
  }

  addUnique(
    packageManifests,
    packageManifestPath(UNPACKAGED_PACKAGE_ID),
    makePackageManifest(
      UNPACKAGED_PACKAGE_ID,
      'Unpackaged',
      'Legacy Entries without an assigned package.'
    )
  );
  const acceptCrashResidue = <T>(
    existing: Map<string, T>,
    expected: Map<string, T>,
    label: string
  ): void => {
    for (const [path, value] of existing) {
      if (!expected.has(path) || JSON.stringify(expected.get(path)) !== JSON.stringify(value)) {
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

export function assertWorkspaceDataWritable(config: unknown): void {
  const inspection = inspectWorkspaceData(config);
  if (inspection.status === 'missing') {
    throw new Error('.SNL_Doc/config.json does not exist.');
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
    targetVersion: '7' | '8'
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
