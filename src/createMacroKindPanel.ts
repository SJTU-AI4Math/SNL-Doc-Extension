import * as vscode from 'vscode';
import { KindPanelController } from './kindPanelController';

export class CreateMacroKindPanel {
  static createOrShow(extensionUri: vscode.Uri): void { KindPanelController.createOrShow('macro', extensionUri); }
  static editOrShow(extensionUri: vscode.Uri, id: string): void { KindPanelController.editOrShow('macro', extensionUri, id); }
}
