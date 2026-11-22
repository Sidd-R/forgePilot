import * as vscode from 'vscode';

/**
 * After a review leaves a file exactly as it is on disk, drop the
 * buffer's dirty flag so closing the tab does not ask to save. Reverting
 * reloads from disk and never writes; it is skipped if the buffer holds
 * anything that differs from disk (the user's own unsaved edits).
 */
export async function revertIfUnchanged(uri: vscode.Uri): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc?.isDirty) {
    return;
  }
  let disk: string;
  try {
    disk = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return;
  }
  if (doc.getText() !== disk) {
    return;
  }
  // The revert command acts on the active editor, so show this file
  // briefly and hand focus back to whatever was active before.
  const previous = vscode.window.activeTextEditor;
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
  await vscode.commands.executeCommand('workbench.action.files.revert');
  if (previous && previous.document.uri.toString() !== uri.toString()) {
    await vscode.window.showTextDocument(previous.document, { viewColumn: previous.viewColumn });
  }
}
