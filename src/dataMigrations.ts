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
  legacy005EntryEntityPath,
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

export function isEntityStorageReceipt(value: unknown): value is EntityStorageReceipt {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    'legacy_backup_present', 'legacy_entries_present', 'entry_count',
    'macro_package_count', 'macro_count', 'entries_digest', 'macro_packages_digest'
  ];
  if (Object.keys(value).length !== expectedKeys.length ||
      !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return false;
  }
  return typeof value.legacy_backup_present === 'boolean' &&
    typeof value.legacy_entries_present === 'boolean' &&
    Number.isSafeInteger(value.entry_count) && (value.entry_count as number) >= 0 &&
    Number.isSafeInteger(value.macro_package_count) && (value.macro_package_count as number) >= 0 &&
    Number.isSafeInteger(value.macro_count) && (value.macro_count as number) >= 0 &&
    typeof value.entries_digest === 'string' && /^[0-9a-f]{64}$/.test(value.entries_digest) &&
    typeof value.macro_packages_digest === 'string' && /^[0-9a-f]{64}$/.test(value.macro_packages_digest);
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
  canonicalizeMacroPackage(file: string, raw: unknown): unknown;
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
    const canonical = context.canonicalizeMacroPackage(file, raw);
    if (!isRecord(canonical) || canonical.version !== '7' || !isRecord(canonical.macros)) {
      throw new Error(`${file} did not canonicalize to a v7 keyed Macro package.`);
    }
    const source = isRecord(raw) && isRecord(raw.macros) ? raw.macros : null;
    const containsLegacyStyleSiblings = source !== null && Object.values(source).some(
      (value) => isRecord(value) && 'katex_react' in value && !Array.isArray(value.styles)
    );
    if (source && !containsLegacyStyleSiblings) {
      const before = Object.keys(source).sort();
      const after = Object.keys(canonical.macros).sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(`${file} Macro identities changed during canonicalization.`);
      }
    }
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

function migrate004To005(context: WorkspaceMigrationContext): void {
  const data = context.data;
  if (Object.prototype.hasOwnProperty.call(data.config, 'entity_storage')) {
    throw new Error('config.json#entity_storage is reserved by workspace data version 0.0.5.');
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
      legacy005EntryEntityPath(UNPACKAGED_PACKAGE_ID, value.id),
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
    if (!isRecord(raw) || raw.version !== '7' || !isRecord(raw.macros)) {
      throw new Error(`${file} must be a canonical v7 keyed Macro package before migration.`);
    }
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
    legacy_backup_version: '0.0.4',
    entry_default_package: UNPACKAGED_PACKAGE_ID,
    receipt: makeEntityStorageReceipt(data.entries, data.macroPackages, true)
  };
}

function migrate005To006(context: WorkspaceMigrationContext): void {
  const data = context.data;
  const storage = object(data.config.entity_storage);
  if (storage.version !== 1 || storage.legacy_backup_version !== '0.0.4' ||
      storage.entry_default_package !== UNPACKAGED_PACKAGE_ID ||
      storage.entry_path_version !== undefined || !isEntityStorageReceipt(storage.receipt)) {
    throw new Error('config.json#entity_storage has invalid 0.0.5 metadata or receipt.');
  }
  const expectedReceipt = makeEntityStorageReceipt(
    data.entries,
    data.macroPackages,
    data.entries !== null && data.entries !== undefined || data.macroPackages.size > 0
  );
  if (JSON.stringify(storage.receipt) !== JSON.stringify(expectedReceipt)) {
    throw new Error('config.json#entity_storage receipt does not match the frozen legacy backup.');
  }

  const packageIds = new Set<string>();
  const packageIdsByFold = new Map<string, string>();
  const manifestPathsByFold = new Set<string>();
  for (const [path, manifest] of data.packageManifests) {
    if (!isRecord(manifest) || manifest.format !== 'snl-package' || manifest.version !== 1 ||
        typeof manifest.id !== 'string' || typeof manifest.name !== 'string' ||
        typeof manifest.description !== 'string') {
      throw new Error(`${path} is not a valid Package manifest.`);
    }
    assertPackageId(manifest.id);
    if (path !== packageManifestPath(manifest.id)) {
      throw new Error(`${path} does not match Package ${JSON.stringify(manifest.id)}.`);
    }
    const foldedId = manifest.id.toLowerCase();
    const priorId = packageIdsByFold.get(foldedId);
    if (priorId) {
      throw new Error(`Package IDs ${JSON.stringify(priorId)} and ${JSON.stringify(manifest.id)} case-fold collide.`);
    }
    const foldedPath = path.toLowerCase();
    if (manifestPathsByFold.has(foldedPath)) {
      throw new Error(`Package manifest path ${JSON.stringify(path)} case-fold collides.`);
    }
    packageIdsByFold.set(foldedId, manifest.id);
    manifestPathsByFold.add(foldedPath);
    packageIds.add(manifest.id);
  }
  if (!packageIds.has(UNPACKAGED_PACKAGE_ID)) {
    throw new Error('0.0.5 topology is missing the _unpackaged Package manifest.');
  }

  const rawActive = data.config.active_macro_packages;
  if (!Array.isArray(rawActive) || !rawActive.every((value) => typeof value === 'string')) {
    throw new Error('config.json#active_macro_packages must be an array of Package ID strings.');
  }
  const activeByFold = new Map<string, string>();
  for (const packageId of rawActive as string[]) {
    if (packageId !== packageId.trim()) {
      throw new Error('config.json#active_macro_packages contains a whitespace-padded Package ID.');
    }
    assertPackageId(packageId);
    if (packageId === UNPACKAGED_PACKAGE_ID || !packageIds.has(packageId)) {
      throw new Error(`Active Macro Package ${JSON.stringify(packageId)} has no Package manifest.`);
    }
    const folded = packageId.toLowerCase();
    const prior = activeByFold.get(folded);
    if (prior) {
      throw new Error(`Active Package IDs ${JSON.stringify(prior)} and ${JSON.stringify(packageId)} duplicate or case-fold collide.`);
    }
    activeByFold.set(folded, packageId);
  }

  for (const [path, envelope] of data.macroEntities) {
    if (!isRecord(envelope) || envelope.format !== 'snl-macro' || envelope.version !== 1 ||
        typeof envelope.package !== 'string' || !isRecord(envelope.macro) ||
        typeof envelope.macro.name !== 'string' || !envelope.macro.name) {
      throw new Error(`${path} is not a valid 0.0.5 Macro envelope.`);
    }
    assertPackageId(envelope.package);
    if (envelope.macro.name !== envelope.macro.name.trim()) {
      throw new Error(`${path} Macro name has leading or trailing whitespace.`);
    }
    if (!packageIds.has(envelope.package)) {
      throw new Error(`${path} Macro references missing Package ${JSON.stringify(envelope.package)}.`);
    }
    if (path !== macroEntityPath(envelope.package, envelope.macro.name)) {
      throw new Error(`${path} does not match its Macro identity path.`);
    }
  }

  const byId = new Map<string, EntryEnvelope>();
  const migrated = new Map<string, EntryEnvelope>();
  for (const [path, envelope] of data.entryEntities) {
    if (!isRecord(envelope) || envelope.format !== 'snl-entry' || envelope.version !== 1 ||
        typeof envelope.package !== 'string' || !isRecord(envelope.entry) ||
        typeof envelope.entry.id !== 'string' || !envelope.entry.id) {
      throw new Error(`${path} is not a valid 0.0.5 Entry envelope.`);
    }
    assertPackageId(envelope.package);
    if (envelope.entry.id !== envelope.entry.id.trim()) {
      throw new Error(`${path} Entry ID has leading or trailing whitespace.`);
    }
    if (!packageIds.has(envelope.package)) {
      throw new Error(`${path} Entry references missing Package ${JSON.stringify(envelope.package)}.`);
    }
    if (envelope.entry.package !== envelope.package) {
      throw new Error(`${path} Entry package disagrees with its envelope.`);
    }
    const oldPath = legacy005EntryEntityPath(envelope.package, envelope.entry.id);
    const nextPath = entryEntityPath(envelope.entry.id);
    if (path !== oldPath && path !== nextPath) {
      throw new Error(`${path} does not match the 0.0.5 or 0.0.6 Entry identity path.`);
    }
    const prior = byId.get(envelope.entry.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(envelope)) {
      throw new Error(`Conflicting crash residue for Entry ${JSON.stringify(envelope.entry.id)}.`);
    }
    byId.set(envelope.entry.id, envelope as unknown as EntryEnvelope);
  }
  for (const [entryId, envelope] of byId) {
    addUnique(migrated, entryEntityPath(entryId), envelope);
  }
  data.entryEntities.clear();
  for (const [path, envelope] of migrated) data.entryEntities.set(path, envelope);
  data.config.entity_storage = { ...storage, entry_path_version: 2 };
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
    description: 'Split aggregate Entries and Macros into stable per-entity package storage.',
    migrate: async (context) => { migrate004To005(context); }
  },
  {
    from: '0.0.5',
    to: '0.0.6',
    description: 'Rename Entry entities to globally stable Entry-ID hash paths.',
    migrate: async (context) => { migrate005To006(context); }
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

function cloneSnapshot(source: WorkspaceDataSnapshot): WorkspaceDataSnapshot {
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
  canonicalizeMacroPackage: (file: string, raw: unknown) => unknown
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
  const working = cloneSnapshot(source);
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
