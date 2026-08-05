import * as vscode from 'vscode';
import {
  inspectWorkspaceDataVersion,
  migrateWorkspaceData
} from './vscodeDataMigration';
import type { WorkspaceDataInspection } from './dataMigrations';
import { createHostTranslator, defineHostMessages, type HostTranslator } from './hostI18n';
import { read_extension_preferences } from './preferences';

const MESSAGES = defineHostMessages(
  {
    openDashboard: 'Open Dashboard', checkNeedsWorkspace: 'SNL data check requires an open folder / workspace.',
    checkFailed: 'SNL data check failed: {message}', current: 'SNL workspace data is current ({version}).',
    needsMigration: 'SNL workspace data needs migration: {chain}. {count} step(s).',
    repairNeedsWorkspace: 'SNL data repair requires an open folder / workspace.',
    alreadyCurrent: 'SNL workspace data is already current ({version}).',
    repairRefused: 'SNL data repair refused: {message}', confirm: 'Migrate SNL workspace data {from} → {to}?',
    atomicDetail: '{detail}\n\nFiles are written atomically and config.json is committed last. If any write fails, completed writes are rolled back.',
    migrate: 'Migrate', progress: 'Migrating SNL workspace data',
    complete: 'SNL data migration complete: {from} → {to} ({count} step(s)).',
    failed: 'SNL data migration failed: {message}'
  },
  {
    openDashboard: '打开仪表板', checkNeedsWorkspace: '检查 SNL 数据需要打开文件夹或工作区。',
    checkFailed: 'SNL 数据检查失败：{message}', current: 'SNL 工作区数据已是当前版本（{version}）。',
    needsMigration: 'SNL 工作区数据需要迁移：{chain}，共 {count} 个步骤。',
    repairNeedsWorkspace: '修复 SNL 数据需要打开文件夹或工作区。',
    alreadyCurrent: 'SNL 工作区数据已经是当前版本（{version}）。',
    repairRefused: '拒绝修复 SNL 数据：{message}', confirm: '要将 SNL 工作区数据从 {from} 迁移到 {to} 吗？',
    atomicDetail: '{detail}\n\n文件将以原子方式写入，最后提交 config.json。任何写入失败时，已完成的写入都会回滚。',
    migrate: '迁移', progress: '正在迁移 SNL 工作区数据',
    complete: 'SNL 数据迁移完成：{from} → {to}（{count} 个步骤）。',
    failed: 'SNL 数据迁移失败：{message}'
  }
);

function translator(): HostTranslator<typeof MESSAGES.en> {
  return createHostTranslator(read_extension_preferences().language, MESSAGES);
}

function chainText(inspection: WorkspaceDataInspection): string {
  const versions = [
    inspection.currentVersion ?? 'unknown',
    ...(inspection.pending ?? []).map((step) => step.to)
  ];
  return versions.join(' → ');
}

async function offerDashboard(message: string, t: HostTranslator<typeof MESSAGES.en>): Promise<void> {
  const actionLabel = t('openDashboard');
  const action = await vscode.window.showInformationMessage(message, actionLabel);
  if (action === actionLabel) {
    await vscode.commands.executeCommand('snlDoc.openDashboard');
  }
}

export async function checkDataVersion(
  workspaceRoot: vscode.Uri | undefined
): Promise<void> {
  const t = translator();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(t('checkNeedsWorkspace'));
    return;
  }
  const inspection = await inspectWorkspaceDataVersion(workspaceRoot);
  if (
    inspection.status === 'invalid' ||
    inspection.status === 'future' ||
    inspection.status === 'missing'
  ) {
    void vscode.window.showErrorMessage(t('checkFailed', { message: inspection.message }));
    return;
  }
  if (inspection.status === 'current') {
    void offerDashboard(t('current', { version: inspection.targetVersion }), t);
    return;
  }
  void offerDashboard(t('needsMigration', {
    chain: chainText(inspection), count: inspection.pending?.length ?? 0
  }), t);
}

export async function repairData(
  workspaceRoot: vscode.Uri | undefined
): Promise<void> {
  const t = translator();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(t('repairNeedsWorkspace'));
    return;
  }
  const inspection = await inspectWorkspaceDataVersion(workspaceRoot);
  if (inspection.status === 'current') {
    void vscode.window.showInformationMessage(
      t('alreadyCurrent', { version: inspection.targetVersion })
    );
    return;
  }
  if (inspection.status !== 'needsMigration' || !inspection.pending) {
    void vscode.window.showErrorMessage(t('repairRefused', { message: inspection.message }));
    return;
  }

  const detail = inspection.pending
    .map((step) => `${step.from} → ${step.to}: ${step.description}`)
    .join('\n');
  const confirmed = await vscode.window.showWarningMessage(
    t('confirm', { from: inspection.currentVersion ?? 'unknown', to: inspection.targetVersion }),
    {
      modal: true,
      detail: t('atomicDetail', { detail })
    },
    t('migrate')
  );
  if (confirmed !== t('migrate')) return;

  try {
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('progress'),
        cancellable: false
      },
      async () => migrateWorkspaceData(workspaceRoot)
    );
    void vscode.window.showInformationMessage(
      t('complete', { from: report.from, to: report.to, count: report.applied.length })
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      t('failed', { message: error instanceof Error ? error.message : String(error) })
    );
  }
}
