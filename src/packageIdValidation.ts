export type PackageIdValidationCode = 'invalid-format' | 'reserved-windows-name';

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const UNPACKAGED_PACKAGE_ID = '_unpackaged';

/** Validate a Package identity using Windows filename semantics on every host OS. */
export function validatePackageId(packageId: string): PackageIdValidationCode | null {
  if (packageId !== UNPACKAGED_PACKAGE_ID &&
      (!PACKAGE_ID_RE.test(packageId) || packageId.toLowerCase().endsWith('.json'))) {
    return 'invalid-format';
  }
  return WINDOWS_DEVICE_RE.test(packageId) ? 'reserved-windows-name' : null;
}
