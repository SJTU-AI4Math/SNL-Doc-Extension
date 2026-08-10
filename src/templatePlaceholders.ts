/** Escape-aware placeholder grammar shared by Macro v11 migration and previews. */
export function analyzeLatexTemplatePlaceholders(template: string): {
  positional_arity: number;
  variadic: boolean;
  invalid: boolean;
} {
  const escapedHash = '\u0001ESCAPED_HASH\u0001';
  const source = template.replace(/\\#/g, escapedHash);
  let maxIndex = -1;
  for (const match of source.matchAll(/#(\d{1,2})(?!\d)/g)) {
    maxIndex = Math.max(maxIndex, Number(match[1]));
  }
  return {
    positional_arity: maxIndex + 1,
    variadic: /#\*/.test(source),
    invalid: /#\d{3,}/.test(source)
  };
}
