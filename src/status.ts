import * as vscode from 'vscode';

/** Status bar entry: idle opens the agent panel, busy offers Cancel. */
export class StatusIndicator implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.set(false);
    this.item.show();
  }

  set(busy: boolean): void {
    this.item.text = busy ? '$(sync~spin) ForgePilot' : '$(sparkle) ForgePilot';
    this.item.tooltip = busy ? 'ForgePilot is working. Click to cancel.' : 'Open the ForgePilot agent';
    this.item.command = busy ? 'forgePilot.cancel' : 'forgePilot.openAgent';
  }

  dispose(): void {
    this.item.dispose();
  }
}
