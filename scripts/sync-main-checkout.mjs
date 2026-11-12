#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
// Tiene il checkout BASE (non-worktree) di questo repo allineato a origin/main.
// Il workspace puo' indicare esplicitamente il checkout da controllare quando
// lo script viene eseguito dal worktree hooks-main.
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
// Il worktree che contiene questo script resta la sorgente; la destinazione
// esplicita deve essere il checkout principale dello stesso repository.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withSingleFlightLock } from './lib/single-flight-lock.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredTarget = process.env.FRONTALIERE_SYNC_MAIN_CHECKOUT_TARGET?.trim();
const TARGET_REPO = configuredTarget ? path.resolve(configuredTarget) : REPO;

function git(args, cwd = REPO) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // fail-safe: qualunque errore git → non tocchiamo nulla
  }
}

function commonGitDir(repo) {
  const commonDir = git(['rev-parse', '--git-common-dir'], repo);
  return commonDir ? path.resolve(repo, commonDir) : null;
}

export function shouldSync({ branch, dirty }) {
  return branch === 'main' && dirty !== null && dirty.length === 0;
}

function run() {
  if (!existsSync(path.join(REPO, '.git')) || !existsSync(path.join(TARGET_REPO, '.git'))) return;

  const sourceCommonDir = commonGitDir(REPO);
  const targetCommonDir = commonGitDir(TARGET_REPO);
  const targetGitDir = git(['rev-parse', '--git-dir'], TARGET_REPO);
  if (!sourceCommonDir || sourceCommonDir !== targetCommonDir || !targetGitDir) return;

  // Non seguire un env var verso un altro worktree: il target deve essere il
  // checkout base, il cui git-dir coincide con il common-dir.
  if (path.resolve(TARGET_REPO, targetGitDir) !== targetCommonDir) return;

  const lockPath = path.join(targetCommonDir, 'frontaliere-sync-main-checkout.lock');

  withSingleFlightLock(lockPath, () => {
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], TARGET_REPO);
    const dirty = git(['status', '--porcelain'], TARGET_REPO);
    if (!shouldSync({ branch, dirty })) return;
    git(['merge', '--ff-only', 'origin/main', '--quiet'], TARGET_REPO);
  });
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) run();
