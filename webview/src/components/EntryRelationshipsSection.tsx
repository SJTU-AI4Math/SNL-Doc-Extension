import React, { useId, useState } from 'react';
import { Disclosure } from './Disclosure';
import { Icon } from './Icon';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'entry.relationships',
  {
    heading: 'Relationships',
    accessibleTitle: 'Relationships ({count}) — entries related to this Entry; entries that depend on it are not listed',
    openEntry: 'Open entry "{id}"',
    empty: 'This Entry has no relationships yet (entries that depend on it are not listed here).'
  },
  {
    heading: '关系',
    accessibleTitle: '关系（{count}）— 与此条目相关的条目；依赖它的条目不在此列出',
    openEntry: '打开条目“{id}”',
    empty: '此条目尚无关系（依赖它的条目不在此列出）。'
  }
);

/**
 * A relationship row as shipped by the host (see src/entryRelationships.ts).
 * The host has ALREADY filtered out the "other entries depend on me"
 * direction, so this component renders whatever it is given.
 */
export interface EntryRelationshipRow {
  id: string;
  label: string;
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherTitle: string;
  otherKindId?: string;
}

const ARROW: Record<EntryRelationshipRow['direction'], string> = {
  outgoing: '→',
  incoming: '←'
};

/**
 * Relationships section of the Entry panel (cat 2026-07-25).
 *
 * Lists every entry this entry has a relationship with, EXCEPT the entries
 * that depend on it — that reverse-dependency fan-in is unbounded on
 * foundational entries and is not what an author editing this entry needs.
 *
 * The rows are pure props: retargeting the singleton panel at another entry
 * simply pushes a new array (or an empty one), so nothing from the previous
 * entry can survive.
 */
export function EntryRelationshipsSection({
  relationships,
  onOpenEntry
}: {
  relationships: EntryRelationshipRow[];
  onOpenEntry?: (entryId: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const t = useUiMessages(MESSAGES);
  const sectionId = useId();
  const panelId = `entry-relationships-${sectionId.replace(/[^a-z0-9_-]+/gi, '-')}`;

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
        aria-label={t('accessibleTitle', { count: relationships.length })}
        title={t('accessibleTitle', { count: relationships.length })}
      >
        <span aria-hidden="true" style={{ opacity: 0.7, width: '1em' }}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        </span>
        <span role="heading" aria-level={2} style={{ fontSize: '1rem', fontWeight: 600 }}>
          {t('heading')}
        </span>
        <span style={{ opacity: 0.55, fontSize: '0.8rem' }}>
          ({relationships.length})
        </span>
      </Disclosure>
      {open ? (
        <div id={panelId} style={{ paddingTop: '0.35rem' }}>
          {relationships.length > 0 ? (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem'
              }}
            >
              {relationships.map((row) => (
                <li
                  key={row.id}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '0.5rem',
                    fontSize: '0.85rem'
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ opacity: 0.7, fontFamily: 'monospace' }}
                  >
                    {ARROW[row.direction]}
                  </span>
                  <span
                    style={{
                      opacity: 0.75,
                      fontFamily: 'var(--vscode-editor-font-family, monospace)'
                    }}
                  >
                    {row.label}
                  </span>
                  {onOpenEntry ? (
                    <button
                      type="button"
                      onClick={() => onOpenEntry(row.otherId)}
                      title={t('openEntry', { id: row.otherId })}
                      style={{
                        padding: 0,
                        border: 0,
                        background: 'transparent',
                        color: 'var(--vscode-textLink-foreground, #3794ff)',
                        font: 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      {row.otherTitle || row.otherId}
                    </button>
                  ) : (
                    <span>{row.otherTitle || row.otherId}</span>
                  )}
                  <span
                    style={{
                      opacity: 0.5,
                      fontSize: '0.78rem',
                      fontFamily: 'var(--vscode-editor-font-family, monospace)'
                    }}
                  >
                    {row.otherId}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p
              style={{
                opacity: 0.55,
                fontSize: '0.85rem',
                margin: 0,
                fontStyle: 'italic'
              }}
            >
              {t('empty')}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
