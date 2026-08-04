# SNL Doc

A VS Code extension for SNL documentation with an Infoview webview panel.
It provides commands to initialize SNL projects, create libraries, entry
kinds and entries, and renders SNL content in React-based webview panels
(Infoview / Dashboard) using the shared `@sjtu-ai4math/snl-basics` rendering
library.

> _Screenshot placeholder — add an Infoview screenshot here._

## Install & build

```bash
npm install              # pulls @sjtu-ai4math/snl-basics from npm
npm run compile          # type-check + emit the extension (tsc -> ./out)
npm run build:webview    # build every webview bundle
```

Then launch the extension from VS Code (F5 / Run Extension). See
`package.json` for the full script list.

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
boundary and exposes only Macro v8 values at runtime. In v8, styles use
`style_name`, dynamic templates contain `#*` with optional `separator`, block
renderers use `block_template_name`, all templates are strings, and each macro
has a language-to-style `default_style` map. Implicit selection is current
language → English → `styles[0]`; explicit `[style]` always wins.
Any package write emits version `8`; plain-string older input is upgraded
without discarding consumer output backends or unknown extension fields. A v7
localized Macro template requires manual splitting because v8 cannot preserve
the language-dependent meaning of existing explicit `[style]` source.

## I18n and user preferences

Locale, theme, and motion preferences are VS Code Extension Settings and are
adapted to SNL-Basics through query-initialized `ReaderRuntime` instances.
Macro templates are invariant strings; natural-language variants are separate
styles selected by `default_style`. Non-SNL Entry content may still be an
invariant string or serialized language map. See [docs/i18n-preferences.md](docs/i18n-preferences.md)
for the ownership boundary, schema, hot-update protocol, and verification rules.

## Macro naming rule (enforced by SNL-Basics parser)

Macro names must match `[A-Za-z0-9_.]+`. No hyphens, no other punctuation.
This is because KaTeX's `\htmlData{name=...}` and `\htmlClass{...}` treat `-`
as binary minus and mangle the attribute value. Use camelCase for compound
suffixes: `DivRing.div.inlineDiv`, not `DivRing.div.inline-div`. The same
applies to `kind=` values and CSS classes handed to KaTeX (e.g.
`kind=argPlaceholder`, `\htmlClass{snlArgPlaceholder}`).
