const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Resolve an Entry Markdown image path inside `.SNL_Doc/assets/`.
 *
 * Accepted author spellings are relative to the asset root:
 * - `diagram.png`
 * - `assets/diagram.png`
 * - `.SNL_Doc/assets/diagram.png`
 *
 * Absolute/data URLs are left alone. Parent traversal is deliberately rejected
 * so Markdown cannot escape the webview's asset-only localResourceRoot.
 */
export function resolveMarkdownAssetUrl(source: string, assetBaseUri: string): string {
  if (!source || !assetBaseUri) return source;
  if (ABSOLUTE_SCHEME.test(source) || source.startsWith('//') || source.startsWith('#')) {
    return source;
  }

  const suffixIndex = source.search(/[?#]/);
  const rawPath = suffixIndex >= 0 ? source.slice(0, suffixIndex) : source;
  const suffix = suffixIndex >= 0 ? source.slice(suffixIndex) : '';
  let path = rawPath.replace(/^\.\//, '');
  path = path.replace(/^\.SNL_Doc\/assets\//, '').replace(/^assets\//, '');
  const segments = path.split('/');
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '..')) {
    return source;
  }
  const encoded = segments.map((segment) => {
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      return encodeURIComponent(segment);
    }
  }).join('/');
  return `${assetBaseUri.replace(/\/$/, '')}/${encoded}${suffix}`;
}
