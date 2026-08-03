# I18n and query-injected preferences

SNL-Doc-Extension consumes the host-agnostic `ReaderM` / `ReaderRuntime` API
from SNL-Basics. SNL-Basics never reads VS Code settings, browser globals, or
workspace files. The extension supplies those capabilities through query
functions.

## Extension settings

- `snlDoc.locale`: `auto | en | zh-CN`
- `snlDoc.appearance.theme`: `auto | light | dark | high-contrast | high-contrast-light`
- `snlDoc.appearance.motion`: `auto | full | reduced`

`auto` language follows `vscode.env.language`; supported Simplified Chinese
locale aliases normalize to `zh-CN`, and unsupported locales fall back to `en`.
The automatic color scheme follows `vscode.window.activeColorTheme`.

`PreferencesHost` owns the single VS Code configuration/theme listener. Every
webview created through `buildPanelHtml` is registered with that host. Initial
preferences are embedded as `<html lang>` and `data-snl-*` attributes, so a
webview never depends on an early message that may be missed. Later changes are
broadcast as revisioned `snl.preferences/snapshot` messages. Each Webview also
sends `snl.preferences/ready` after installing its listener and receives a fresh
snapshot, closing the bootstrap read/register race. The Host retains Webviews
through `WeakRef` rather than extending closed-panel lifetimes.

The webview runtime updates the document attributes and notifies React through
`useSyncExternalStore`. Its `ReaderRuntime` queries the current document language
on every run; it does not cache a stale bootstrap value. Explicit color-scheme
settings update the page surface; reduced motion disables transitions,
animations, smooth scrolling, and press transforms.

## Serialized localized strings

A language-invariant string remains a plain JSON string. A localized string is:

```json
{
  "type": "i18n",
  "default_language": "en",
  "values": {
    "en": "Definition",
    "zh-CN": "定义"
  }
}
```

The fallback order is current language, `default_language`, then the first
available value. Empty/malformed maps are rejected at persistence boundaries.

Supported project fields:

- Text-mode Macro style `template`
- Entry `content.typst`
- Entry `content.latex`
- Entry `content.markdown`
- Entry `content.text`

Language-invariant fields remain strings:

- Entry `content.snl`
- Formula and block Macro templates
- IDs, slugs, Macro names, command IDs, paths, and schema keys

Entry and Macro editors retain the complete language map. Editing changes the
current language projection and merges it back into the original map on save;
it does not flatten or delete the other translations. An unedited fallback
projection is never materialized as a translation for the current locale.
Switching locale while an editor is open stores only an actually edited
projection before loading the new one. Watcher refreshes do not overwrite dirty
drafts, and destructive Text-to-Formula/Block conversion requires confirmation.

## Shared panel header and language selection

Every React webview entry renders the shared `PanelHeader`. The component owns:

- the parameterized panel title and optional subtitle;
- parent/Infoview navigation and panel-specific action slots;
- the SJTU AI4Math logo/name watermark;
- the built-in language selector.

The selector exposes `auto`, `zh-CN` and `en`. `auto` is a normal selectable
menu item rather than a disabled placeholder, so the user can return to following
VS Code without opening Settings. Country marks are inline SVG, not Unicode emoji,
so their rendering does not depend on an emoji font. The selector posts the global
`snl.preferences/set-language` message; `PreferencesHost` validates the locale,
updates `snlDoc.locale`, and the existing configuration broadcast updates every
open panel. Logo Webview URIs are embedded in the initial `<html>` attributes by
`buildPanelHtml`, avoiding a per-panel asset protocol.

## Independent language packs (future)

Mature desktop software normally gives a language pack a **declarative catalog
format**: a versioned manifest plus one or more JSON message catalogs. UI source
uses stable message IDs; the runtime loads the selected catalog, overlays it on
the built-in English catalog, and falls back by locale (`zh-Hans-CN` → `zh-Hans`
→ `en`) when a key is absent. Catalogs are schema-validated and isolated by
application/API version.

The container still matters: a third-party VS Code extension may declare
`main`/`browser` and activation events, so installing it is not equivalent to
installing inert data. SNL Doc's loader should never activate or call a pack API;
it should only read validated JSON paths resolved beneath that extension's
`extensionUri`. Validation must cap catalog bytes, message count and string size,
reject path traversal/symlink escape, and ignore executable/resource URLs.

For VS Code there are two separate localization surfaces:

1. Static extension-manifest strings (`package.json` commands/settings) are
   resolved by VS Code through `package.nls*.json` before this extension runs.
   They cannot be replaced dynamically by the Webview runtime.
2. Runtime Webview strings can use independent language-pack extensions. A pack
   extension can advertise custom top-level `snlDocLanguagePack` metadata in
   its `package.json`; SNL Doc can discover it through `vscode.extensions.all`,
   inspect `extension.packageJSON`, read catalog JSON relative to the pack's
   `extensionUri`, validate it, and broadcast the catalog and available-locale
   metadata to open Webviews. This must **not** be invented as a new
   `contributes.*` point: ordinary extensions cannot register arbitrary VS Code
   contribution points.

A proposed pack manifest is deliberately small:

```json
{
  "locale": "fr-FR",
  "displayName": "Français (France)",
  "fallback": "en",
  "catalogVersion": 1,
  "messages": "locales/fr-FR.json"
}
```

The dynamic settings enum should not be used as the catalog registry: VS Code
configuration schemas are static. The shared header selector is the authoritative
dynamic list; `snlDoc.locale` should eventually accept a validated locale string
rather than enumerate only built-ins.

Current readiness is uneven:

There is **not yet a loadable third-party extension point**. The current work
centralizes the built-in locale descriptors and all Panel selectors, which is a
clean insertion point, but discovery and catalog transport still need building.

- **Already reusable:** one host/Webview built-in language registry,
  query-injected locale resolution, startup bootstrap,
  revisioned hot broadcast, React subscription, `read_localized`, arbitrary
  locale keys in serialized project-content I18n maps, and one shared selector
  surface across all panels.
- **Still required:** extension-pack discovery, catalog schema/version validation,
  conflict policy, fallback-chain construction, host-to-Webview catalog messages,
  dynamic locale typing/settings, and migration of remaining hard-coded UI text
  to stable message IDs.
- **Static limitation:** an external runtime pack cannot rename command-palette
  commands/settings already localized by VS Code. Supporting those requires the
  pack to participate in VS Code's own localization mechanism or shipping the
  relevant `package.nls.<locale>.json` with SNL Doc itself.

## UI text

Components may accept `Localized<string, string>` and resolve it with
`use_localized`. This hook runs SNL-Basics' `read_localized` Reader against the
same query-injected runtime used by content renderers. Plain strings remain valid
for incremental migration. Manifest strings (extension metadata, all command
titles, and settings) use `package.nls.json` and `package.nls.zh-cn.json`; they
are not runtime webview messages.

## Verification

The regression suite covers:

- locale/theme/motion preference resolution;
- initial HTML attributes and title escaping;
- revision ordering for hot snapshots;
- package NLS key parity;
- malformed I18n rejection;
- Entry add/update round trips without projection;
- localized text Macro persistence and validation;
- strict TypeScript checks for host and webview;
- all webview bundles and the filesystem smoke suite.
