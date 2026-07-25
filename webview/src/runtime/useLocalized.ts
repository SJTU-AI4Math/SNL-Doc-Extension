import {
  read_localized,
  type Localized
} from '@sjtu-ai4math/snl-basics/runtime';
import {
  use_preferences_revision,
  webview_language_runtime
} from './preferencesRuntime';

export type LocalizedString = Localized<string, string>;

/** Resolve UI text through the same query-injected Reader runtime as content. */
export function use_localized(value: LocalizedString): string {
  use_preferences_revision();
  return webview_language_runtime.run_reader(
    read_localized<string, string>(value)
  );
}
