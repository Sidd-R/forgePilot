import * as path from 'node:path';
import type { ContextItem, ContextPack } from '../types';
import type { Chunk, CodeIndex } from './index';
import { estimateTokens } from './index';
import { tokenizeRequest } from './mentions';
import { baseNameNoExt, partnerFiles } from './partners';

interface Scored {
  chunk: Chunk;
  score: number;
  reasons: string[];
}

function matchedWords(chunk: Chunk, tokens: string[]): string[] {
  const hay = `${chunk.symbol ?? ''} ${chunk.signature} ${chunk.path}`.toLowerCase();
  const body = chunk.text.toLowerCase();
  return tokens.filter((token) => hay.includes(token) || body.includes(token)).slice(0, 3);
}

export interface PackOptions {
  budget: number;
  mentionedFiles?: string[];
  mentionedSymbols?: string[];
  activeFile?: string;
  openFiles?: string[];
  recentFiles?: string[];
}

/** Ranked, budgeted context pack with a reason attached to every pick. */
export function buildPack(
  index: CodeIndex,
  request: string,
  opts: PackOptions,
): ContextPack {
  const tokens = tokenizeRequest(request);
  const scored = new Map<string, Scored>();
  const get = (chunk: Chunk): Scored => {
    let entry = scored.get(chunk.id);
    if (!entry) {
      entry = { chunk, score: 0, reasons: [] };
      scored.set(chunk.id, entry);
    }
    return entry;
  };

  // 1. BM25 over chunks.
  for (const hit of index.search(tokens.join(' '), 40)) {
    const entry = get(hit.chunk);
    entry.score += hit.score;
    const words = matchedWords(hit.chunk, tokens);
    if (words.length > 0) {
      entry.reasons.push(`matched "${words.join('", "')}"`);
    }
  }

  // 2. Exact symbol and filename boosts.
  const lowered = new Set(tokens);
  for (const chunk of index.chunks) {
    if (chunk.symbol && lowered.has(chunk.symbol.toLowerCase())) {
      const entry = get(chunk);
      entry.score += 10;
      entry.reasons.push(`symbol match: ${chunk.symbol}`);
    }
    const fileWord = baseNameNoExt(chunk.path).toLowerCase();
    if (fileWord.length >= 3 && lowered.has(fileWord)) {
      const entry = get(chunk);
      entry.score += 5;
      entry.reasons.push(`filename match: ${chunk.path}`);
    }
  }

  // 3. Editor locality boosts.
  const locality = new Map<string, { score: number; reason: string }>();
  if (opts.activeFile) {
    locality.set(opts.activeFile, { score: 4, reason: 'active file' });
  }
  for (const file of opts.openFiles ?? []) {
    locality.set(file, { score: 2, reason: 'open tab' });
  }
  for (const file of opts.recentFiles ?? []) {
    if (!locality.has(file)) {
      locality.set(file, { score: 2, reason: 'recently edited' });
    }
  }
  for (const chunk of index.chunks) {
    const boost = locality.get(chunk.path);
    if (boost) {
      const entry = get(chunk);
      entry.score += boost.score;
      entry.reasons.push(boost.reason);
    }
  }

  // 4. Partner + co-change expansion from the top files.
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const topFiles = [...new Set(ranked.slice(0, 8).map((entry) => entry.chunk.path))];
  const known = new Set(index.chunks.map((chunk) => chunk.path));
  const firstChunkOf = (file: string): Chunk | undefined =>
    index.chunks.find((chunk) => chunk.path === file);
  for (const file of topFiles.slice(0, 5)) {
    for (const partner of partnerFiles(file, known)) {
      const kind = partner.includes('test')
        ? 'test'
        : partner.endsWith('.rst') || partner.endsWith('.md')
          ? 'doc'
          : '';
      const reason = kind
        ? `${kind} partner of ${path.basename(file)}`
        : `partner of ${path.basename(file)}`;
      const chunks = index.chunks.filter((c) => c.path === partner);
      if (chunks.every((c) => !scored.has(c.id)) && chunks.length > 0) {
        get(chunks[0]);
      }
      for (const chunk of chunks) {
        const entry = scored.get(chunk.id);
        if (!entry) {
          continue;
        }
        entry.score += 2;
        if (!entry.reasons.includes(reason)) {
          entry.reasons.push(reason);
        }
      }
    }
    for (const co of index.cochange.get(file) ?? []) {
      const chunk = firstChunkOf(co.file);
      if (!chunk) {
        continue;
      }
      const entry = get(chunk);
      entry.score += 1.5;
      const reason = `changed with ${path.basename(file)} in ${co.count} commits`;
      if (!entry.reasons.includes(reason)) {
        entry.reasons.push(reason);
      }
    }
  }

  // 5. Explicit mentions first, each capped at half the budget.
  const items: ContextItem[] = [];
  let used = 0;
  const pushChunk = (chunk: Chunk, reason: string, full: boolean): boolean => {
    const text = full ? chunk.text : `${chunk.signature}${chunk.doc ? `\n${chunk.doc}` : ''}`;
    const tokensUsed = full ? chunk.tokens : estimateTokens(text);
    if (used + tokensUsed > opts.budget) {
      return false;
    }
    used += tokensUsed;
    items.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: full ? chunk.endLine : chunk.startLine,
      symbol: chunk.symbol,
      reason,
      tokens: tokensUsed,
      text,
    });
    return true;
  };
  const mentionCap = Math.floor(opts.budget / 2);
  for (const file of opts.mentionedFiles ?? []) {
    let fileUsed = 0;
    for (const chunk of index.chunks.filter((c) => c.path === file)) {
      if (fileUsed + chunk.tokens > mentionCap || used + chunk.tokens > opts.budget) {
        break;
      }
      fileUsed += chunk.tokens;
      used += chunk.tokens;
      items.push({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbol: chunk.symbol,
        reason: 'mentioned by user',
        tokens: chunk.tokens,
        text: chunk.text,
      });
    }
  }
  for (const symbol of opts.mentionedSymbols ?? []) {
    for (const entry of index.symbols.get(symbol) ?? []) {
      const chunk = index.chunks.find(
        (c) => c.path === entry.path && c.startLine === entry.startLine,
      );
      if (chunk && used + chunk.tokens <= opts.budget) {
        used += chunk.tokens;
        items.push({
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
          reason: 'mentioned by user',
          tokens: chunk.tokens,
          text: chunk.text,
        });
      }
    }
  }

  // 6. Automatic picks in rank order, max 3 chunks per file. Full text
  // until 60% of the budget is spent, then signature summaries.
  const perFile = new Map<string, number>();
  for (const file of opts.mentionedFiles ?? []) {
    perFile.set(file, 99);
  }
  const ordered = [...scored.values()].sort((a, b) => b.score - a.score);
  for (const entry of ordered) {
    const count = perFile.get(entry.chunk.path) ?? 0;
    if (count >= 3) {
      continue;
    }
    const full = used < opts.budget * 0.6 || ordered.indexOf(entry) < 3;
    const reason = entry.reasons.join('; ') || 'related';
    if (!pushChunk(entry.chunk, reason, full)) {
      continue;
    }
    perFile.set(entry.chunk.path, count + 1);
  }

  // 7. Repo outline last, only if it fits.
  let outline: string | undefined;
  const outlineFiles = [...new Set([...topFiles, ...index.repoMap.keys()])].slice(0, 30);
  const outlineText = outlineFiles
    .map((file) => `${file}: ${(index.repoMap.get(file) ?? []).slice(0, 12).join(', ')}`)
    .join('\n');
  const outlineTokens = estimateTokens(outlineText);
  if (outlineText && used + outlineTokens <= opts.budget) {
    outline = outlineText;
    used += outlineTokens;
  }

  return { items, totalTokens: used, budget: opts.budget, outline };
}
