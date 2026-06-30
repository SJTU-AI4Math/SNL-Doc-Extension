import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';
import { InitPanel } from './initPanel';
import { CreateLibraryPanel } from './createLibraryPanel';
import { DashboardPanel } from './dashboardPanel';

// TODO: import SNL_render from snl-script lib

export function activate(context: vscode.ExtensionContext): void {
  const openInfoview = vscode.commands.registerCommand(
    'snlDoc.openInfoview',
    () => {
      InfoviewPanel.createOrShow(context.extensionUri);
    }
  );

  const init = vscode.commands.registerCommand('snlDoc.init', () => {
    InitPanel.createOrShow(context.extensionUri);
  });

  const createLibrary = vscode.commands.registerCommand(
    'snlDoc.createLibrary',
    () => {
      CreateLibraryPanel.createOrShow(context.extensionUri);
    }
  );

  const openDashboard = vscode.commands.registerCommand(
    'snlDoc.openDashboard',
    () => {
      DashboardPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(
    openInfoview,
    init,
    createLibrary,
    openDashboard
  );
}

export function deactivate(): void {
  // no-op
}
