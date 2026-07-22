# SNL Doc

A VS Code extension for SNL documentation with an Infoview webview panel.
It provides commands to initialize SNL projects, create libraries, entry
kinds and entries, and renders SNL content in React-based webview panels
(Infoview / Dashboard) using the shared `@snl-basics/react` rendering
library.

> _Screenshot placeholder — add an Infoview screenshot here._

## Install & build

```bash
npm install              # see Development setup for first-time submodule steps
npm run compile          # type-check + emit the extension (tsc -> ./out)
npm run build:webview    # build every webview bundle
```

Then launch the extension from VS Code (F5 / Run Extension). See
`package.json` for the full script list.

## Dependencies

- [`react`](https://react.dev/) / `react-dom` (v19), [`katex`](https://katex.org/)
  for math rendering.
- **[SNL-Basics](https://github.com/SJTU-AI4Math/SNL-Basics)** — the shared
  SNL rendering library, consumed as `@snl-basics/react`. It is **vendored
  as a git submodule** at `external/SNL-Basics` and wired via
  `file:./external/SNL-Basics`, so a clone of this repo is self-contained and
  does not depend on a sibling checkout.

SNL-Basics is a separate library under active development. This extension
pins to a specific commit via the git submodule; to bump it, run:

```bash
cd external/SNL-Basics && git checkout main && git pull && cd ../.. \
  && git add external/SNL-Basics && git commit -m "chore: bump SNL-Basics submodule"
```

## Development setup

This repo depends on [SNL-Basics](https://github.com/SJTU-AI4Math/SNL-Basics)
(vendored as a git submodule at `external/SNL-Basics`). The
`@snl-basics/react` dependency resolves via `file:./external/SNL-Basics`,
which consumes the submodule's built `dist-lib/`.

### First-time clone

```bash
git clone --recurse-submodules git@github-snl-doc:SJTU-AI4Math/SNL-Doc-Extension.git
cd SNL-Doc-Extension
npm run setup-snl    # installs deps + builds dist-lib for the submodule
npm install          # now resolves @snl-basics/react correctly
```

### Or, if you cloned without --recurse-submodules

```bash
git clone git@github-snl-doc:SJTU-AI4Math/SNL-Doc-Extension.git
cd SNL-Doc-Extension
git submodule update --init --recursive
npm run setup-snl
npm install
```

> **Note:** `setup-snl` must run **before** `npm install` on a fresh clone,
> because `npm install` needs the submodule's `dist-lib/` to already exist to
> resolve the `file:./external/SNL-Basics` dependency. Use
> `npm run rebuild-snl` to force a rebuild of the submodule's `dist-lib/`.

### Updating SNL-Basics to a newer commit

```bash
cd external/SNL-Basics
git checkout main && git pull
cd ../..
git add external/SNL-Basics
git commit -m "chore: bump SNL-Basics submodule to <new-commit>"
```

## Troubleshooting

### The webview shows a stale library (macros look un-migrated)

The `@snl-basics/react` dependency is a **`file:` dependency** pointing at the
`external/SNL-Basics` submodule. The artifact actually loaded by the webview is
`external/SNL-Basics/dist-lib/index.js` — a **build artifact** produced by the
submodule's own `npm run build:lib`, and `.gitignore`'d inside the submodule.

Because it's a build artifact, pulling a new submodule pointer does **not**
rebuild it:

- `git submodule update` only moves the submodule's checked-out commit — it
  does **not** run `build:lib`, so `dist-lib/` stays whatever it was.
- VS Code's **F5 / Run Extension** builds the host + webview but does **not**
  recurse into the submodule, so it happily packs a stale `dist-lib/`.

The result is a webview that renders with an **old** copy of the library even
though the submodule pointer moved.

**Fix:** an auto-rebuild script (`scripts/rebuild-snl-basics.mjs`) keeps
`dist-lib/` fresh. It rebuilds when `dist-lib/index.js` is missing or older than
the submodule's `src/`, and is wired into:

- `postinstall` — every `npm install` freshens `dist-lib/`,
- `build:webview` — every F5 / webview pack freshens first,
- `compile` — the host TS build freshens first.

If you still see a stale library, force a rebuild and reload:

```bash
npm run snl:rebuild   # rebuilds dist-lib/ unconditionally (--force)
```

then run **Developer: Reload Window** in VS Code so the webview reloads the
freshly built library.

## Macro package schema

The extension reads historical macro packages through an explicit migration
boundary and exposes only Macro v7 values at runtime. In v7, styles use
`style_name`, dynamic templates contain `#*` with optional `separator`, block
renderers use `block_template_name`, and macro/style `tags` are required arrays.
Any package write emits version `7`; v6 input is upgraded without discarding
consumer output backends or unknown extension fields.

## Macro naming rule (enforced by SNL-Basics parser)

Macro names must match `[A-Za-z0-9_.]+`. No hyphens, no other punctuation.
This is because KaTeX's `\htmlData{name=...}` and `\htmlClass{...}` treat `-`
as binary minus and mangle the attribute value. Use camelCase for compound
suffixes: `DivRing.div.inlineDiv`, not `DivRing.div.inline-div`. The same
applies to `kind=` values and CSS classes handed to KaTeX (e.g.
`kind=argPlaceholder`, `\htmlClass{snlArgPlaceholder}`).
