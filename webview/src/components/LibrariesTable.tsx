import React from 'react';
import { DASHBOARD_MESSAGES } from '../i18n/dashboardMessages';
import { useUiMessages } from '../i18n/uiMessages';
import { CELL, HEAD, MONO, ClickableRow, RowDeleteCell } from './dashboardTablePrimitives';

const LIBRARY_HEAD: React.CSSProperties = { ...HEAD, boxSizing: 'border-box' };

/** Catalog metadata only; older local servers may omit unavailable counts. */
export interface LibrarySummary {
  slug: string;
  title: string;
  entryCount?: number | null;
  relationshipCount?: number | null;
  error?: string;
}

type LibrariesTableProps = {
  libraries: readonly LibrarySummary[];
  onOpen: (slug: string) => void;
} & ({ readOnly: true; onDelete?: never } | { readOnly?: false; onDelete: (slug: string) => void });

/** The Dashboard's actual table, with authoring controls omitted by read-only hosts. */
export function LibrariesTable({ libraries, onOpen, onDelete, readOnly = false }: LibrariesTableProps): React.ReactElement {
  const t = useUiMessages(DASHBOARD_MESSAGES);
  return (
    <div className="snl-libraries-table-scroll" style={{ width: '100%', minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>
      <table
        className="snl-libraries-table"
        style={{
          width: '100%',
          minWidth: '40rem',
          tableLayout: 'fixed',
          borderCollapse: 'collapse',
          marginTop: '0.5rem',
          fontSize: '0.95rem'
        }}
      >
        <thead>
          <tr>
            <th scope="col" style={{ ...LIBRARY_HEAD, width: '40%' }}>{t('colTitle')}</th>
            <th scope="col" style={LIBRARY_HEAD}>{t('colSlug')}</th>
            <th scope="col" style={{ ...LIBRARY_HEAD, textAlign: 'right', width: '6rem', whiteSpace: 'nowrap' }}>{t('colEntries')}</th>
            <th scope="col" style={{ ...LIBRARY_HEAD, textAlign: 'right', width: '9rem', whiteSpace: 'nowrap' }}>{t('colRelationships')}</th>
            {!readOnly && <th scope="col" style={{ ...LIBRARY_HEAD, textAlign: 'right', width: '2.5rem' }} />}
          </tr>
        </thead>
        <tbody>
          {libraries.map(lib => (
            <ClickableRow
              key={lib.slug}
              rowId={lib.slug}
              label={t(readOnly ? 'openLibrary' : 'editLibrary', { id: lib.slug })}
              onActivate={() => onOpen(lib.slug)}
              primaryCellIndex={0}
              primaryButtonStyle={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
            >
              <td style={{ ...CELL, overflowWrap: 'anywhere' }}>{lib.title || lib.slug}</td>
              <td style={{ ...CELL, ...MONO, overflowWrap: 'anywhere' }}>{lib.slug}</td>
              <td style={{ ...CELL, textAlign: 'right' }}>{lib.entryCount ?? '—'}{lib.error ? <span role="alert" title={lib.error}> ⚠ {lib.error}</span> : null}</td>
              <td style={{ ...CELL, textAlign: 'right' }}>{lib.relationshipCount ?? '—'}</td>
              {!readOnly && onDelete && <RowDeleteCell
                label={t('deleteLibrary', { id: lib.slug })}
                onDelete={() => onDelete(lib.slug)}
              />}
            </ClickableRow>
          ))}
        </tbody>
      </table>
    </div>
  );
}
