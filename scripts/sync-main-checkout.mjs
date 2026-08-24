#!/usr/bin/env node
// Tiene il checkout BASE (non-worktree) di questo repo allineato a origin/main.
// Pensato per girare in CODA a prune-merged-worktrees.mjs nello stesso hook
// SessionStart: riusa il fetch che quello ha già fatto, quindi qui non c'è
// nessun fetch/lock di rete — solo un merge --ff-only locale, single-flight
// contro la corsa sull'.git/index se due sessioni partono nello stesso istante.
//
// Perché esiste (incidente 2026-08-24, workspace frontaliereticino.ch): gli
// hook della root (`~/Projects/frontaliere/.claude/settings.json`) girano
// SEMPRE con cwd=root e un path letterale "frontaliere-si-o-no/scripts/...",
// quindi puntano sempre al checkout BASE — mai al worktree in cui una sessione
// lavora davvero. Se il checkout base finisce parcheggiato su un altro branch
// (una sessione ci ha lavorato dentro direttamente, in violazione di
// worktree-first — osservati 8 branch `zz-probe-*` il 21-08, mai tornata su
// main), ogni sessione aperta dalla root eredita quello stato: la PR #6340 ha
// aggiunto scripts/ci/pr-watch-gate.mjs su main il 24-08, il checkout stale non
// ce l'aveva, e OGNI sessione ha rotto il proprio Stop hook con
// MODULE_NOT_FOUND finché qualcuno non se n'è accorto.
//
// Fail-safe by construction, coerente con AGENTS.md ("mai edit/stage/stash/
// restore/commit/rebase/merge sul local main salvo richiesta esplicita user" —
// qui la richiesta esplicita è questo hook stesso): agisce SOLO se il checkout
// è già su `main` (mai un checkout proprio) ED è pulito — AGENTS.md tollera
// foreign work sporco sul local main ("data/jobs/*.json stale"), e su quello
// non tocchiamo nulla. Il merge è SOLO --ff-only: se main locale e origin/main
// sono divergenti non fa niente, mai un merge/rebase che riscrive storia.
//
// Self-locating via import.meta.url (stesso pattern di sibling-check-gate.mjs)
// e non da cwd: è esattamente la classe di bug per cui questo script esiste.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withSingleFlightLock } from './lib/single-flight-lock.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // fail-safe: qualunque errore git → non tocchiamo nulla
  }
}

export function shouldSync({ branch, dirty }) {
  return branch === 'main' && dirty !== null && dirty.length === 0;
}

function run() {
  if (!existsSync(path.join(REPO, '.git'))) return;
  const gitCommonDir = git(['rev-parse', '--git-common-dir']);
  const lockPath = path.resolve(REPO, gitCommonDir || '.git', 'frontaliere-sync-main-checkout.lock');

  withSingleFlightLock(lockPath, () => {
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const dirty = git(['status', '--porcelain']);
    if (!shouldSync({ branch, dirty })) return;
    git(['merge', '--ff-only', 'origin/main', '--quiet']);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
