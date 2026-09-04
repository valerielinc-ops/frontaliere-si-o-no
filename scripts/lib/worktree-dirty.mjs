// Separa lo sporco di un worktree che è LAVORO da quello che è rumore di
// macchina.
//
// Un worktree "DIRTY" non è di per sé lavoro da salvare. Misurato il
// 2026-09-04 sui 21 worktree accumulati in questo clone: lo sporco era output
// di cron (`data/gsc-orphan-queries-clusters.json`, `data/jobs/by-crawler/*`,
// `data/parser-quality-report.json`) oppure il blocco che `gitnexus analyze`
// aveva iniettato in AGENTS.md — quattro worktree, 49 righe identiche.
// Trattarlo come lavoro impediva a `prune-merged-worktrees.mjs` di rimuovere
// worktree la cui PR era già mergiata.
//
// Gli ignorati vengono restituiti separatamente, mai scartati in silenzio: chi
// chiama li conta e li riporta.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isCronManagedPath } from './cron-managed-paths.mjs';

// Blocco che `gitnexus analyze` inietta in un file markdown tracciato.
const GITNEXUS_BLOCK_RE = /<!-- gitnexus:start -->[\s\S]*?<!-- gitnexus:end -->/g;

// Tolto il blocco restano le righe vuote che lo circondavano: vanno
// normalizzate, altrimenti due file identici nel contenuto risultano diversi
// per il solo spazio lasciato dal ritaglio. Il prezzo e' che una modifica di
// SOLE righe vuote a un .md non conta come lavoro — accettabile: non e' un
// motivo per tenere in vita un worktree la cui PR e' gia' mergiata.
export function stripGitnexusBlocks(text) {
  return String(text).replace(GITNEXUS_BLOCK_RE, '').replace(/\n{2,}/g, '\n\n').trim();
}

// Il porcelain v1 è `XY<spazio>PATH`. NON usare un helper che fa trim
// sull'output: il trim mangia lo spazio iniziale della prima riga
// (` M file` → `M file`) e sfasa il campo di stato di un carattere.
export function parsePorcelainPaths(porcelain) {
  const paths = [];
  for (const line of String(porcelain).split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3).trim();
    // Rename/copy: `R  vecchio -> nuovo`. Conta la destinazione.
    const filePath = (rest.includes(' -> ') ? rest.split(' -> ').pop() : rest).replace(/^"|"$/g, '');
    if (filePath) paths.push(filePath);
  }
  return paths;
}

// Puro: decide su una lista di path già estratta, con il predicato "questo
// scarto è solo il blocco gitnexus?" iniettato — così il test non ha bisogno
// di un worktree vero.
export function classifyDirtyPaths(paths, { isCronManaged = isCronManagedPath, isGitnexusOnly = () => false } = {}) {
  const significant = [];
  const ignored = [];
  for (const filePath of paths) {
    if (isCronManaged(filePath) || isGitnexusOnly(filePath)) ignored.push(filePath);
    else significant.push(filePath);
  }
  return { significant, ignored };
}

function statusPorcelain(wtPath) {
  try {
    return execSync(`git -C "${wtPath}" status --porcelain`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return ''; }
}

// Vero solo se, tolti i blocchi gitnexus da entrambi i lati, il file coincide
// con quello in HEAD: cioè lo scarto è TUTTO e SOLO il blocco iniettato dal
// tool. Nessuna euristica sul nome del file — un'altra modifica allo stesso
// file sopravvive allo strip e resta significativa.
export function isOnlyGitnexusBlock(wtPath, filePath) {
  if (!filePath.toLowerCase().endsWith('.md')) return false;
  let head;
  try {
    head = execSync(`git -C "${wtPath}" show HEAD:"${filePath}"`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return false; }
  if (!head) return false;
  let current;
  try { current = readFileSync(join(wtPath, filePath), 'utf8'); } catch { return false; }
  return stripGitnexusBlocks(current) === stripGitnexusBlocks(head);
}

export function classifyDirty(wtPath) {
  return classifyDirtyPaths(parsePorcelainPaths(statusPorcelain(wtPath)), {
    isGitnexusOnly: (filePath) => isOnlyGitnexusBlock(wtPath, filePath),
  });
}
