import { describe, expect, it } from 'vitest';
import { parseSourceOptions, sourceRequestKey } from './options';

describe('source export request validation', () => {
  it('defaults off and never treats unchecked as enabled', () => {
    expect(parseSourceOptions(undefined).enabled).toBe(false);
    expect(() => parseSourceOptions({ enabled: 'yes' })).toThrow();
  });
  it('strictly checks budgets, root-relative rules and arrays', () => {
    for (const value of [{ maxFileBytes: 0 }, { maxTotalBytes: 1.2 }, { keep: '../secret' }, { keep: ['../secret'] }, { exclude: ['/root'] }, { scope: 'all' }, { allowedExternalRoots: [42] }]) {
      expect(() => parseSourceOptions({ enabled: true, ...value })).toThrow();
    }
    expect(parseSourceOptions({ enabled: true, keep: ['.lake/packages/mathlib/**'] }).keep).toEqual(['.lake/packages/mathlib/**']);
  });
  it('binds every filter, target, output shape and document capture to confirmation', () => {
    const opts = parseSourceOptions({ enabled: true });
    const key = sourceRequestKey(opts, '/tmp/a', 'directory', 'render-1');
    expect(sourceRequestKey({ ...opts, allowMissing: true }, '/tmp/a', 'directory', 'render-1')).not.toBe(key);
    expect(sourceRequestKey(opts, '/tmp/b', 'directory', 'render-1')).not.toBe(key);
    expect(sourceRequestKey(opts, '/tmp/a', 'single', 'render-1')).not.toBe(key);
    expect(sourceRequestKey(opts, '/tmp/a', 'directory', 'render-2')).not.toBe(key);
  });
});
