#!/usr/bin/env node
/**
 * Ammissibilità zero-Claude degli item che parlano della macchina.
 * `scripts/lib/` è prodotto; un errore di rete/gh resta sempre fail-open.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const repositoryWorkflowDirectory = path.resolve(MODULE_DIR, '..', '..', '..', '.github', 'workflows');
const workflowFilePattern = /\.ya?ml$/i;
const MACHINE_ROOTS = ['scripts/ci', '.github/workflows'];
const validRunConclusions = new Set([
  'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out',
  'action_required', 'stale', 'startup_failure',
]);

function normalizePath(value) {
  return String(value || '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/:L?\d+$/i, '');
}

/** Path citati nel testo, senza eventuali suffissi di riga. */
export function citedPaths(text) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const candidate = normalizePath(value);
    if (!/^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/?$/.test(candidate)) return;
    if (candidate.includes('://') || seen.has(candidate)) return;
    seen.add(candidate);
    out.push(candidate);
  };
  for (const match of String(text || '').matchAll(/`([^`\n]+)`/g)) add(match[1]);
  for (const match of String(text || '').matchAll(/(?:^|[\s("'`])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/?(?::L?\d+)?)(?=$|[\s),;"'`])/gm)) {
    add(match[1]);
  }
  return out;
}

function isMachinePath(candidate) {
  return MACHINE_ROOTS.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when a workflow's `run:` block references `targetScript`. */
function workflowExecutesScript(source, targetScript) {
  const reference = new RegExp(
    `(?:^|[^A-Za-z0-9_.\\/-])(?:\\./)?${escapedRegExp(targetScript)}(?=$|[^A-Za-z0-9_.\\/-])`,
  );
  const lines = String(source || '').split('\n');
  let runIndent = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (/^(?:-\s+)?run:\s*/.test(trimmed)) {
      runIndent = indent;
      const inline = trimmed.replace(/^(?:-\s+)?run:\s*/, '').replace(/\s+#.*$/, '');
      if (reference.test(inline)) return true;
      continue;
    }
    if (runIndent === null) continue;
    if (indent <= runIndent) {
      runIndent = null;
      continue;
    }
    if (reference.test(line.replace(/\s+#.*$/, ''))) return true;
  }
  return false;
}

function workflowFiles(workflowDirectory) {
  return fs.readdirSync(workflowDirectory).filter((entry) => workflowFilePattern.test(entry));
}

/** `reject` è un fatto del testo; `unknown` è un errore di lettura locale. */
function resolveWorkflows(paths, workflowDirectory) {
  let files;
  try {
    files = workflowFiles(workflowDirectory);
  } catch {
    return { kind: 'unknown', workflows: [] };
  }

  const resolved = new Set();
  for (const cited of paths) {
    if (cited.startsWith('.github/workflows/')) {
      const filename = cited.slice('.github/workflows/'.length);
      if (!files.includes(filename)) return { kind: 'reject', workflows: [] };
      resolved.add(filename);
      continue;
    }

    let matched = false;
    for (const filename of files) {
      let source;
      try {
        source = fs.readFileSync(path.join(workflowDirectory, filename), 'utf8');
      } catch {
        return { kind: 'unknown', workflows: [] };
      }
      if (workflowExecutesScript(source, cited)) {
        resolved.add(filename);
        matched = true;
      }
    }
    if (!matched) return { kind: 'reject', workflows: [] };
  }
  return { kind: 'resolved', workflows: [...resolved].sort() };
}

function defaultGetRuns(workflow) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const args = ['run', 'list'];
  if (repo) args.push('--repo', repo);
  args.push('--workflow', workflow, '--limit', '3', '--json', 'status,conclusion,createdAt');
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 20 });
  const runs = JSON.parse(raw);
  if (!Array.isArray(runs)) throw new Error('gh run list ha restituito una forma inattesa');
  return runs;
}

function runTimestamp(run) {
  const value = Date.parse(run?.createdAt || run?.created_at || '');
  return Number.isFinite(value) ? value : NaN;
}

function orderedCompletedRuns(runs) {
  return runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => typeof run?.conclusion === 'string' && run.conclusion.length > 0)
    .sort((a, b) => {
      const at = runTimestamp(a.run);
      const bt = runTimestamp(b.run);
      return Number.isFinite(at) && Number.isFinite(bt) && at !== bt ? bt - at : a.index - b.index;
    })
    .map(({ run }) => run);
}

/** Classifica lo storico di un singolo workflow dopo una lettura riuscita. */
function workflowBroken(runs) {
  if (!Array.isArray(runs)) return 'unknown';
  if (runs.length === 0) return 'broken'; // prova che il gate non gira affatto
  if (!runs.every((run) => run && typeof run === 'object'
    && Object.prototype.hasOwnProperty.call(run, 'conclusion')
    && (run.conclusion === null || validRunConclusions.has(run.conclusion)))) return 'unknown';
  const completed = orderedCompletedRuns(runs);
  if (completed.length < 2) return 'healthy';
  return completed[0].conclusion === 'failure' && completed[1].conclusion === 'failure'
    ? 'broken'
    : 'healthy';
}

/**
 * Valuta l'ammissibilità della macchina citata da un item.
 *
 * @param {string} text
 * @param {{workflowDirectory?: string, getRuns?: (workflow: string) => unknown, cache?: Map<string, string>}} [opts]
 * @returns {'not-machine'|'admit'|'reject'|'unknown'}
 */
export function machineAdmission(text, opts = {}) {
  try {
    const paths = citedPaths(text);
    if (!paths.length || !paths.every(isMachinePath)) return 'not-machine';

    const resolution = resolveWorkflows(paths, opts.workflowDirectory || repositoryWorkflowDirectory);
    if (resolution.kind === 'reject') return 'reject';
    if (resolution.kind !== 'resolved') return 'unknown';

    const getRuns = typeof opts.getRuns === 'function' ? opts.getRuns : defaultGetRuns;
    const cache = opts.cache instanceof Map ? opts.cache : new Map();
    let uncertain = false;
    for (const workflow of resolution.workflows) {
      let state = cache.get(workflow);
      if (!state) {
        try {
          state = workflowBroken(getRuns(workflow));
        } catch {
          state = 'unknown';
        }
        cache.set(workflow, state);
      }
      if (state === 'broken') return 'admit';
      if (state === 'unknown') uncertain = true;
    }
    return uncertain ? 'unknown' : 'reject';
  } catch {
    // Un errore di infrastruttura non può cancellare un item reale.
    return 'unknown';
  }
}
