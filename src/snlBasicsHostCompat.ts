/*
 * CommonJS host bridge for the ESM-only @sjtu-ai4math/snl-basics@0.2.1.
 * out/snl-basics-host.cjs is generated with esbuild from the package's
 * public root/core/runtime exports and must remain loadable by VS Code's
 * Node 20 Extension Host.
 */

export { analyzeLatexTemplatePlaceholders } from './templatePlaceholders';

type I18nValue<T> = {
  type: 'i18n';
  default_language: string;
  values: Record<string, T | undefined>;
};

export type Localized<_Language extends string, T> = T | I18nValue<T>;

interface HostBridge {
  isSnlIdentifier(value: string): boolean;
  migrateMacroDocument(
    document: Record<string, Record<string, unknown>>,
    options?: Record<string, unknown>
  ): Record<string, Record<string, unknown>>;
  migrateMacroV7toV8(
    macro: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Record<string, unknown> & { name: string };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bridge = require('../out/snl-basics-host.cjs') as HostBridge;

export const isSnlIdentifier = bridge.isSnlIdentifier;
export const migrateMacroDocument = bridge.migrateMacroDocument;
export const migrateMacroV7toV8 = bridge.migrateMacroV7toV8;

export class ReaderRuntime<T> {
  private readonly queries: { query_environment(): T };

  constructor(options: { queries: { query_environment(): T } }) {
    this.queries = options.queries;
  }

  query_environment(): T {
    return this.queries.query_environment();
  }

  run_reader<R>(reader: (environment: T) => R): R {
    return reader(this.query_environment());
  }
}
