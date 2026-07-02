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
npm run build:webview    # build all 6 webview bundles (main, createLibrary,
                         # dashboard, initEntryKinds, createEntryKind, createEntry)
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
