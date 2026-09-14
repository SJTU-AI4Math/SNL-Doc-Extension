import { apply_preferences_snapshot, type PreferencesSnapshotMessage } from '../runtime/preferencesRuntime';

/** Shared browser persistence for the workspace shell and frozen/local reading routes. */
export function createBrowserPreferences(
  initial: PreferencesSnapshotMessage['preferences'],
  generation: string,
  languages: NonNullable<PreferencesSnapshotMessage['supported_languages']>
) {
  const preferences = { ...initial };
  let revision = 0;
  const publish = (): void => {
    apply_preferences_snapshot({ type: 'snl.preferences/snapshot', generation,
      revision: ++revision, preferences, supported_languages: languages });
    try { localStorage.setItem('snl-reader-preferences', JSON.stringify(preferences)); } catch { /* file:// privacy mode */ }
  };
  return {
    load(): void {
      try { Object.assign(preferences, JSON.parse(localStorage.getItem('snl-reader-preferences') || '{}')); } catch { /* optional */ }
      publish();
    },
    handle(message: Record<string, unknown>): boolean {
      switch (message.type) {
        case 'snl.preferences/set-language':
          preferences.language = message.language === 'auto' ? initial.language : String(message.language);
          break;
        case 'snl.preferences/set-reading': case 'snl.preferences/update':
          Object.assign(preferences, message.patch ?? message.preferences ?? {}); break;
        case 'snl.reader/theme': preferences.color_scheme = String(message.value); break;
        case 'snl.preferences/ready': break;
        case 'snl.content-language/changed': return true;
        default: return false;
      }
      publish();
      return true;
    }
  };
}
