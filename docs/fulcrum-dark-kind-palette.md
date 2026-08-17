# Fulcrum Notes recommended dark Kind palette

The `fulcrum-math-notes` Entry Kind preset is the reference dark palette for Fulcrum-style mathematical documents. It uses one neutral, opaque Entry surface and semantic strokes rather than tinting each whole card.

## Base roles

| Role | Color |
|---|---|
| Entry surface | `#313131` |
| Normal foreground | inherited from the host theme |
| Muted foreground | inherited from the host theme |
| Focus/selection | inherited from the host theme |

All visible Entry kinds use `#313131` as their dark background. Kind identity remains visible through the stroke, localized Kind label, style and counter; hue is never the only cue.

## Entry Kind strokes

| Kind | Dark stroke | Contrast on `#313131` |
|---|---:|---:|
| Chapter | `#E5E7EB` | 10.51:1 |
| Section | `#CBD5E1` | 8.76:1 |
| Subsection | `#94A3B8` | 5.07:1 |
| Definition | `#4ADE80` | 7.47:1 |
| Axiom | `#FACC15` | 8.49:1 |
| Theorem | `#60A5FA` | 5.12:1 |
| Lemma | `#93C5FD` | 7.21:1 |
| Corollary | `#7DD3FC` | 7.80:1 |
| Property | `#E879F9` | 5.29:1 |
| Remark | `#FB923C` | 5.75:1 |
| Example | `#C084FC` | 4.92:1 |
| Counterexample | `#FB7185` | 4.83:1 |
| Construction | `#A3A3A3` | 5.16:1 |
| Proof | `#D1D5DB` | 8.83:1 |
| Problem | `#38BDF8` | 6.07:1 |
| Context | `#A78BFA` | 4.78:1 |
| Constructor | `#A3E635` | 8.63:1 |

The result family is blue, structural prose is neutral, definitions are green, assumptions and syntax-like declarations are yellow, examples/context are violet, commentary is orange, and counterexamples are rose. Related kinds deliberately share a family and remain distinguished by labels and counters.

## Macro Kind strokes

The companion `snl-basics-defaults` palette uses the same `#313131` dark surface for visible semantic nodes:

| Macro Kind | Dark stroke |
|---|---:|
| Rule | `#4ADE80` |
| Constant | `#60A5FA` |
| Bound variable | `#C084FC` |
| Binder | `#FB923C` |
| Free variable | `#FB7185` |
| Partial/helper (`sub`) | inherited, transparent |

Partial/helper nodes remain unframed. Consumers using the legacy ID `partial` should treat it as the visual alias of `sub`.

## Consumer guidance

- Preserve the themed `{ light, dark }` coloring object through storage and host/webview protocols; resolve the active scheme only at render time.
- Existing workspaces are not migrated when a preset changes. They must update their own `.SNL_Doc/config.json` explicitly.
- Additional domain-specific kinds should keep background `#313131`, choose a stroke with at least 4.5:1 contrast, and retain a textual/non-color identity.
- High-contrast themes may override these authored colors with host system colors.
