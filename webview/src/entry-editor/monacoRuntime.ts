/// <reference types="vite/client" />
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from './monacoEditor.worker?worker';
import {
  configureSnlMonaco,
  type SnlMonacoConfigurationApi
} from './snlMonacoLanguage';

interface MonacoEnvironmentShape {
  getWorker(_moduleId: string, _label: string): Worker;
}

const workerEnvironment: MonacoEnvironmentShape = {
  getWorker: () => new EditorWorker()
};
(globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentShape }).MonacoEnvironment =
  workerEnvironment;

for (const id of ['snl', 'typst', 'latex', 'markdown']) {
  if (!monaco.languages.getLanguages().some((language) => language.id === id)) {
    monaco.languages.register({ id });
  }
}

configureSnlMonaco(monaco as unknown as SnlMonacoConfigurationApi);

export { monaco };
