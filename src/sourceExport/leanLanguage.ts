import type { languages } from 'monaco-editor/esm/vs/editor/editor.api';

/** Original, MIT-licensed lexical Monarch grammar. No TextMate/LSP dependency.
 * Lean identifiers include Unicode letters, combining marks and sub/superscripts.
 * This is deliberately lexical: tactics are keywords, not semantic tokens.
 */
export const leanLanguage: languages.IMonarchLanguage = {
  defaultToken: '', tokenPostfix: '.lean', unicode: true,
  keywords: ('import prelude namespace end section variable variables universe universes ' +
    'def abbrev theorem lemma example axiom opaque constant constants inductive coinductive ' +
    'structure class instance deriving where extends mutual private protected public noncomputable ' +
    'unsafe partial local scoped open export attribute set_option in include omit ' +
    'syntax macro macro_rules elab elab_rules notation infix infixl infixr prefix postfix ' +
    'if then else match with let have show from by fun forall do return for while ' +
    'try catch finally unless break continue Type Prop Sort true false ' +
    'rfl exact apply intro intros refine cases rcases induction constructor left right ' +
    'simp simpa rw rfl aesop decide omega linarith nlinarith ring norm_num ' +
    'assumption contradiction trivial calc obtain suffices sorry done repeat first all_goals').split(' '),
  tokenizer: {
    root: [
      [/\s+/, 'white'],
      [/--.*$/, 'comment'],
      [/\/-/, 'comment', '@comment'],
      [/"/, 'string', '@string'],
      [/«[^»]*»/, 'identifier'],
      [/#(?:check|eval|print|reduce|synth|guard|help|exit)\b/, 'keyword'],
      [/[\p{L}_][\p{L}\p{N}\p{M}_'!?₀-₉⁰-⁹]*/u, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/[∀∃λ→←↔⇒⟨⟩⊢∧∨¬∈∉⊆≤≥≠ℕℤℚℝ]+/, 'operator'],
      [/[=:+*\-\/<>|&!%^~?]+/, 'operator'],
      [/[.,;]/, 'delimiter']
    ],
    comment: [
      [/\/-/, 'comment', '@push'], [/-\//, 'comment', '@pop'],
      [/[^/\-]+/, 'comment'], [/[\/\-]/, 'comment']
    ],
    string: [
      [/[^\\"]+/, 'string'], [/\\(?:[nrt0\\"']|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/, 'string.escape'],
      [/\\./, 'string.escape.invalid'], [/"/, 'string', '@pop']
    ]
  }
};
export function registerLean(monaco: Pick<typeof import('monaco-editor/esm/vs/editor/editor.api'), 'languages'>): void {
  monaco.languages.register({ id: 'lean4', extensions: ['.lean'], aliases: ['Lean', 'Lean 4'] });
  monaco.languages.setMonarchTokensProvider('lean4', leanLanguage);
  monaco.languages.setLanguageConfiguration('lean4', {
    comments: { lineComment: '--', blockComment: ['/-', '-/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')'], ['⟨', '⟩']],
    folding: { offSide: true }
  });
}
