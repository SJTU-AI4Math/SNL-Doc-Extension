// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardApp } from './DashboardApp';
import type { VsCodeApi } from './vscodeApi';

const postMessage = vi.fn();

beforeEach(() => {
  postMessage.mockClear();
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
});

afterEach(() => {
  cleanup();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Dashboard library actions', () => {
  it('creates a library from the collapsed Libraries section header', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'overview',
          overview: {
            hasSnlDoc: true,
            totalEntryCount: 0,
            entries: [],
            libraries: [],
            macroPackages: [],
            allMacros: [],
            metricMacroSources: {},
            entryKinds: [],
            macroKinds: [],
            relationships: []
          }
        }
      })
    );

    const createButton = await screen.findByRole('button', {
      name: 'Open the Create Library panel'
    });
    const librariesToggle = screen.getByRole('button', {
      name: /Libraries0 libraries/
    });
    expect(createButton.textContent).toBe('+ Create Library');
    expect(librariesToggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(createButton);

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({ type: 'createLibrary' })
    );
    expect(librariesToggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows data version health and routes check/repair actions to the host', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'overview',
          overview: {
            hasSnlDoc: true,
            totalEntryCount: 0,
            entries: [],
            libraries: [],
            macroPackages: [],
            allMacros: [],
            metricMacroSources: {},
            entryKinds: [],
            macroKinds: [],
            relationships: [],
            dataStatus: {
              status: 'needsMigration',
              currentVersion: '0.0.3',
              targetVersion: '0.0.4',
              pendingCount: 1,
              message: '1 migration step required.'
            }
          }
        }
      })
    );

    expect(await screen.findByText('Data maintenance')).toBeTruthy();
    expect(screen.getByText('0.0.3 → 0.0.4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Repair / migrate data' }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dataMigrationStatus', status: 'running', operation: 'repair' }
    }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Repair / migrate data' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: 'Check data' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('status').textContent).toContain('Migration is running');
    });
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'checkDataVersion' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'repairData' });
    });
  });

  it('shows Entry Packages first and reveals entries only inside the selected Package', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'overview',
          overview: {
            hasSnlDoc: true,
            totalEntryCount: 2,
            entries: [
              {
                id: 'entry-1',
                package: 'Logic',
                kind: 'definition',
                title: 'Entry One',
                content: { snl: 'free' }
              },
              {
                id: 'entry-2',
                package: 'Algebra',
                kind: 'definition',
                title: 'Entry Two',
                content: { snl: 'free' }
              }
            ],
            libraries: [],
            macroPackages: [{ file: 'Empty.json', macroCount: 0 }],
            allMacros: [],
            metricMacroSources: {},
            entryKinds: [],
            macroKinds: [],
            relationships: []
          }
        }
      })
    );

    await screen.findByText('Entries');
    const entriesToggle = screen.getByText('Entries').closest('button');
    if (!entriesToggle) throw new Error('Entries toggle not found');
    expect(entriesToggle.textContent).toContain('4 packages');
    fireEvent.click(entriesToggle);

    expect(await screen.findByRole('button', { name: 'Open entry package Algebra' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open entry package Empty' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open entry package Logic' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open entry package _unpackaged' })).toBeTruthy();
    expect(screen.queryByText('Entry One')).toBeNull();
    expect(screen.queryByText('Entry Two')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open entry package Logic' }));
    expect(await screen.findByRole('button', { name: 'Back to entry packages' })).toBeTruthy();
    expect(screen.getByText('Entry One')).toBeTruthy();
    expect(screen.queryByText('Entry Two')).toBeNull();
    expect(screen.getByText('SNL Structural Index')).toBeTruthy();
    expect(screen.queryByText('Semantic freedom')).toBeNull();
    expect(screen.queryByText('Structured')).toBeNull();

    fireEvent.click(entriesToggle);
    fireEvent.click(entriesToggle);
    expect(screen.getByRole('button', { name: 'Open entry package Logic' })).toBeTruthy();
    expect(screen.queryByText('Entry One')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open entry package Logic' }));
    expect(screen.getByRole('button', { name: 'Back to entry packages' })).toBeTruthy();
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'overview',
        overview: {
          hasSnlDoc: true,
          totalEntryCount: 1,
          entries: [{
            id: 'entry-2', package: 'Algebra', kind: 'definition',
            title: 'Entry Two', content: { snl: 'free' }
          }],
          libraries: [],
          macroPackages: [{ file: 'Empty.json', macroCount: 0 }],
          allMacros: [],
          metricMacroSources: {},
          entryKinds: [],
          macroKinds: [],
          relationships: []
        }
      }
    }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Back to entry packages' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Open entry package Logic' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Open entry package Algebra' })).toBeTruthy();
    });
  });
});
