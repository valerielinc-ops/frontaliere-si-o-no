// Recupero fail-closed dei worktree che lo sweep storico lasciava in
// REPORT-ONLY. Questo percorso non cancella mai branch e non usa `git status`:
// gli sparse worktree possono avere un index incoerente, quindi la decisione
// sul contenuto reale viene da HEAD + hash-object dei file sul disco.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { classifyRealChanges } from './worktree-dirty.mjs';

export const DEFAULT_RECLAIM_IDLE_MINUTES = 60;
export const DEFAULT_RECLAIM_FREE_BYTES = 10 * 1024 ** 3;
const GH_LIMIT = 1000;
const CANONICAL_NAME = 'Valerie Linc';
const CANONICAL_EMAIL = 'valerielinc@gmail.com';

function git(repoPath, args, {
  allowFail = false,
  input,
  env = {},
  maxBuffer = 256 * 1024 * 1024,
} = {}) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', repoPath, ...args], {
      encoding: 'utf8',
      input,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer,
    }).trimEnd();
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}
function canonical(pathname) {
  const absolute = resolve(pathname);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function pathIsInside(parent, child) {
  const root = canonical(parent);
  const candidate = canonical(child);
  const suffix = relative(root, candidate);
  return suffix === '' || (!suffix.startsWith('..') && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

function parsePositiveNumber(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function reclaimIdleMs(env = process.env) {
  return parsePositiveNumber(env.PRUNE_RECLAIM_IDLE_MINUTES, DEFAULT_RECLAIM_IDLE_MINUTES) * 60 * 1000;
}

export function reclaimFreeThresholdBytes(env = process.env) {
  return parsePositiveNumber(
    env.PRUNE_RECLAIM_MIN_FREE_BYTES ?? env.PRUNE_WORKTREE_RECLAIM_MIN_FREE_BYTES,
    DEFAULT_RECLAIM_FREE_BYTES,
  );
}

export function diskFreeBytes(pathname = process.cwd()) {
  try {
    const raw = execFileSync('df', ['-Pk', pathname], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    });
    const line = raw.trim().split('\n').filter(Boolean).pop();
    const fields = line?.trim().split(/\s+/) || [];
    const availableKiB = Number(fields[3]);
    return Number.isFinite(availableKiB) && availableKiB >= 0 ? availableKiB * 1024 : null;
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'sconosciuto';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

function parseWorktrees(raw) {
  const entries = [];
  let current;
  for (const line of String(raw).split('\n')) {
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length),
        branch: null,
        head: null,
        detached: false,
        locked: false,
        prunable: false,
      };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  return entries.filter((entry) => entry.path);
}

function worktreeAdminDir(pathname) {
  return git(pathname, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
}

function currentWorktree(repoPath) {
  return git(repoPath, ['rev-parse', '--show-toplevel'], { allowFail: true });
}

function isIsolationPath(pathname) {
  return /[/\\]\.(?:claude[/\\]worktrees|worktrees|wt)[/\\]/.test(pathname);
}

function isHooksMain(pathname) {
  return basename(canonical(pathname)) === 'hooks-main' && isIsolationPath(canonical(pathname));
}

function processCwds() {
  try {
    const output = execFileSync('lsof', ['-a', '-d', 'cwd', '-F', 'n'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
    });
    return {
      known: true,
      paths: output.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1)),
    };
  } catch (error) {
    const output = typeof error?.stdout === 'string' ? error.stdout : '';
    const paths = output.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
    return { known: paths.length > 0, paths };
  }
}

function pathBytes(pathname) {
  if (!existsSync(pathname)) return 0;
  try {
    const output = execFileSync('du', ['-sk', pathname], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    }).trim();
    const kilobytes = Number.parseInt(output.split(/\s+/)[0], 10);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
  } catch {
    return 0;
  }
}

function lastActivityMs(pathname, adminDir, changes) {
  let newest = 0;
  for (const signal of [join(adminDir, 'HEAD'), join(adminDir, 'logs', 'HEAD')]) {
    try { newest = Math.max(newest, statSync(signal).mtimeMs); } catch { /* signal assente */ }
  }
  for (const entry of changes.significantEntries || []) {
    if (entry.missing) continue;
    try { newest = Math.max(newest, lstatSync(join(pathname, entry.path)).mtimeMs); } catch { /* file rimosso nel frattempo */ }
  }
  return newest;
}

function signature(changes) {
  return JSON.stringify((changes.significantEntries || [])
    .map((entry) => [entry.path, entry.mode, entry.oid, Boolean(entry.missing)])
    .sort((a, b) => a[0].localeCompare(b[0])));
}

function normalizePr(raw) {
  if (!raw) return null;
  const state = raw.merged_at || raw.mergedAt ? 'MERGED' : String(raw.state || '').toUpperCase();
  return {
    number: raw.number,
    state,
    baseRefName: raw.baseRefName || raw.base?.ref || null,
    headRefName: raw.headRefName || raw.head?.ref || null,
    headRefOid: raw.headRefOid || raw.head?.sha || null,
  };
}

function ghPrList(state, branch = null) {
  const args = ['pr', 'list', '--state', state, '--limit', String(GH_LIMIT), '--json', 'number,state,baseRefName,headRefName,headRefOid,mergedAt'];
  if (branch) args.push('--head', branch);
  try {
    const raw = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
    });
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, records: [] };
    return { ok: true, records: parsed.map(normalizePr).filter(Boolean), complete: parsed.length < GH_LIMIT };
  } catch {
    return { ok: false, records: [], complete: false };
  }
}

function loadPrs() {
  const all = ghPrList('all');
  const open = ghPrList('open');
  if (!all.ok || !open.ok || !all.complete || !open.complete) return { available: false };
  return { available: true, all: all.records, open: open.records };
}

function resolvePr(prs, branch, head) {
  if (!prs.available) return { known: false, reason: 'stato PR non verificabile: gh indisponibile o lista troncata' };
  // For a branch, the branch name is the authoritative association. Matching
  // every worktree at the same SHA would misclassify a clean checkout of main
  // as a PR when a PR happens to point at that SHA. Detached worktrees have no
  // branch name, so the SHA association is the only useful signal there.
  const matches = branch
    ? prs.all.filter((pr) => pr.headRefName === branch)
    : prs.all.filter((pr) => head && pr.headRefOid === head);
  const openMatch = (branch
    ? prs.open.find((pr) => pr.headRefName === branch)
    : prs.open.find((pr) => head && pr.headRefOid === head));
  if (openMatch) return { known: true, pr: openMatch };
  if (matches.length) return { known: true, pr: matches[0] };
  if (!branch) return { known: true, pr: null };
  // The complete bulk list is enough for the normal case. The targeted query
  // also makes an explicit negative result available if GitHub returns a
  // future list larger than the safety limit.
  const targeted = ghPrList('all', branch);
  if (!targeted.ok || !targeted.complete) return { known: false, reason: `PR per ${branch} non verificabile` };
  const targetedMatches = targeted.records.filter((pr) => !head || pr.headRefOid === head);
  return {
    known: true,
    pr: targetedMatches.find((pr) => pr.state === 'OPEN') || targetedMatches[0] || null,
  };
}

function mainRef(repoPath, mainBranch) {
  return git(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${mainBranch}`], { allowFail: true })
    || git(repoPath, ['rev-parse', '--verify', `refs/heads/${mainBranch}`], { allowFail: true });
}

function aheadOfMain(repoPath, head, mainBranch) {
  const base = mainRef(repoPath, mainBranch);
  if (!base || !head) return null;
  const raw = git(repoPath, ['rev-list', '--left-right', '--count', `${base}...${head}`], { allowFail: true });
  const fields = raw.split(/\s+/).filter(Boolean).map(Number);
  return fields.length === 2 && fields.every(Number.isFinite) ? fields[1] : null;
}

function upstreamGone(repoPath, branch) {
  if (!branch) return false;
  return git(repoPath, ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`], { allowFail: true }).includes('gone');
}

function safeName(pathname) {
  return basename(pathname)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'worktree';
}

function dateStamp(now) {
  return new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
}

function uniqueTag(repoPath, base, expected) {
  for (let suffix = 0; suffix < 100; suffix++) {
    const tag = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const existing = git(repoPath, ['rev-parse', '--verify', `${tag}^{commit}`], { allowFail: true });
    if (!existing) return tag;
    if (existing === expected) return tag;
  }
  throw new Error(`troppi tag già presenti per ${base}`);
}

function canonicalGitEnv(extra = {}) {
  return {
    GIT_AUTHOR_NAME: CANONICAL_NAME,
    GIT_AUTHOR_EMAIL: CANONICAL_EMAIL,
    GIT_COMMITTER_NAME: CANONICAL_NAME,
    GIT_COMMITTER_EMAIL: CANONICAL_EMAIL,
    ...extra,
  };
}

function createCommitSnapshot({ repoPath, pathname, head, branch, detached, changes, now }) {
  if (!head || !changes.significantEntries.length) return null;
  // Keep the temporary index under the repository root. Besides avoiding an
  // accidental cross-filesystem rename, this makes the operation compatible
  // with the isolated fixture sandbox used by the CI tests; the directory is
  // removed in `finally` and is never tracked.
  const temp = mkdtempSync(join(repoPath, '.frontaliere-reclaim-index-'));
  const indexPath = join(temp, 'index');
  const env = canonicalGitEnv({ GIT_INDEX_FILE: indexPath });
  try {
    git(pathname, ['read-tree', head], { env });
    for (const entry of changes.significantEntries) {
      if (entry.missing) {
        git(pathname, ['update-index', '--remove', '--', entry.path], { env });
        continue;
      }
      const fullPath = join(pathname, entry.path.split('/').join(sep));
      const oid = entry.kind === 'symlink'
        ? git(pathname, ['hash-object', '-w', '--no-filters', '--stdin'], { env, input: readlinkSync(fullPath) })
        : git(pathname, ['hash-object', '-w', '--no-filters', '--', entry.path], { env });
      git(pathname, ['update-index', '--add', '--cacheinfo', `${entry.mode},${oid},${entry.path}`], { env });
    }
    const tree = git(pathname, ['write-tree'], { env });
    const label = branch || safeName(pathname);
    const message = `Snapshot worktree ${label} ${dateStamp(now)}\n`;
    const commit = git(pathname, ['commit-tree', tree, '-p', head], { env, input: message });
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('commit-tree non ha restituito un SHA valido');
    const base = `snapshot/${safeName(pathname)}${detached ? '-head' : ''}-${dateStamp(now)}`;
    const tag = uniqueTag(repoPath, base, commit);
    if (!git(repoPath, ['rev-parse', '--verify', `${tag}^{commit}`], { allowFail: true })) {
      git(repoPath, ['tag', tag, commit], { env: canonicalGitEnv() });
    }
    const verified = git(repoPath, ['rev-parse', '--verify', `${tag}^{commit}`], { allowFail: true });
    if (verified !== commit) throw new Error(`tag ${tag} non punta al commit snapshot`);
    return { tag, commit, created: true };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function createDetachedHeadTag({ repoPath, pathname, head, now }) {
  if (!head) throw new Error('HEAD detached mancante');
  const base = `snapshot/${safeName(pathname)}-head-${dateStamp(now)}`;
  const tag = uniqueTag(repoPath, base, head);
  if (!git(repoPath, ['rev-parse', '--verify', `${tag}^{commit}`], { allowFail: true })) {
    git(repoPath, ['tag', tag, head], { env: canonicalGitEnv() });
  }
  const verified = git(repoPath, ['rev-parse', '--verify', `${tag}^{commit}`], { allowFail: true });
  if (verified !== head) throw new Error(`tag ${tag} non punta a HEAD`);
  return { tag, commit: head, created: true };
}

function snapshotForCandidate({ repoPath, candidate, now }) {
  if (candidate.changes.significantEntries.length) {
    return createCommitSnapshot({
      repoPath,
      pathname: candidate.path,
      head: candidate.head,
      branch: candidate.branch,
      detached: candidate.detached,
      changes: candidate.changes,
      now,
    });
  }
  if (candidate.detached) return createDetachedHeadTag({ repoPath, pathname: candidate.path, head: candidate.head, now });
  return null;
}

function isBusy(pathname, processState) {
  return processState.paths.some((cwd) => pathIsInside(pathname, cwd));
}

function selected(only, entry) {
  if (!only) return true;
  return only === entry.branch || only === entry.path || only === canonical(entry.path);
}

function candidateReason({ pr, detached, ahead, changes, idleMinutes }) {
  const source = pr ? `PR ${pr.state}` : 'nessuna PR';
  const dirty = changes.significantEntries.length ? `, ${changes.significantEntries.length} modifica/e reale/i` : ', contenuto pulito';
  return `${source}, ahead=${ahead}${detached ? ', HEAD detached' : ''}${dirty}, inattivo >= ${idleMinutes} min`;
}

function collectCandidates({ repoPath, mainBranch, only, idleMs, now }) {
  const records = parseWorktrees(git(repoPath, ['worktree', 'list', '--porcelain'], { allowFail: true }));
  const current = canonical(currentWorktree(repoPath) || process.cwd());
  const processState = processCwds();
  const prs = loadPrs();
  const candidates = [];
  const reports = [];

  for (const entry of records) {
    if (!isIsolationPath(entry.path)) continue;
    if (!selected(only, entry)) continue;
    const report = (reason) => reports.push({ ...entry, reason });
    const path = canonical(entry.path);
    if (path === current) { report('checkout corrente — KEEP'); continue; }
    if (isHooksMain(path)) { report('worktree infrastrutturale hooks-main — KEEP'); continue; }
    if (entry.locked) { report('worktree LOCKED — KEEP'); continue; }
    if (entry.prunable) { report('directory assente (prunable) — KEEP'); continue; }
    if (entry.branch === mainBranch) { report('branch default — KEEP'); continue; }
    if (!processState.known) { report('processi non verificabili: lsof indisponibile — KEEP'); continue; }
    if (isBusy(path, processState)) { report('in uso: processo con cwd dentro il worktree — KEEP'); continue; }

    const head = entry.head || (entry.branch ? git(repoPath, ['rev-parse', '--verify', `refs/heads/${entry.branch}`], { allowFail: true }) : '');
    if (!head) { report('HEAD non leggibile — KEEP'); continue; }
    // Classify first with `prExists=false`: a local PR body is real work until
    // GitHub proves that the PR exists. Re-run only after the association is
    // known so a merged/open PR body can be treated as tool scratch safely.
    const unfilteredChanges = classifyRealChanges(path, { prExists: false });
    if (unfilteredChanges.error) { report(`contenuto non classificabile (${unfilteredChanges.errorMessage || 'errore hash/index'}) — KEEP`); continue; }
    const prResolution = resolvePr(prs, entry.branch, head);
    if (!prResolution.known) { report(`${prResolution.reason} — KEEP`); continue; }
    const pr = prResolution.pr;
    if (pr?.state === 'OPEN') { report('PR aperta — KEEP, lavoro vivo'); continue; }
    const changes = pr ? classifyRealChanges(path, { prExists: true }) : unfilteredChanges;
    if (changes.error) { report(`contenuto non classificabile (${changes.errorMessage || 'errore hash/index'}) — KEEP`); continue; }

    const admin = worktreeAdminDir(path);
    const activity = admin ? lastActivityMs(path, admin, changes) : 0;
    if (!activity || now - activity < idleMs) {
      const age = activity ? Math.max(0, Math.floor((now - activity) / 60000)) : 0;
      report(`attività recente (${age} min, soglia ${Math.round(idleMs / 60000)} min) — KEEP`);
      continue;
    }
    const ahead = aheadOfMain(repoPath, head, mainBranch);
    if (ahead === null) { report('confronto con main non verificabile — KEEP'); continue; }
    candidates.push({
      ...entry,
      path,
      head,
      changes,
      activity,
      ahead,
      pr,
      signature: signature(changes),
      reason: candidateReason({ pr, detached: entry.detached, ahead, changes, idleMinutes: idleMs / 60000 }),
      upstreamGone: upstreamGone(repoPath, entry.branch),
    });
  }
  return { candidates, reports, processState, prsAvailable: prs.available };
}

function recheckCandidate(repoPath, candidate, mainBranch, idleMs, now) {
  if (!existsSync(candidate.path)) return { ok: false, reason: 'directory non più presente' };
  const processState = processCwds();
  if (!processState.known || isBusy(candidate.path, processState)) return { ok: false, reason: 'processo attivo o lsof non verificabile' };
  const head = git(candidate.path, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  if (head !== candidate.head) return { ok: false, reason: 'HEAD cambiato durante lo sweep' };
  const changes = classifyRealChanges(candidate.path, { prExists: Boolean(candidate.pr) });
  if (changes.error) return { ok: false, reason: changes.errorMessage || 'classificazione hash fallita' };
  if (signature(changes) !== candidate.signature) return { ok: false, reason: 'contenuto reale cambiato durante lo sweep' };
  const admin = worktreeAdminDir(candidate.path);
  const activity = admin ? lastActivityMs(candidate.path, admin, changes) : 0;
  if (activity !== candidate.activity || now - activity < idleMs) return { ok: false, reason: 'attività cambiata durante lo sweep' };
  if (aheadOfMain(repoPath, head, mainBranch) === null) return { ok: false, reason: 'confronto con main non più verificabile' };
  return { ok: true, changes };
}

export function runWorktreeReclaim({
  apply = false,
  only = null,
  automatic = false,
  freeBytes = undefined,
  freeThresholdBytes = reclaimFreeThresholdBytes(),
  idleMs = reclaimIdleMs(),
  repoPath = process.cwd(),
  mainBranch = 'main',
  now = Date.now(),
} = {}) {
  const repoRoot = git(repoPath, ['rev-parse', '--show-toplevel'], { allowFail: true }) || resolve(repoPath);
  const measuredFree = freeBytes === undefined ? diskFreeBytes(repoRoot) : freeBytes;
  const { candidates, reports, processState, prsAvailable } = collectCandidates({
    repoPath: repoRoot,
    mainBranch,
    only,
    idleMs,
    now,
  });
  const thresholdLine = `spazio libero=${formatBytes(measuredFree)}; soglia=${formatBytes(freeThresholdBytes)}`;
  console.log(`[reclaim] ${automatic ? 'trigger automatico' : '--reclaim'} | ${thresholdLine} | inattività >= ${Math.round(idleMs / 60000)} min | gh=${prsAvailable ? 'ok' : 'UNAVAILABLE'} | mode=${apply ? 'APPLY' : 'dry-run'}`);
  if (!processState.known) console.log('[reclaim] lsof non verificabile: nessun worktree può essere rimosso.');
  console.log(`[reclaim] candidati=${candidates.length}; report-only/protetti=${reports.length}`);
  for (const candidate of candidates) {
    console.log(`  - ${candidate.path}${candidate.branch ? ` [${candidate.branch}]` : ' (detached)'} — ${candidate.reason}${candidate.upstreamGone ? ' — upstream-GONE' : ''}${candidate.changes.significantEntries.length ? ' — snapshot prima della rimozione' : candidate.detached ? ' — tag HEAD prima della rimozione' : ''}`);
  }
  for (const report of reports) console.log(`  • KEEP ${report.path}${report.branch ? ` [${report.branch}]` : ''} — ${report.reason}`);

  if (!apply) {
    const planned = candidates.reduce((sum, candidate) => sum + pathBytes(candidate.path), 0);
    console.log(`[reclaim] dry-run: niente rimosso; snapshot/tag da creare ${candidates.filter((candidate) => candidate.changes.significantEntries.length || candidate.detached).length}; spazio recuperabile stimato ${formatBytes(planned)}.`);
    return { candidates, reports, removed: 0, snapshots: [], spaceRecoveredBytes: 0, dryRun: true };
  }

  let removed = 0;
  let spaceRecoveredBytes = 0;
  let failed = 0;
  const snapshots = [];
  for (const candidate of candidates) {
    const before = pathBytes(candidate.path);
    const rechecked = recheckCandidate(repoRoot, candidate, mainBranch, idleMs, Date.now());
    if (!rechecked.ok) {
      failed++;
      console.log(`⚠️  [reclaim] SALTATO ${candidate.path}: ${rechecked.reason} — lasciato intatto`);
      continue;
    }
    let snapshot;
    try {
      snapshot = snapshotForCandidate({ repoPath: repoRoot, candidate: { ...candidate, changes: rechecked.changes }, now: Date.now() });
    } catch (error) {
      failed++;
      console.log(`⚠️  [reclaim] SNAPSHOT FALLITO ${candidate.path}: ${error?.message || 'errore sconosciuto'} — worktree lasciato intatto`);
      continue;
    }
    if (snapshot) {
      snapshots.push({ ...snapshot, path: candidate.path });
      console.log(`[reclaim] snapshot ${snapshot.tag} -> ${snapshot.commit.slice(0, 12)}`);
    }
    let removedByGit = false;
    try {
      git(repoRoot, ['worktree', 'remove', '--force', candidate.path]);
      removedByGit = !existsSync(candidate.path);
    } catch {
      removedByGit = false;
    }
    if (!removedByGit) {
      failed++;
      console.log(`⚠️  [reclaim] RIMOZIONE FALLITA ${candidate.path}: lasciato intatto${snapshot ? ` (snapshot ${snapshot.tag} conservato)` : ''}`);
      continue;
    }
    removed++;
    spaceRecoveredBytes += before;
    console.log(`[reclaim] rimosso ${candidate.path} (${formatBytes(before)})`);
  }
  const freeAfter = diskFreeBytes(repoRoot);
  const measuredDelta = Number.isFinite(measuredFree) && Number.isFinite(freeAfter) ? Math.max(0, freeAfter - measuredFree) : null;
  console.log(`[reclaim] report finale: worktree rimossi=${removed}; snapshot creati=${snapshots.length}; falliti/protetti in apply=${failed}; spazio recuperato da du=${formatBytes(spaceRecoveredBytes)}; delta df=${formatBytes(measuredDelta)}.`);
  // No branch deletion is intentionally present in this mode. The caller can
  // inspect the retained branch or recover a tag with `git worktree add`.
  return { candidates, reports, removed, snapshots, failed, spaceRecoveredBytes, measuredDelta, dryRun: false };
}
