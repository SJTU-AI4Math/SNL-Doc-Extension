import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';
import { InitPanel } from './initPanel';

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

  context.subscriptions.push(openInfoview, init);
}

export function deactivate(): void {
  // no-op
}
