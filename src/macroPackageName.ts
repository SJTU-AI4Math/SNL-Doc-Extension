import { validatePackageId } from './packageIdValidation';

/** Strip one trailing `.json` suffix from a Macro Package filename. */
export function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
}

/** Validate the bare Package ID or `<Package ID>.json` command argument. */
export function isSafeMacroPackageCommandArg(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return validatePackageId(stripJsonExt(value)) === null;
}
