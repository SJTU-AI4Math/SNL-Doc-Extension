import * as vscode from 'vscode';
import { InitKindsPanelController } from './initKindsPanelController';

export class InitEntryKindsPanel {
  static createOrShow(extensionUri: vscode.Uri): void {
    InitKindsPanelController.createOrShow('entry', extensionUri);
  }
}
