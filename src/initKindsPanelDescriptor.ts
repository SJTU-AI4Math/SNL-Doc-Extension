export type KindsDomain = 'entry' | 'macro';

export function initKindsPanelDescriptor(domain: KindsDomain) {
  const cap = domain === 'entry' ? 'Entry' : 'Macro';
  return {
    viewType: `snlInit${cap}Kinds`,
    entry: `init${cap}Kinds`,
    title: `SNL Initialize ${cap} Kinds`,
    configKey: `${domain}_kinds`,
    singular: `${domain} kind`
  } as const;
}
