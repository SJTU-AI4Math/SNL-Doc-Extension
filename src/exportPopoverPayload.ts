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
export function encodePopoverJson(fragments: Record<string, string>): string {
  return JSON.stringify(fragments)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The complete script source assigning the payload to its global. */
export function buildPopoverScript(fragments: Record<string, string>): string {
  return `window.${POPOVER_GLOBAL} = ${encodePopoverJson(fragments)};\n`;
}
