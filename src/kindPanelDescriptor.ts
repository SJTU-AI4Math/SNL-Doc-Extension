export type KindPanelDomain = 'entry' | 'macro';
export function kindPanelDescriptor(domain: KindPanelDomain) {
  const cap = domain === 'entry' ? 'Entry' : 'Macro';
  return {
    cap,
    viewType: `snlCreate${cap}Kind`,
    entry: `create${cap}Kind`,
    noun: `${domain} kind`
  } as const;
}
