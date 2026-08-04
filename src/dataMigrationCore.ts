export const CURRENT_DATA_VERSION = '0.0.5' as const;

export interface DataMigration<Context> {
  readonly from: string;
  readonly to: string;
  readonly description: string;
  migrate(context: Context): Promise<void>;
}

export interface DataMigrationReport<Context> {
  from: string;
  to: string;
  applied: readonly DataMigration<Context>[];
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseDataVersion(version: string): readonly [number, number, number] {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`Data version "${version}" is not strict SemVer (major.minor.patch).`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareDataVersions(left: string, right: string): number {
  const a = parseDataVersion(left);
  const b = parseDataVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function planDataMigrations<Context>(
  current: string,
  target: string,
  migrations: readonly DataMigration<Context>[]
): readonly DataMigration<Context>[] {
  const relation = compareDataVersions(current, target);
  if (relation > 0) {
    throw new Error(
      `Workspace data version ${current} is newer than supported version ${target}. ` +
      'Upgrade the SNL Doc Extension before opening or repairing this workspace.'
    );
  }
  if (relation === 0) return [];

  const bySource = new Map<string, DataMigration<Context>[]>();
  for (const migration of migrations) {
    if (compareDataVersions(migration.from, migration.to) >= 0) {
      throw new Error(
        `Migration ${migration.from} -> ${migration.to} must move forward.`
      );
    }
    const existing = bySource.get(migration.from) ?? [];
    existing.push(migration);
    bySource.set(migration.from, existing);
  }

  const plan: DataMigration<Context>[] = [];
  const visited = new Set<string>();
  let cursor = current;
  while (compareDataVersions(cursor, target) < 0) {
    if (visited.has(cursor)) {
      throw new Error(`Migration chain contains a cycle at ${cursor}.`);
    }
    visited.add(cursor);
    const candidates = bySource.get(cursor) ?? [];
    if (candidates.length === 0) {
      throw new Error(`No migration is registered from data version ${cursor}.`);
    }
    if (candidates.length > 1) {
      throw new Error(`Multiple migrations are registered from data version ${cursor}.`);
    }
    const step = candidates[0];
    if (compareDataVersions(step.to, target) > 0) {
      throw new Error(
        `Migration ${step.from} -> ${step.to} overshoots target version ${target}.`
      );
    }
    plan.push(step);
    cursor = step.to;
  }
  if (cursor !== target) {
    throw new Error(`Migration chain ended at ${cursor}, expected ${target}.`);
  }
  return plan;
}

export async function runDataMigrationChain<Context>(
  context: Context,
  plan: readonly DataMigration<Context>[],
  commitVersion: (version: string) => Promise<void>
): Promise<DataMigrationReport<Context>> {
  if (plan.length === 0) {
    return { from: CURRENT_DATA_VERSION, to: CURRENT_DATA_VERSION, applied: [] };
  }
  for (const migration of plan) {
    await migration.migrate(context);
    await commitVersion(migration.to);
  }
  return {
    from: plan[0].from,
    to: plan[plan.length - 1].to,
    applied: plan
  };
}
