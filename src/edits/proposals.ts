import * as crypto from 'node:crypto';
import type * as vscode from 'vscode';
import type { Hunk, Proposal, ProposeEditInput } from '../types';
import { applyHunks, computeHunks, createEditHunks } from './diff';
import { applyEditsToText } from './matcher';

/** SINGLE DISK-WRITE PATH (writeguard test enforces this). `vscode` is injected. */
let vs: typeof vscode | undefined;

/** Called once from the extension entry point. */
export function initVscode(api: typeof vscode): void {
  vs = api;
}

function api(): typeof vscode {
  if (!vs) {
    throw new Error('proposals: vscode API not initialized');
  }
  return vs;
}

/** Stable hash matching an approval answer to its tool call arguments. */
export function hashArgs(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface BuiltProposal {
  proposal: Proposal;
  /** Full proposed text (before per-hunk decisions). */
  newText: string;
}

/** Build a proposal from tool-call input against current file text. */
export function createProposal(
  id: string,
  path: string,
  currentText: string | null,
  input: Omit<ProposeEditInput, 'path'>,
  callHash: string,
): BuiltProposal {
  const isNewFile = currentText === null;
  if (isNewFile && input.content === undefined) {
    throw new Error(`propose_edit for new file ${path} needs content.`);
  }
  if (!isNewFile && input.content === undefined && !input.edits?.length) {
    throw new Error('propose_edit needs edits or content.');
  }
  const oldText = currentText ?? '';
  const perEdit =
    !isNewFile && input.content === undefined && input.edits?.length
      ? createEditHunks(oldText, input.edits)
      : null;
  const newText = input.content ?? perEdit?.newText ?? applyEditsToText(oldText, input.edits);
  const hunks: Hunk[] = isNewFile
    ? [{ id: 'h1', startLine: 1, oldLines: [], newLines: newText.split('\n') }]
    : (perEdit?.hunks ?? computeHunks(oldText, newText));
  return {
    proposal: { id, path, isNewFile, hunks, callHash, explanation: input.explanation },
    newText,
  };
}

/** One file restore for undo. `text: null` deletes a created file. */
export interface Restore {
  path: string;
  text: string | null;
}

interface RunState {
  checkpoints: Map<string, string | null>;
  order: string[];
  before: Map<string, { path: string; text: string | null }>;
  proposals: Map<string, Proposal>;
}

/** Pending edits, hunk decisions, and checkpoints for undo. */
export class ProposalStore {
  private runs = new Map<string, RunState>();

  private run(runId: string): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      state = { checkpoints: new Map(), order: [], before: new Map(), proposals: new Map() };
      this.runs.set(runId, state);
    }
    return state;
  }

  /** Record original text once, before the run first touches a file. */
  ensureCheckpoint(runId: string, path: string, text: string | null): void {
    const state = this.run(runId);
    if (!state.checkpoints.has(path)) {
      state.checkpoints.set(path, text);
    }
  }

  addProposal(runId: string, proposal: Proposal, beforeText: string | null): void {
    const state = this.run(runId);
    this.ensureCheckpoint(runId, proposal.path, beforeText);
    state.proposals.set(proposal.id, proposal);
    state.before.set(proposal.id, { path: proposal.path, text: beforeText });
    state.order.push(proposal.id);
  }

  getProposal(runId: string, id: string): Proposal | undefined {
    return this.run(runId).proposals.get(id);
  }

  /** Pre-proposal text, for staging the review buffer. */
  beforeText(runId: string, id: string): string | null | undefined {
    return this.run(runId).before.get(id)?.text;
  }

  decide(runId: string, id: string, hunkId: string, decision: 'accepted' | 'rejected'): void {
    const hunk = this.run(runId).proposals.get(id)?.hunks.find((h) => h.id === hunkId);
    if (hunk) {
      hunk.decision = decision;
    }
  }

  /** Find a staged proposal by its call hash (tool calls carry no run id). */
  findByHash(callHash: string): { runId: string; proposal: Proposal } | undefined {
    for (const [runId, state] of this.runs) {
      for (const proposal of state.proposals.values()) {
        if (proposal.callHash === callHash) {
          return { runId, proposal };
        }
      }
    }
    return undefined;
  }

  /** Final text for a fully-decided proposal, or throws. */
  finalizedText(runId: string, id: string): { path: string; text: string; before: string | null } {
    const state = this.run(runId);
    const proposal = state.proposals.get(id);
    const before = state.before.get(id);
    if (!proposal || !before) {
      throw new Error('unknown proposal');
    }
    if (proposal.hunks.some((h) => !h.decision)) {
      throw new Error('proposal was never reviewed');
    }
    return {
      path: proposal.path,
      text: ProposalStore.acceptedText(before.text ?? '', proposal),
      before: before.text,
    };
  }

  /** Restore the most recently added proposal to its pre-proposal text. */
  undoLast(runId: string): Restore[] {
    const state = this.run(runId);
    const last = state.order.pop();
    if (!last) {
      return [];
    }
    const before = state.before.get(last);
    state.before.delete(last);
    state.proposals.delete(last);
    return before ? [{ path: before.path, text: before.text }] : [];
  }

  /** Restore every file the run touched; delete files it created. */
  undoRun(runId: string): Restore[] {
    const state = this.run(runId);
    const restores = [...state.checkpoints].map(([path, text]) => ({ path, text }));
    this.runs.delete(runId);
    return restores;
  }

  /** Final text after applying only the accepted hunks. */
  static acceptedText(beforeText: string, proposal: Proposal): string {
    const accepted = new Set(
      proposal.hunks.filter((h) => h.decision === 'accepted').map((h) => h.id),
    );
    return applyHunks(beforeText, proposal.hunks, accepted);
  }
}

// ---------------------------------------------------------------------------
// Editor IO: the only file mutations in the extension.
// ---------------------------------------------------------------------------

function uriFor(rootDir: string, relPath: string): vscode.Uri {
  return api().Uri.joinPath(api().Uri.file(rootDir), relPath);
}

/** Current text, or null when the file does not exist. */
export async function readText(rootDir: string, relPath: string): Promise<string | null> {
  try {
    return (await api().workspace.openTextDocument(uriFor(rootDir, relPath))).getText();
  } catch {
    return null;
  }
}

/** Replace a document's full text; optionally save. */
export async function applyText(
  rootDir: string,
  relPath: string,
  text: string,
  save: boolean,
): Promise<void> {
  const { Range, WorkspaceEdit } = api();
  const uri = uriFor(rootDir, relPath);
  const doc = await api().workspace.openTextDocument(uri);
  const full = new Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const edit = new WorkspaceEdit();
  edit.replace(uri, full, text);
  if (!(await api().workspace.applyEdit(edit))) {
    throw new Error(`Could not apply edit to ${relPath}.`);
  }
  if (save) {
    await doc.save();
  }
}

/** Write a brand-new file (or restore one) straight to disk. */
export async function writeFile(
  rootDir: string,
  relPath: string,
  text: string,
): Promise<void> {
  await api().workspace.fs.writeFile(uriFor(rootDir, relPath), Buffer.from(text, 'utf8'));
}

/** Delete a file the run created. Missing files are ignored. */
export async function deleteFile(rootDir: string, relPath: string): Promise<void> {
  try {
    await api().workspace.fs.delete(uriFor(rootDir, relPath));
  } catch {
    // Already gone; undo is still complete.
  }
}

/** Apply undo restores: rewrite originals, delete created files. */
export async function applyRestores(rootDir: string, restores: Restore[]): Promise<void> {
  for (const restore of restores) {
    if (restore.text === null) {
      await deleteFile(rootDir, restore.path);
    } else {
      await applyText(rootDir, restore.path, restore.text, true);
    }
  }
}
