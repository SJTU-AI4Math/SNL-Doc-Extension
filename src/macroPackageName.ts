/** Strip one trailing `.json` suffix from a Macro Package filename. */
export function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
}
