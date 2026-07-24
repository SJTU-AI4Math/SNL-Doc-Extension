import React, { useId, useMemo, useState } from 'react';
import { tryParseSnlSyntaxTree, type SnlSyntaxTree } from '@snl-basics/react';
import { Disclosure } from './Disclosure';
import {
  MacroTable,
  type MacroKind,
  type MacroPackageEntry
} from '../PackagePanelApp';

export function selectUsedMacros(
  snl: string,
  macros: Record<string, MacroPackageEntry>
): MacroPackageEntry[] {
  const selected: MacroPackageEntry[] = [];
  const seen = new Set<string>();
  const parsed = tryParseSnlSyntaxTree(snl);
  if (!parsed.ok) return selected;
  const visit = (node: SnlSyntaxTree): void => {
    if (!seen.has(node.macro_name)) {
      seen.add(node.macro_name);
      const macro = macros[node.macro_name];
      if (macro) selected.push(macro);
    }
    for (const child of node.children) visit(child);
  };
  visit(parsed.tree);
  return selected;
}

export function EntryMacroSection({
  snl,
  macros,
  macroKinds,
  entryPoolIds,
  postMessage
}: {
  snl: string;
  macros: Record<string, MacroPackageEntry>;
  macroKinds: MacroKind[];
  entryPoolIds: Set<string>;
  postMessage: (message: unknown) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const sectionId = useId();
  const usedMacros = useMemo(
    () => selectUsedMacros(snl, macros),
    [snl, macros]
  );
  const panelId = `entry-macros-${sectionId.replace(/[^a-z0-9_-]+/gi, '-')}`;

  return (
    <section
      style={{
        marginTop: '1.25rem',
        borderTop:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        paddingTop: '0.4rem',
        overflowX: 'auto'
      }}
    >
      <Disclosure
        expanded={open}
        controls={panelId}
        onToggle={() => setOpen((value) => !value)}
        aria-label={`Macros (${usedMacros.length})`}
        style={{
          cursor: 'pointer',
          display: 'flex',
          width: '100%',
          alignItems: 'baseline',
          gap: '0.6rem',
          userSelect: 'none',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left'
        }}
        title="Macros used by this Entry"
      >
        <span style={{ opacity: 0.7, fontFamily: 'monospace', width: '1em' }}>
          {open ? '▾' : '▸'}
        </span>
        <span role="heading" aria-level={2} style={{ fontSize: '1rem', fontWeight: 600 }}>
          Macros
        </span>
        <span style={{ opacity: 0.55, fontSize: '0.8rem' }}>({usedMacros.length})</span>
      </Disclosure>
      {open ? (
        <div id={panelId} style={{ paddingTop: '0.35rem' }}>
          {usedMacros.length > 0 ? (
            <MacroTable
              macros={usedMacros}
              macroKinds={macroKinds}
              entryPoolIds={entryPoolIds}
              onEdit={(name) => postMessage({ type: 'editMacro', name })}
              onDelete={(name) => postMessage({ type: 'deleteMacro', name })}
              selectMode={false}
              selectedNames={new Set<string>()}
              onToggleSelect={() => undefined}
            />
          ) : (
            <p style={{ opacity: 0.55, fontSize: '0.85rem', margin: 0, fontStyle: 'italic' }}>
              No registered macros are used by this Entry.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}