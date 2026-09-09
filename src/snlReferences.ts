/**
 * Extract macro identifiers AND `x@foo` context-src target entry ids from
 * an SNL string. The scanner is a lightweight tokenizer that mirrors the
 * parser's identifier recognition without pulling the parser itself into
 * the host bundle.
 *
 * `macros`: bare identifiers used as macro references (used to look up
 *   `source.entries[]` for the "depends" auto-edge).
 * `contextSrcs`: the `<name>` in `x@<name>` postfixes — a direct
 *   entry-id reference (Stage 1 §src-postfix), used for the
 *   "uses_context" auto-edge (cat 2026-07-10).
 */
export function extractSnlReferences(
  snl: string
): { macros: string[]; contextSrcs: string[] } {
  const macros = new Set<string>();
  const contextSrcs = new Set<string>();
  if (!snl) return { macros: [], contextSrcs: [] };
  let i = 0;
  const n = snl.length;
  const isIdStart = (c: string): boolean => /[A-Za-z_.]/.test(c);
  const isIdCont = (c: string): boolean => /[A-Za-z0-9_.]/.test(c);
  while (i < n) {
    const c = snl[i];
    if (/\s|[(),\[\]]/.test(c)) { i += 1; continue; }
    if (c === '%') {
      i += 1;
      while (i < n && snl[i] !== '%') i += 1;
      i += 1;
      continue;
    }
    if (c === '$') {
      const isDisplay = snl[i + 1] === '$';
      const delim = isDisplay ? '$$' : '$';
      i += delim.length;
      while (i < n && snl.substr(i, delim.length) !== delim) i += 1;
      i += delim.length;
      continue;
    }
    if (c === '@') {
      // Bare `@foo` = binder introduction. Skip the following name — it's
      // a binding site, not a use.
      i += 1;
      if (i < n && (snl[i] === '%' || snl[i] === '$')) continue;
      while (i < n && isIdCont(snl[i])) i += 1;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdCont(snl[j])) j += 1;
      macros.add(snl.slice(i, j));
      i = j;
      if (i < n && snl[i] === '[') {
        while (i < n && snl[i] !== ']') i += 1;
        if (i < n) i += 1;
      }
      // `x@foo` src postfix: `x` was just collected as a macro name (a
      // false positive we accept — unregistered names produce no edge),
      // but the `@foo` chunk names a context-entry id and IS the
      // uses_context source ref.
      if (i < n && snl[i] === '@') {
        i += 1;
        const start = i;
        while (i < n && isIdCont(snl[i])) i += 1;
        if (i > start) contextSrcs.add(snl.slice(start, i));
      }
      continue;
    }
    i += 1;
  }
  return { macros: Array.from(macros), contextSrcs: Array.from(contextSrcs) };
}
