import {
  read_localized,
  type Localized
} from '@sjtu-ai4math/snl-basics/runtime';
import {
  use_preferences_revision,
  webview_ui_language_runtime
} from './preferencesRuntime';

export type LocalizedString = Localized<string, string>;

/** Resolve product UI text through the global UI locale, never the Panel content language. */
export function use_localized(value: LocalizedString): string {
  use_preferences_revision();
  return webview_ui_language_runtime.run_reader(
    read_localized<string, string>(value)
  );
}
