import * as vscode from 'vscode';
import { panelMarkup } from './markup';

/** Panel document for the VS Code webview. */
export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
  return panelMarkup(scriptUri.toString(), nonce);
}
