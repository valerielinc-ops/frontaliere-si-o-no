// @vitest-environment node
/**
 * Ratchet of the class behind issue 5253 ("Audit Parser Quality: lo strict
 * fallisce senza che il motivo arrivi alla issue").
 *
 * The diagnostic failure reporter (.github/actions/report-failure) in its
 * in-job form runs while its own job is still in progress, and GitHub does not
 * serve the log of a running job. The excerpt that names the CAUSE therefore
 * reaches the issue only through `diag-file` (written by an earlier step) or
 * the post-job form `log-from-job`. Without either the issue body says
 * "nessun estratto disponibile" and whoever triages restarts from the run log.
 *
 * Every `mode: report` use of the reporter must name one of the two sources.
 * The pre-existing exceptions are frozen below: the list may only SHRINK — a
 * new reporter without an excerpt source fails, and an entry that gained one
 * fails too until it is removed from the list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const WORKFLOWS_DIR = path.resolve(process.cwd(), '.github/workflows');
const REPORTER_USES_RE = /(?:^|\/)\.github\/actions\/report-failure(?:@|$)/;

// `<workflow file>#<job id>` — in-job reporters that still have no excerpt
// source. Each needs its own diag file wired to the step that fails; do not
// add entries.
const FROZEN_WITHOUT_EXCERPT_SOURCE = new Set([
  'audit-duplicate-crawlers.yml#audit',
  'deploy-publish.yml#deploy',
  'generate-article.yml#generate',
  'post-deploy-validate-live.yml#validate-live',
  'traffic-scheduler.yml#collect',
  'translate-pending-logic.yml#translate',
  'translate-pending.yml#translate',
]);

type Step = { uses?: string; with?: Record<string, unknown> };

function reportersWithoutExcerptSource(): { all: string[]; missing: Set<string> } {
  const all: string[] = [];
  const missing = new Set<string>();
  for (const file of fs.readdirSync(WORKFLOWS_DIR).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const doc = YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
    for (const [jobId, job] of Object.entries<{ steps?: Step[] }>(doc?.jobs || {})) {
      for (const step of job?.steps || []) {
        if (!REPORTER_USES_RE.test(String(step?.uses || ''))) continue;
        const inputs = step.with || {};
        if (String(inputs.mode || 'report') !== 'report') continue;
        const key = `${file}#${jobId}`;
        all.push(key);
        const diag = String(inputs['diag-file'] || '').trim();
        const logJob = String(inputs['log-from-job'] || '').trim();
        if (!diag && !logJob) missing.add(key);
      }
    }
  }
  return { all, missing };
}

describe('report-failure: every reporter names an excerpt source (issue 5253 class)', () => {
  const { all, missing } = reportersWithoutExcerptSource();

  it('finds the reporter uses it is supposed to check', () => {
    expect(all.length).toBeGreaterThan(0);
    expect(all).toContain('audit-parser-quality.yml#audit');
  });

  it('no new reporter without diag-file or log-from-job', () => {
    const unexpected = [...missing].filter((key) => !FROZEN_WITHOUT_EXCERPT_SOURCE.has(key));
    expect(unexpected, 'wire a diag-file (in-job) or log-from-job (post-job) for these reporters').toEqual([]);
  });

  it('the frozen list only shrinks: an entry that gained an excerpt source must be removed', () => {
    const stale = [...FROZEN_WITHOUT_EXCERPT_SOURCE].filter((key) => !missing.has(key));
    expect(stale, 'remove these entries from FROZEN_WITHOUT_EXCERPT_SOURCE').toEqual([]);
  });
});
