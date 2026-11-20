import * as vscode from 'vscode';
import { readConfig, type Host } from './host';
import { CodeIndex } from './context/index';

/** Editor-wide listeners: review lenses/colors, config reload, reindex on save. */
export function editorListeners(host: Host, onConfigChanged: () => void): vscode.Disposable[] {
  return [
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, host.review.view),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        host.review.view.refresh(editor);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const found = host.review.reviewForUri(doc.uri);
      if (found) {
        void host.review.closeAsRejectAll(host.rootDir, found.runId, found.proposalId);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('forgepilot')) {
        return;
      }
      const next = readConfig();
      if (next.baseUrl !== host.config.baseUrl || next.mcpPort !== host.config.mcpPort) {
        void vscode.window
          .showInformationMessage('ForgePilot: reload the window to apply the new server settings.', 'Reload')
          .then((choice) => {
            if (choice === 'Reload') {
              void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
        next.baseUrl = host.config.baseUrl;
        next.mcpPort = host.config.mcpPort;
      }
      host.config = next;
      onConfigChanged();
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      const fresh = CodeIndex.build(host.rootDir);
      host.index = fresh;
      host.indexBox.index = fresh;
      void fresh.loadCochange(host.rootDir);
    }),
  ];
}
