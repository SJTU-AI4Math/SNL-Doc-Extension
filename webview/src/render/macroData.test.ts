import { describe, expect, it } from 'vitest';
import { createMacroDataDriver, type MacroRecord } from './macroData';

describe('createMacroDataDriver prototype-safe lookup', () => {
  it.each(['__proto__', 'constructor', 'toString', 'valueOf'])(
    'returns null for absent prototype-sensitive Macro name %s',
    async (name) => {
      const driver = createMacroDataDriver({});
      await expect(driver.query_macro({ macro_name: name })).resolves.toBeNull();
    }
  );

  it('returns an own prototype-sensitive Macro record', async () => {
    const macro = { name: '__proto__', dynamic_arity: false, styles: [] } as never;
    const record = Object.create(null) as MacroRecord;
    Object.defineProperty(record, '__proto__', {
      value: macro,
      enumerable: true,
      configurable: true,
      writable: true
    });
    const driver = createMacroDataDriver(record);
    await expect(driver.query_macro({ macro_name: '__proto__' })).resolves.toBe(macro);
  });
});
