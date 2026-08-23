// Serialise pre-rendered popover fragments into a script the exported page can
// load.
//
// Why a `<script>` and not a JSON file the runtime fetches: an exported
// directory is opened straight off disk, and `fetch('popovers.json')` under
// `file://` is blocked as a cross-origin request in every current browser. A
// script tag has no such restriction, so BOTH export shapes use one — the
// directory shape points at `popovers.js`, the inline shape folds that exact
// same source into the document (see `inlineScripts` in exportDocument.ts).

/** Global the exported runtime reads its popover fragments from. */
export const POPOVER_GLOBAL = '__SNL_POPOVERS__';

/** Global carrying every locale/theme rendering for an interactive export. */
export const VARIANTS_GLOBAL = '__SNL_EXPORT_VARIANTS__';

/** Filename used by the directory shape. */
export const POPOVER_SCRIPT_PATH = 'popovers.js';

/**
 * JSON, hardened for embedding inside an HTML `<script>` element.
 *
 * The payload is HTML markup, so it is full of `<` and `>`. Three hazards,
 * all fixed by escaping at the JSON level (where `\uXXXX` is legal inside a
 * string literal and round-trips to the identical value):
 *
 *   - `</script>` would terminate the element early;
 *   - `<!--` starts an HTML comment, which the script parser also honours and
 *     which can swallow the rest of the payload;
 *   - U+2028 / U+2029 are literal line terminators in JavaScript (though not
 *     in JSON), so an Entry containing one would be a syntax error.
 *
 * Escaping every `<` and `>` covers the first two without having to reason
 * about which spellings a parser accepts.
 */
function encodeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function encodePopoverJson(fragments: Record<string, string>): string {
  return encodeScriptJson(fragments);
}

/** Parse JSON text so prototype-shaped keys remain ordinary own properties. */
function parsedJsonExpression(value: unknown): string {
  return `JSON.parse(${encodeScriptJson(encodeScriptJson(value))})`;
}

export interface ExportDocumentVariant {
  locale: string;
  languageLabel: string;
  colorScheme: 'light' | 'dark';
  title: string;
  subtitle?: string;
  body: string;
  /** Localized titles for the in-memory Entry index used by route sections. */
  entryTitles?: Record<string, string>;
  popovers: Record<string, string>;
}

export interface ExportRelationshipData {
  id: string;
  from: string;
  to: string;
  label: string;
  metadata: unknown;
}

/** All renderings captured from the live Extension surface. */
export interface ExportDocumentVariants {
  initialLocale: string;
  initialColorScheme: 'light' | 'dark';
  /** One shared graph; sections are derived by Entry id at route time. */
  relationships?: ExportRelationshipData[];
  variants: ExportDocumentVariant[];
}

/** The complete script source assigning the payload to its global. */
export function buildPopoverScript(fragments: Record<string, string>): string {
  return `window.${POPOVER_GLOBAL} = ${parsedJsonExpression(fragments)};\n`;
}

/** One file-safe sidecar initializes both default popovers and render variants. */
export function buildExportPayloadScript(
  fragments: Record<string, string>,
  variants?: ExportDocumentVariants
): string {
  return `window.${POPOVER_GLOBAL} = ${parsedJsonExpression(fragments)};\n` +
    `window.${VARIANTS_GLOBAL} = ${variants ? parsedJsonExpression(variants) : 'null'};\n`;
}
