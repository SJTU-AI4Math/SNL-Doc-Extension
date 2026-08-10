# SNL Doc

A VS Code extension for SNL documentation with an Infoview webview panel.
It provides commands to initialize SNL projects, create libraries, entry
kinds and entries, and renders SNL content in React-based webview panels
(Infoview / Dashboard) using the shared `@sjtu-ai4math/snl-basics` rendering
library.

The extension ships separate reading, management, search, graph, authoring,
and HTML-export surfaces; see [`docs/extension-feature-inventory.md`](docs/extension-feature-inventory.md)
for the current command and panel inventory.

## Install & build

```bash
npm install              # pulls @sjtu-ai4math/snl-basics from npm
npm run compile          # type-check + emit the extension (tsc -> ./out)
npm run build:webview    # build every webview bundle
```

Then launch the extension from VS Code (F5 / Run Extension). See
`package.json` for the full script list.

## Kind preset packages

The Initialize Entry/Macro Kinds panels load extension resources from
`resources/kind-presets/{entry,macro}/*.json`. Each preset is an independently
versioned `snl-doc.kind-preset` package with an explicit domain, stable id,
localized-copy keys, and a non-empty kind catalog. The host validates every
package and fails closed on invalid JSON, schema/version/domain mismatches, or
duplicate preset/kind ids; presets are exposed in deterministic id order and
can only initialize an empty workspace catalog.

Shipped Entry Kind catalogs cover Fulcrum math notes, Lean 4, TypeScript, and
Python. The Macro Kind catalog intentionally remains the SNL-Basics defaults;
language-specific macro catalogs are not included without a concrete SNL macro
semantics mapping.

## Entry authoring and relationships

- Entry source editing uses a lazily loaded Monaco editor. SNL formatting is
  provided by `SnlDslFormatter`; indentation and inline-parenthesis depth are
  configurable in Extension Settings. `Ctrl/Cmd+S` saves and `Shift+Alt+F`
  formats SNL.
- `contribution_info` is currently one optional Contributor string. The UI and
  schema comments mark this as temporary because the Contributor shape will
  change in a future data version. Structured values written by older builds
  remain readable and survive unrelated edits; new/replacement values must be
  scalar.
- Every successful Entry save synchronously reconciles that Entry's
  system-owned `depends` rows. `uses_context`, user-authored relationships,
  foreign generators, and every other label are preserved unchanged.
- Single-Entry Infoview groups all touching relationships by label and
  direction, keeps the Entry body usable when relationship storage is corrupt,
  and records an explicit return route with a containing-Library fallback.
- Relationship Graph layout clusters Entries by Package. Theme-wide color
  refinement remains a separate planned task.

## Dependencies

- [`react`](https://react.dev/) / `react-dom` (v19), [`katex`](https://katex.org/)
  for math rendering.
- **[SNL-Basics](https://github.com/SJTU-AI4Math/SNL-Basics)** — the shared
  SNL rendering library, consumed as the published npm package
  [`@sjtu-ai4math/snl-basics`](https://www.npmjs.com/package/@sjtu-ai4math/snl-basics).
  It ships a prebuilt `dist-lib/`, so `npm install` is all you need — there is
  no submodule, no local library build, and no sibling checkout.

## Development setup

### First-time clone

```bash
git clone git@github-snl-doc:SJTU-AI4Math/SNL-Doc-Extension.git
cd SNL-Doc-Extension
npm install
npm run compile
npm run build:webview
```

Or just `npm run bootstrap` (also wired to VS Code's F5 default build task),
which does install + compile + webview build with per-step staleness checks.

### Updating SNL-Basics

It is an ordinary dependency now:

```bash
npm install @sjtu-ai4math/snl-basics@latest
git add package.json package-lock.json
git commit -m "chore: bump @sjtu-ai4math/snl-basics"
```

### Developing SNL-Basics and the extension together

When you need to iterate on the library and see it here before publishing,
link a local checkout instead of re-adding a submodule:

```bash
cd path/to/SNL-Basics
npm run build:lib
npm link
cd path/to/SNL-Doc-Extension
npm link @sjtu-ai4math/snl-basics
```

Rerun `npm run build:lib` in SNL-Basics after each change (the extension loads
`dist-lib/`, not `src/`). Undo with `npm unlink @sjtu-ai4math/snl-basics &&
npm install`.

## Troubleshooting

### The webview shows a stale library (macros look un-migrated)

The webview bundles whatever `node_modules/@sjtu-ai4math/snl-basics/dist-lib/`
contains at build time, so a stale render means either the installed version is
old or the bundle predates the install.

```bash
npm ls @sjtu-ai4math/snl-basics        # what is actually installed
npm install @sjtu-ai4math/snl-basics@latest
npm run build:webview                  # rebuild the bundles against it
```

Then run **Developer: Reload Window** in VS Code so the webview reloads.

If you are using `npm link` for local library development, remember the
extension loads `dist-lib/`, not `src/` — rerun `npm run build:lib` in the
SNL-Basics checkout, then `npm run build:webview` here.

## Macro package schema

The extension reads historical macro packages through an explicit migration
boundary and exposes only Macro v11 values at runtime. A v11 Style contains
exactly `style_name`, invariant `tags`, and `template`. The template is either
one complete TemplateSpec or an I18N map of complete TemplateSpecs, so locale
atomically selects `mode`, `body`, `separator`, `block_template_name`, output
backends, and presentation extensions without changing Style identity. All
projections within one localized Style have the same positional arity contract;
different explicit Styles may intentionally use different arities. Every Macro
has a non-empty semantic `kind`, `styles[0]` is the sole implicit default, and
explicit `[style]` always wins.

Any package write emits version `11`. Historical v1–v10 input is upgraded
without discarding consumer output backends or unknown extension fields.
Published-v8 language-to-Style defaults become one synthetic localized default
Style while every original named Style remains available to explicit source.
Unrepresentable maps, including selected Styles with divergent invariant tags,
abort migration rather than inventing merged metadata. Missing kinds become
`const`, persisted `partial` becomes `sub`, and other non-empty kinds are
preserved. Macro and style names use SNL-Basics' shared Unicode
identifier policy: visible non-ASCII is accepted broadly, while ASCII
punctuation outside the grammar allow-list and invisible Unicode controls are
rejected.

## I18n and user preferences

Locale, theme, and motion preferences are VS Code Extension Settings and are
adapted to SNL-Basics through query-initialized `ReaderRuntime` instances.
Macro TemplateSpecs and non-SNL Entry content may be invariant or serialized
language maps. A localized Macro value always contains complete TemplateSpecs;
it never localizes only one render field.
See [docs/i18n-preferences.md](docs/i18n-preferences.md) for the ownership boundary, schema, hot-update protocol, and verification rules.

## Macro naming rule (enforced by SNL-Basics parser)

Macro names are accepted only when `@sjtu-ai4math/snl-basics/core` reports a
valid SNL identifier. This is a Unicode-aware grammar, not an ASCII regular
expression: visible non-ASCII identifiers and grammar-supported punctuation
are valid, while whitespace, invisible controls, and SNL syntax delimiters in
identifier positions are rejected. Consumers must call the shared parser
rather than duplicating or narrowing its policy.
