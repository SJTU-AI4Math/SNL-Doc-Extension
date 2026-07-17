import * as vscode from 'vscode';
import { KindPanelController } from './kindPanelController';

export class CreateEntryKindPanel {
  static createOrShow(extensionUri: vscode.Uri): void { KindPanelController.createOrShow('entry', extensionUri); }
  static editOrShow(extensionUri: vscode.Uri, id: string): void { KindPanelController.editOrShow('entry', extensionUri, id); }
}
