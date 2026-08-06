import { createHostTranslator, defineHostMessages } from './hostI18n';

const MACRO_OUTPUT_MESSAGES = defineHostMessages(
  {
    conflict: '[warn] macro name conflict: “{name}” in packages {first} and {second}. Last write wins (order-dependent).'
  },
  {
    conflict: '[警告] 宏名称冲突：“{name}”同时出现在宏包 {first} 和 {second} 中。将采用最后写入的定义（结果取决于顺序）。'
  }
);

export function formatMacroConflict(
  language: string,
  name: string,
  first: string,
  second: string
): string {
  return createHostTranslator(language, MACRO_OUTPUT_MESSAGES)('conflict', {
    name,
    first,
    second
  });
}
