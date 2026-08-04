import * as vscode from 'vscode';
import {
  inspectWorkspaceDataVersion,
  migrateWorkspaceData
} from './vscodeDataMigration';
import type { WorkspaceDataInspection } from './dataMigrations';

function chainText(inspection: WorkspaceDataInspection): string {
  const versions = [
    inspection.currentVersion ?? 'unknown',
    ...(inspection.pending ?? []).map((step) => step.to)
  ];
  return versions.join(' → ');
}

async function offerDashboard(message: string): Promise<void> {
  const action = await vscode.window.showInformationMessage(message, 'Open Dashboard');
  if (action === 'Open Dashboard') {
    await vscode.commands.executeCommand('snlDoc.openDashboard');
  }
}

export async function checkDataVersion(
  workspaceRoot: vscode.Uri | undefined
): Promise<void> {
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      'SNL data check requires an open folder / workspace.'
    );
    return;
  }
  const inspection = await inspectWorkspaceDataVersion(workspaceRoot);
  if (
    inspection.status === 'invalid' ||
    inspection.status === 'future' ||
    inspection.status === 'missing'
  ) {
    void vscode.window.showErrorMessage(`SNL data check failed: ${inspection.message}`);
    return;
  }
  if (inspection.status === 'current') {
    void offerDashboard(`SNL workspace data is current (${inspection.targetVersion}).`);
    return;
  }
  void offerDashboard(
    `SNL workspace data needs migration: ${chainText(inspection)}. ` +
      `${inspection.pending?.length ?? 0} step(s).`
  );
}

export async function repairData(
  workspaceRoot: vscode.Uri | undefined
): Promise<void> {
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      'SNL data repair requires an open folder / workspace.'
    );
    return;
  }
  const inspection = await inspectWorkspaceDataVersion(workspaceRoot);
  if (inspection.status === 'current') {
    void vscode.window.showInformationMessage(
      `SNL workspace data is already current (${inspection.targetVersion}).`
    );
    return;
  }
  if (inspection.status !== 'needsMigration' || !inspection.pending) {
    void vscode.window.showErrorMessage(`SNL data repair refused: ${inspection.message}`);
    return;
  }

  const detail = inspection.pending
    .map((step) => `${step.from} → ${step.to}: ${step.description}`)
    .join('\n');
  const confirmed = await vscode.window.showWarningMessage(
    `Migrate SNL workspace data ${inspection.currentVersion} → ${inspection.targetVersion}?`,
    {
      modal: true,
      detail:
        `${detail}\n\nFiles are written atomically and config.json is committed last. ` +
        'If any write fails, completed writes are rolled back.'
    },
    'Migrate'
  );
  if (confirmed !== 'Migrate') return;

  try {
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Migrating SNL workspace data',
        cancellable: false
      },
      async () => migrateWorkspaceData(workspaceRoot)
    );
    void vscode.window.showInformationMessage(
      `SNL data migration complete: ${report.from} → ${report.to} ` +
        `(${report.applied.length} step${report.applied.length === 1 ? '' : 's'}).`
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `SNL data migration failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
