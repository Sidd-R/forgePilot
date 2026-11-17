import * as vscode from 'vscode';

const COMMANDS = [
  'forgePilot.inlineEdit',
  'forgePilot.openAgent',
  'forgePilot.cancel',
  'forgePilot.acceptHunk',
  'forgePilot.rejectHunk',
  'forgePilot.acceptAll',
  'forgePilot.rejectAll',
  'forgePilot.undoLast',
  'forgePilot.undoRun',
  'forgePilot.loadAgents',
] as const;

export function activate(context: vscode.ExtensionContext): void {
  for (const command of COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        void vscode.window.showInformationMessage(
          `ForgePilot: ${command} is not wired yet (scaffold).`,
        );
      }),
    );
  }
}

export function deactivate(): void {
  // Nothing to dispose yet; tracks add their disposables here.
}
