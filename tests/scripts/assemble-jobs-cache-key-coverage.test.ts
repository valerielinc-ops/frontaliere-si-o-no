// @vitest-environment node
/**
 * Observer for the assemble-jobs cache key (computeAssembleInputFingerprint).
 *
 * The send-* workflows (job alerts, company alerts, newsletter, saved-jobs
 * digest) restore `.cache/assemble-jobs/<key>` from GitHub Actions and mail the
 * restored `data/jobs.json`. A tracked data file that the assembly reads but
 * the key does not hash is a FALSE HIT: stale output replayed after the file
 * changed. This test scans every module of the assembler's local import closure
 * for `data/...` paths and fails when one is neither hashed (slice directories,
 * ASSEMBLE_AUX_DATA_INPUTS), nor an output of the assembly, nor listed below
 * with the reason it cannot change the output.
 *
 * It also pins the workflow side: every workflow that caches the assembler's
 * output keys actions/cache on the script's own `--print-cache-key` (through
 * .github/actions/assemble-jobs-cache-key; no second, weaker hashFiles()
 * definition), the send-* ones without a restore-keys fallback, and the
 * newsletter no longer turns a failed assembly into a green step with `|| echo`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSEMBLE_AUX_DATA_INPUTS,
  listAssembleCodeClosure,
} from '../../scripts/assemble-jobs-dataset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Hashed by computeAssembleInputFingerprint as the slice inputs.
const SLICE_DIRS = [
  'data/jobs/by-crawler',
  'data/jobs/expired/by-crawler',
  'data/jobs-crawler-summaries/by-crawler',
];

// Written by the assembly (or by --stats), gitignored or regenerated: they are
// outputs, not inputs of a fresh CI checkout.
const OUTPUTS = [
  'data/jobs.json',
  'data/expired-jobs.json',
  'data/jobs-meta.json',
  'data/jobs-crawler-summaries.json',
  'data/jobs-stats.json',
  'data/jobs-stats-history.json',
  'data/jobs-keys-snapshot.json',
];

// Named by a module of the closure but not read on the assembly path. Each
// entry must say why; adding one without a reason is the review point.
const NOT_ASSEMBLY_INPUTS: Record<string, string> = {
  'data/items': 'not a path: `data.items` field of an HTTP response in scripts/lib/ai-models.mjs',
  'data/translation-cache': 'crawler-time translation cache (dedicated-crawler-common loadTranslationCache), never read by assembleJobsDataset',
  'data/slug-registry.json': 'crawler-time slug registry (shared-jobs-crawler / dedicated-crawler-common), never read by assembleJobsDataset',
  '.cache/jobs-ai-cache.json': 'crawler-time AI cache (shared-jobs-crawler, ai-cache-budget), never read by assembleJobsDataset',
  'data/jobs-localization-memory.json': 'crawler-time localization memory (job-localization-pipeline), untracked',
  'data/jobs-crawler-audit.json': 'crawler audit written by shared-jobs-crawler, untracked',
  'data/seo-404-compat': 'shard naming helper only (shard-file-naming), not read by the assembly',
  'data/all-known-job-slugs': 'shard naming helper only (shard-file-naming), not read by the assembly',
};

const DATA_REF_RX = /'data'((?:\s*,\s*'[^']+')+)|['"`](data\/[A-Za-z0-9_.\/-]+)/g;

function extractDataRefs(src: string): string[] {
  const refs: string[] = [];
  for (const m of src.matchAll(DATA_REF_RX)) {
    let ref: string;
    if (m[1]) {
      const parts = [...m[1].matchAll(/'([^']+)'/g)].map((p) => p[1]);
      ref = ['data', ...parts].join('/');
    } else {
      ref = m[2];
    }
    // `data/orphan-enriched-data/part-NN.json` → the shard directory.
    ref = ref.replace(/\/part-NN\.json$/, '').replace(/\/+$/, '');
    refs.push(ref);
  }
  return refs;
}

function isUnder(ref: string, entry: string): boolean {
  return ref === entry || ref.startsWith(`${entry}/`);
}

describe('assemble-jobs cache key covers every data input of the closure', () => {
  const closure = listAssembleCodeClosure(path.join(REPO_ROOT, 'scripts', 'assemble-jobs-dataset.mjs'));

  it('walks a non-trivial closure (sanity: static, dynamic and worker imports)', () => {
    const rel = closure.map((f: string) => path.relative(REPO_ROOT, f));
    expect(rel).toContain('scripts/reconcile-job-slugs.mjs');
    expect(rel).toContain('scripts/lib/parse-job-slices-worker.mjs');
    expect(rel).toContain('scripts/lib/orphan-enriched-store.mjs');
    expect(closure.length).toBeGreaterThan(40);
    // Every entry resolves: a phantom path means the walker matched a comment.
    expect(rel.filter((f: string) => !existsSync(path.join(REPO_ROOT, f)))).toEqual([]);
  });

  it('every data/ path named in the closure is hashed, an output, or excluded with a reason', () => {
    const uncovered = new Map<string, string>();
    for (const file of closure) {
      // Unresolvable specifiers stay in the closure (hashed as missing:<path>).
      if (file.endsWith('.json') || !existsSync(file)) continue;
      const refs = extractDataRefs(readFileSync(file, 'utf8'));
      for (const ref of refs) {
        const covered =
          SLICE_DIRS.some((d) => isUnder(ref, d)) ||
          OUTPUTS.includes(ref) ||
          ASSEMBLE_AUX_DATA_INPUTS.some((a: string) => isUnder(ref, a)) ||
          Object.keys(NOT_ASSEMBLY_INPUTS).some((x) => isUnder(ref, x));
        // `data/jobs` / `data/jobs-crawler-summaries` as a parent of the slice dirs.
        const parentOfSlices = SLICE_DIRS.some((d) => d.startsWith(`${ref}/`));
        if (!covered && !parentOfSlices) uncovered.set(ref, path.relative(REPO_ROOT, file));
      }
    }
    expect(Object.fromEntries(uncovered)).toEqual({});
  });

  it('the exclusion list carries no stale entry an aux input already covers', () => {
    for (const excluded of Object.keys(NOT_ASSEMBLY_INPUTS)) {
      expect(ASSEMBLE_AUX_DATA_INPUTS.some((a: string) => isUnder(excluded, a))).toBe(false);
    }
  });
});

describe('workflows key the assemble-jobs cache on the assembler fingerprint', () => {
  const readWf = (wf: string) => readFileSync(path.join(REPO_ROOT, '.github', 'workflows', wf), 'utf8');

  it('the shared key action asks the assembler for its own key', () => {
    const action = readFileSync(
      path.join(REPO_ROOT, '.github', 'actions', 'assemble-jobs-cache-key', 'action.yml'),
      'utf8',
    );
    expect(action).toContain('node scripts/assemble-jobs-dataset.mjs --print-cache-key $ASSEMBLE_ARGS');
    // Only a well-formed key reaches the output; anything else leaves it empty.
    expect(action).toContain("grep -Eq '^[0-9a-f]{16}_[a-z_]+$'");
  });

  // Every workflow that caches .cache/assemble-jobs. A hashFiles() over a subset
  // of the inputs gives an exact actions/cache hit on a directory whose
  // internal key no longer matches: the script re-assembles and the save is
  // skipped because the key exists, run after run.
  const CACHING = [
    'deploy.yml',
    'tests.yml',
    'corpus-wide-gates.yml',
    'deploy-matrix-experiment.yml',
    'send-job-alerts.yml',
    'send-company-alerts.yml',
    'send-saved-jobs-digest.yml',
    'send-newsletter.yml',
  ];
  for (const wf of CACHING) {
    it(`${wf}: the key comes from the assembler, never from hashFiles()`, () => {
      const src = readWf(wf);
      expect(src).toContain('uses: ./.github/actions/assemble-jobs-cache-key');
      const keyLines = src.match(/key: assemble-jobs-[^\n]+/g) ?? [];
      expect(keyLines.length).toBeGreaterThan(0);
      for (const line of keyLines) {
        expect(line).toContain('steps.assemble_cache_key.outputs.key');
        expect(line).not.toContain('hashFiles(');
      }
    });
  }

  const SEND = ['send-job-alerts.yml', 'send-company-alerts.yml', 'send-saved-jobs-digest.yml', 'send-newsletter.yml'];
  for (const wf of SEND) {
    it(`${wf}: restore + save of its own entry, no restore-keys, save only after a finished assembly`, () => {
      const src = readWf(wf);
      expect(src).toContain('uses: actions/cache/restore@v5');
      expect(src).toContain('uses: actions/cache/save@v5');
      expect(src.match(/key: assemble-jobs-send-[^\n]+/g) ?? []).toHaveLength(2);
      // A prefix fallback would restore another fingerprint's directory: the
      // script would MISS anyway after a 70 MB download.
      expect(src).not.toMatch(/restore-keys:[^\n]*\n\s*assemble-jobs-/);
      expect(src).toMatch(/Save assemble-jobs cache\n\s*if: steps\.assemble\.outcome == 'success'/);
      expect(src).toMatch(/- name: Assemble jobs dataset[^\n]*\n\s*id: assemble\n/);
    });
  }

  it('send-newsletter.yml: a failed assembly is visible, not swallowed', () => {
    const src = readWf('send-newsletter.yml');
    const step = src.split('- name: Assemble jobs dataset from per-crawler slices')[1].split('\n      - name:')[0];
    expect(step).not.toMatch(/\|\|\s*echo/);
    expect(step).toContain('continue-on-error: true');
    expect(src).toMatch(/Report degraded newsletter[^\n]*\n\s*if: steps\.assemble\.outcome == 'failure'/);
    expect(src).toContain('::warning title=Newsletter degraded::');
    expect(src).toContain('GITHUB_STEP_SUMMARY');
    expect(src).toContain('--title "Newsletter degraded: jobs assembly failed"');
  });
});
