import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';

// TODO: import SNL_render from snl-script lib

export function activate(context: vscode.ExtensionContext): void {
  const openInfoview = vscode.commands.registerCommand(
    'snlDoc.openInfoview',
    () => {
      InfoviewPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(openInfoview);
}

export function deactivate(): void {
  // no-op
}
