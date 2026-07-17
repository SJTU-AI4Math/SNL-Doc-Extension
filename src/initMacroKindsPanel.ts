import * as vscode from 'vscode';
import { InitKindsPanelController } from './initKindsPanelController';

export class InitMacroKindsPanel {
  static createOrShow(extensionUri: vscode.Uri): void {
    InitKindsPanelController.createOrShow('macro', extensionUri);
  }
}
