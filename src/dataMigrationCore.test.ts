import { describe, expect, it, vi } from 'vitest';
import {
  CURRENT_DATA_VERSION,
  compareDataVersions,
  planDataMigrations,
  runDataMigrationChain,
  hasSplitEntityTopologyDataVersion,
  usesCurrentEntityStorageDataVersion,
  type DataMigration
} from './dataMigrationCore';

type Context = { applied: string[] };

const migration = (from: string, to: string): DataMigration<Context> => ({
  from,
  to,
  description: `${from} -> ${to}`,
  migrate: async (context) => { context.applied.push(`${from}->${to}`); }
});

const chain = [
  migration('0.0.1', '0.0.2'),
  migration('0.0.2', '0.0.3'),
  migration('0.0.3', '0.0.4')
];

describe('data migration core', () => {
  it('uses strict SemVer ordering for workspace data versions', () => {
    expect(CURRENT_DATA_VERSION).toBe('0.1.0');
    expect(compareDataVersions('0.0.3', '0.0.4')).toBeLessThan(0);
    expect(compareDataVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(() => compareDataVersions('7', '0.0.4')).toThrow(/SemVer/);
  });

  it('distinguishes split topology from the current readable payload generation', () => {
    expect(hasSplitEntityTopologyDataVersion('0.0.5')).toBe(false);
    expect(hasSplitEntityTopologyDataVersion('0.0.6')).toBe(true);
    expect(hasSplitEntityTopologyDataVersion('0.0.10')).toBe(true);
    expect(hasSplitEntityTopologyDataVersion('0.0.11')).toBe(true);
    expect(hasSplitEntityTopologyDataVersion('0.1.0')).toBe(true);
    expect(hasSplitEntityTopologyDataVersion('0.2.0')).toBe(false);

    expect(usesCurrentEntityStorageDataVersion('0.0.10')).toBe(false);
    expect(usesCurrentEntityStorageDataVersion('0.0.11')).toBe(true);
    expect(usesCurrentEntityStorageDataVersion('0.1.0')).toBe(true);
    expect(usesCurrentEntityStorageDataVersion('0.2.0')).toBe(false);
  });

  it('plans a contiguous chain from any supported older version', () => {
    expect(planDataMigrations('0.0.1', '0.0.4', chain).map((step) => step.to))
      .toEqual(['0.0.2', '0.0.3', '0.0.4']);
    expect(planDataMigrations('0.0.3', '0.0.4', chain).map((step) => step.to))
      .toEqual(['0.0.4']);
    expect(planDataMigrations('0.0.4', '0.0.4', chain)).toEqual([]);
  });

  it('rejects future, missing, branching, backwards and cyclic chains', () => {
    expect(() => planDataMigrations('0.0.5', '0.0.4', chain)).toThrow(/newer/);
    expect(() => planDataMigrations('0.0.1', '0.0.4', [chain[0], chain[2]]))
      .toThrow(/No migration/);
    expect(() => planDataMigrations('0.0.1', '0.0.4', [chain[0], migration('0.0.1', '0.0.3')]))
      .toThrow(/Multiple migrations/);
    expect(() => planDataMigrations('0.0.2', '0.0.4', [migration('0.0.2', '0.0.1')]))
      .toThrow(/move forward/);
    expect(() => planDataMigrations('0.0.1', '0.0.4', [
      migration('0.0.1', '0.0.2'),
      migration('0.0.2', '0.0.1')
    ])).toThrow(/move forward|cycle/);
  });

  it('runs every step in order and commits its version only after the step succeeds', async () => {
    const context: Context = { applied: [] };
    const committed: string[] = [];
    const report = await runDataMigrationChain(
      context,
      planDataMigrations('0.0.1', '0.0.4', chain),
      async (version) => { committed.push(version); }
    );
    expect(context.applied).toEqual(['0.0.1->0.0.2', '0.0.2->0.0.3', '0.0.3->0.0.4']);
    expect(committed).toEqual(['0.0.2', '0.0.3', '0.0.4']);
    expect(report).toEqual({ from: '0.0.1', to: '0.0.4', applied: chain });
  });

  it('does not commit a failed migration version or run later steps', async () => {
    const bad = migration('0.0.2', '0.0.3');
    bad.migrate = vi.fn(async () => { throw new Error('broken data'); });
    const context: Context = { applied: [] };
    const committed: string[] = [];
    await expect(runDataMigrationChain(
      context,
      [chain[0], bad, chain[2]],
      async (version) => { committed.push(version); }
    )).rejects.toThrow(/broken data/);
    expect(committed).toEqual(['0.0.2']);
    expect(context.applied).toEqual(['0.0.1->0.0.2']);
  });
});
