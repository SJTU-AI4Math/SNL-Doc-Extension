# I18n and query-injected preferences

SNL-Doc-Extension consumes the host-agnostic `ReaderM` / `ReaderRuntime` API
from SNL-Basics. SNL-Basics never reads VS Code settings, browser globals, or
workspace files. The extension supplies those capabilities through query
functions.

## Extension settings

- `snlDoc.locale`: `auto | en | zh-CN`
- `snlDoc.appearance.theme`: `auto | light | dark | high-contrast`
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
