import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  CARRY_FORWARD_MARKER,
  decideNoCodeDeltaTier,
  postCarryForward,
  renderCarryForwardBody,
  verifyCarryForwardReview,
} from '../scripts/ci/lib/review-carry-forward.mjs';
import {
  MAX_BODY_REREVIEWS_PER_HEAD,
  admissionCli,
  shouldAdmitBodyReReview,
} from '../scripts/ci/lib/pr-review-admission.mjs';
import { reviewInputRevisionFromBody } from '../scripts/ci/lib/review-input-revision.mjs';
import { runReviewGate } from '../scripts/ci/review-gate.mjs';

const HEAD = 'a'.repeat(40);
const PRIOR = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);
const FP = 'f'.repeat(64);
const OTHER_FP = 'e'.repeat(64);
const REVIEW_REVISION = reviewInputRevisionFromBody('');
const CLEAN = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';
const IMPORTANT = '## Findings (Important: 1, Nit: 0)\n\n`scripts/lib/foo.mjs:L12`: 🔴 Important: pagination is incomplete.\n';
const BODY_IMPORTANT = '## Findings (Important: 1, Nit: 0)\n\n`PR body:L4`: 🔴 Important: bullet senza stato.\n';

function review(id: number, body: string, commit_id: string, submitted_at: string, login = 'frontaliere-automation[bot]') {
  return { id, user: { type: 'Bot', login }, state: 'COMMENTED', body, commit_id, submitted_at };
}

const sameFp = () => FP;

function carried(id: number, from: { id: number; commit: string }, submitted_at = '2026-09-19T12:00:00Z', fp = FP) {
  return review(id, renderCarryForwardBody({ priorReviewId: String(from.id), priorCommit: from.commit, fingerprint: fp, reviewRevision: REVIEW_REVISION }), HEAD, submitted_at);
}

describe('decideNoCodeDeltaTier', () => {
  const lgtm = review(10, CLEAN, PRIOR, '2026-09-19T11:00:00Z');

  it('carries an approving verdict when the contribution fingerprint is identical', () => {
    const decision = decideNoCodeDeltaTier({ reviews: [[lgtm]], headSha: HEAD, priorCommit: PRIOR, fpHead: FP, fpPrior: FP });
    expect(decision).toMatchObject({ tier: 'carry-forward', priorReviewId: '10', priorCommit: PRIOR, fingerprint: FP });
  });

  it('asks for a minimal review when the previous verdict was not approving', () => {
    const decision = decideNoCodeDeltaTier({
      reviews: [review(11, IMPORTANT, PRIOR, '2026-09-19T11:00:00Z')], headSha: HEAD, priorCommit: PRIOR, fpHead: FP, fpPrior: FP,
    });
    expect(decision.tier).toBe('minimal');
  });

  it.each([
    ['fingerprint differs', { fpHead: FP, fpPrior: OTHER_FP }],
    ['head fingerprint unknown', { fpHead: 'NULL', fpPrior: FP }],
    ['prior fingerprint unknown', { fpHead: FP, fpPrior: '' }],
  ])('falls back to a full review when the %s', (_label, fps) => {
    expect(decideNoCodeDeltaTier({ reviews: [lgtm], headSha: HEAD, priorCommit: PRIOR, ...fps }).tier).toBe('full');
  });

  it('refuses when the latest verdict is not on the compared commit', () => {
    const later = review(12, IMPORTANT, OLDER, '2026-09-19T11:30:00Z');
    expect(decideNoCodeDeltaTier({ reviews: [lgtm, later], headSha: HEAD, priorCommit: PRIOR, fpHead: FP, fpPrior: FP }).tier).toBe('full');
  });

  it('ignores reviews by non-managed identities', () => {
    const human = review(13, CLEAN, PRIOR, '2026-09-19T11:00:00Z', 'someone');
    human.user.type = 'User';
    expect(decideNoCodeDeltaTier({ reviews: [human], headSha: HEAD, priorCommit: PRIOR, fpHead: FP, fpPrior: FP }).tier).toBe('full');
  });
});

describe('verifyCarryForwardReview', () => {
  const lgtm = review(10, CLEAN, PRIOR, '2026-09-19T11:00:00Z');

  it('accepts a carried LGTM whose origin and fingerprints re-derive', () => {
    const carry = carried(20, { id: 10, commit: PRIOR });
    expect(verifyCarryForwardReview({ review: carry, reviews: [lgtm, carry], headSha: HEAD, fingerprintFn: sameFp }).ok).toBe(true);
  });

  it('rejects when the recomputed fingerprint changed', () => {
    const carry = carried(20, { id: 10, commit: PRIOR });
    const fingerprintFn = (sha: string) => (sha === HEAD ? OTHER_FP : FP);
    expect(verifyCarryForwardReview({ review: carry, reviews: [lgtm, carry], headSha: HEAD, fingerprintFn }).ok).toBe(false);
  });

  it('rejects when the fingerprint cannot be computed', () => {
    const carry = carried(20, { id: 10, commit: PRIOR });
    expect(verifyCarryForwardReview({ review: carry, reviews: [lgtm, carry], headSha: HEAD, fingerprintFn: () => null }).ok).toBe(false);
    expect(verifyCarryForwardReview({ review: carry, reviews: [lgtm, carry], headSha: HEAD, fingerprintFn: () => { throw new Error('boom'); } }).ok).toBe(false);
  });

  it('rejects an origin that was not approving or is not the latest verdict', () => {
    const red = review(10, IMPORTANT, PRIOR, '2026-09-19T11:00:00Z');
    const carry = carried(20, { id: 10, commit: PRIOR });
    expect(verifyCarryForwardReview({ review: carry, reviews: [red, carry], headSha: HEAD, fingerprintFn: sameFp }).ok).toBe(false);
    const laterRed = review(15, IMPORTANT, OLDER, '2026-09-19T11:30:00Z');
    expect(verifyCarryForwardReview({ review: carry, reviews: [lgtm, laterRed, carry], headSha: HEAD, fingerprintFn: sameFp }).ok).toBe(false);
  });

  it('rejects a marker that lies about the origin commit or sits on another HEAD', () => {
    const lying = carried(20, { id: 10, commit: OLDER });
    expect(verifyCarryForwardReview({ review: lying, reviews: [lgtm, lying], headSha: HEAD, fingerprintFn: sameFp }).ok).toBe(false);
    const carry = carried(20, { id: 10, commit: PRIOR });
    expect(verifyCarryForwardReview({ review: carry, reviews: [lgtm, carry], headSha: OLDER, fingerprintFn: sameFp }).ok).toBe(false);
  });

  it('follows a chain of carried verdicts back to a real LGTM', () => {
    const first = { ...carried(20, { id: 10, commit: OLDER }), commit_id: PRIOR };
    const origin = review(10, CLEAN, OLDER, '2026-09-19T10:00:00Z');
    const second = carried(30, { id: 20, commit: PRIOR }, '2026-09-19T13:00:00Z');
    expect(verifyCarryForwardReview({ review: second, reviews: [origin, first, second], headSha: HEAD, fingerprintFn: sameFp }).ok).toBe(true);
    const redOrigin = review(10, IMPORTANT, OLDER, '2026-09-19T10:00:00Z');
    expect(verifyCarryForwardReview({ review: second, reviews: [redOrigin, first, second], headSha: HEAD, fingerprintFn: sameFp }).ok).toBe(false);
  });
});

describe('review gate on a carried verdict', () => {
  const lgtm = review(10, CLEAN, PRIOR, '2026-09-19T11:00:00Z');

  it('approves the new HEAD only after re-verifying the carry', async () => {
    const carry = carried(20, { id: 10, commit: PRIOR });
    const ok = await runReviewGate({ repo: 'owner/repo', pr: 1, headSha: HEAD, reviews: [[lgtm, carry]], mutate: false, carryFingerprintFn: sameFp });
    expect(ok.approved).toBe(true);
    const changed = await runReviewGate({
      repo: 'owner/repo', pr: 1, headSha: HEAD, reviews: [[lgtm, carry]], mutate: false,
      carryFingerprintFn: (sha: string) => (sha === HEAD ? OTHER_FP : FP),
    });
    expect(changed.approved).toBe(false);
    expect(changed.reason).toContain('carry-forward non verificato');
  });

  it('still refuses a plain LGTM on an older commit', async () => {
    const result = await runReviewGate({ repo: 'owner/repo', pr: 1, headSha: HEAD, reviews: [[lgtm]], mutate: false, carryFingerprintFn: sameFp });
    expect(result.approved).toBe(false);
  });
});

describe('postCarryForward', () => {
  function fakeGh(reviews: unknown[], head = HEAD) {
    const posts: string[] = [];
    const ghFn = (args: string[], input?: string) => {
      if (args.includes('--method')) { posts.push(String(input)); return {}; }
      if (args[1].endsWith('/reviews')) return [reviews];
      return { state: 'open', body: '', head: { sha: head } };
    };
    return { ghFn, posts };
  }
  const target = { repo: 'owner/repo', pr: '1', head: HEAD, priorReviewId: '10', priorCommit: PRIOR, fingerprint: FP };

  it('posts one marked LGTM on the exact HEAD', () => {
    const { ghFn, posts } = fakeGh([review(10, CLEAN, PRIOR, '2026-09-19T11:00:00Z')]);
    expect(postCarryForward({ ...target, ghFn, fingerprintFn: sameFp }).posted).toBe(true);
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(posts[0]);
    expect(payload.commit_id).toBe(HEAD);
    expect(payload.body).toContain(CARRY_FORWARD_MARKER);
    expect(payload.body).toMatch(/^## LGTM$/m);
  });

  it('refuses to post when the HEAD moved or the origin is not approving', () => {
    const moved = fakeGh([review(10, CLEAN, PRIOR, '2026-09-19T11:00:00Z')], OLDER);
    expect(() => postCarryForward({ ...target, ghFn: moved.ghFn, fingerprintFn: sameFp })).toThrow();
    const red = fakeGh([review(10, IMPORTANT, PRIOR, '2026-09-19T11:00:00Z')]);
    expect(() => postCarryForward({ ...target, ghFn: red.ghFn, fingerprintFn: sameFp })).toThrow(/rifiutato/);
    expect(red.posts).toHaveLength(0);
  });

  it('is idempotent on a rerun', () => {
    const { ghFn, posts } = fakeGh([review(10, CLEAN, PRIOR, '2026-09-19T11:00:00Z'), carried(20, { id: 10, commit: PRIOR })]);
    expect(postCarryForward({ ...target, ghFn, fingerprintFn: sameFp }).posted).toBe(false);
    expect(posts).toHaveLength(0);
  });
});

describe('body re-review on the same HEAD', () => {
  const red = review(10, BODY_IMPORTANT, HEAD, '2026-09-19T11:00:00Z');

  it('admits a re-review when the body was edited after a non-approving verdict', () => {
    expect(shouldAdmitBodyReReview({ headSha: HEAD, reviews: [red], bodyEditedAt: '2026-09-19T11:05:00Z' })).toBe(true);
  });

  it('does not admit when the edit predates the verdict, is unknown, or the verdict was LGTM', () => {
    expect(shouldAdmitBodyReReview({ headSha: HEAD, reviews: [red], bodyEditedAt: '2026-09-19T10:55:00Z' })).toBe(false);
    expect(shouldAdmitBodyReReview({ headSha: HEAD, reviews: [red], bodyEditedAt: 'none' })).toBe(false);
    const lgtm = review(11, CLEAN, HEAD, '2026-09-19T11:00:00Z');
    expect(shouldAdmitBodyReReview({ headSha: HEAD, reviews: [lgtm], bodyEditedAt: '2026-09-19T11:05:00Z' })).toBe(false);
  });

  it('caps the verdicts one HEAD can buy through body edits', () => {
    const many = Array.from({ length: MAX_BODY_REREVIEWS_PER_HEAD + 1 }, (_, index) =>
      review(20 + index, BODY_IMPORTANT, HEAD, `2026-09-19T11:0${index}:00Z`));
    expect(shouldAdmitBodyReReview({ headSha: HEAD, reviews: many, bodyEditedAt: '2026-09-19T12:00:00Z' })).toBe(false);
  });

  it('exposes the decision through the guard CLI', () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => { out.push(chunk); return true; };
    const errWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: () => boolean }).write = () => true;
    try {
      admissionCli([
        'node', 'x', 'skip', '--head', HEAD,
        '--revision', reviewInputRevisionFromBody(''),
        '--body-edited-at', '2026-09-19T11:05:00Z',
      ], JSON.stringify([[red]]));
    } finally {
      (process.stdout as unknown as { write: typeof write }).write = write;
      (process.stderr as unknown as { write: typeof errWrite }).write = errWrite;
    }
    expect(out.join('')).toContain('skip=false');
    expect(out.join('')).toContain('body_rereview=true');
  });
});

describe('tests.yml wiring', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.vitest.steps as Array<{ id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> }>;
  const byId = (id: string) => steps.find((step) => step.id === id);

  it('no longer turns an empty code delta into a full review without trying the carry', () => {
    const tier = byId('tier')?.run || '';
    expect(tier).toContain('review-carry-forward.mjs" decide');
    expect(tier).toContain('pr-contribution-fingerprint.mjs" "$HEAD_SHA"');
    expect(tier).toContain('set_tier carry-forward none 0');
    expect(tier).not.toContain("Nessun delta-code nei file PR dall'ultima review → review piena.\"\n");
    expect(tier).toContain('BODY_REREVIEW');
  });

  it('publishes the carry without a model and keeps the model off that tier', () => {
    const carry = byId('carry_forward_review');
    expect(carry?.if).toContain("steps.tier.outputs.tier == 'carry-forward'");
    expect(carry?.run).toContain('review-carry-forward.mjs" post');
    for (const id of ['prefetch', 'codex_review', 'review_abort']) {
      expect(byId(id)?.if).toContain("steps.tier.outputs.tier != 'carry-forward'");
    }
    const order = steps.map((step) => step.id);
    expect(order.indexOf('carry_forward_review')).toBeLessThan(order.indexOf('review_gate'));
  });

  it('feeds the guard with the body edit time', () => {
    expect(byId('guard')?.run).toContain('lastEditedAt');
    expect(byId('guard')?.run).toContain('--body-edited-at');
  });
});

// Replay del tier step di `tests.yml` con il suo bash vero: fetch, compare e
// fingerprint sono stub, `review-carry-forward.mjs decide` e i filtri jq sono
// quelli reali. Caso #9968 (review 5327152883 sull'head 3b348916): un merge di
// autorebase porta #9947/#9949, che toccano `services/locales/*-core.ts`, gli
// stessi file della PR. Il compare dall'ultima review vede quindi 4 file code
// della PR, ma il contributo è identico: il tier deve riusare il verdetto.
describe('tier step: fingerprint before the code delta (#9968)', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.vitest as { env: Record<string, string>; steps: Array<{ id?: string; run?: string }> };
  const tierRun = job.steps.find((step) => step.id === 'tier')?.run || '';
  const libDir = fileURLToPath(new URL('../scripts/ci/lib', import.meta.url));
  const pages = JSON.parse(readFileSync(new URL('./fixtures/review-replay/pr-9968-reviews.json', import.meta.url), 'utf8')) as Array<Array<{ id: number; commit_id: string; submitted_at: string }>>;
  const HEAD_9968 = '3b348916e69d99a4c7d3b04e630a1eac0a4614de';
  const PRIOR_9968 = 'ed4e4abe62331a754663be9bb8a9fd491e317316';
  const PR_FILES = [
    'components/community/JobBoard.tsx',
    'components/community/RewardedApplicationOffer.tsx',
    'services/assistedApplicationExperiment.ts',
    'services/locales/de-core.ts',
    'services/locales/en-core.ts',
    'services/locales/fr-core.ts',
    'services/locales/it-core.ts',
    'services/offerwallClickGate.ts',
    'services/rewardedApplicationAccess.ts',
  ];
  // Il compare 2-dot dopo il merge di main: i 4 locale della PR (toccati
  // anche da #9947/#9949) più file che la PR non tocca.
  const COMPARE_FILES = [
    'services/locales/de-core.ts',
    'services/locales/en-core.ts',
    'services/locales/fr-core.ts',
    'services/locales/it-core.ts',
    'services/jobAlertsDigest.ts',
    'data/jobs-stats-history.json',
  ];

  function runTier({ reviewPages, fps }: { reviewPages: unknown; fps: Record<string, string> }) {
    const dir = mkdtempSync(join(tmpdir(), 'tier-replay-'));
    try {
      const ci = join(dir, 'policy', 'scripts', 'ci');
      mkdirSync(ci, { recursive: true });
      symlinkSync(libDir, join(ci, 'lib'));
      writeFileSync(join(dir, 'reviews.json'), JSON.stringify(reviewPages));
      writeFileSync(join(dir, 'compare.json'), JSON.stringify({ files: COMPARE_FILES.map((filename) => ({ filename })) }));
      writeFileSync(join(ci, 'fps.json'), JSON.stringify(fps));
      writeFileSync(join(ci, 'fetch-pr-files.mjs'), `process.stdout.write(JSON.stringify(${JSON.stringify({
        files: PR_FILES, count: PR_FILES.length, expected: PR_FILES.length, complete: true,
      })}));\n`);
      writeFileSync(join(ci, 'review-test-policy.mjs'), [
        "import { readFileSync } from 'node:fs';",
        "if (process.argv[2] === 'filter') process.stdout.write(readFileSync(0, 'utf8'));",
        'else process.exitCode = 1;',
        '',
      ].join('\n'));
      writeFileSync(join(ci, 'pr-contribution-fingerprint.mjs'), [
        "import { readFileSync } from 'node:fs';",
        "const fps = JSON.parse(readFileSync(new URL('./fps.json', import.meta.url), 'utf8'));",
        "process.stdout.write(`${fps[process.argv[2]] ?? 'NULL'}\\n`);",
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'gh.cjs'), [
        "const { readFileSync } = require('node:fs');",
        "const { execFileSync } = require('node:child_process');",
        'const args = process.argv.slice(2);',
        "const path = args[1] || '';",
        "const jqAt = args.indexOf('--jq');",
        'const jq = jqAt >= 0 ? args[jqAt + 1] : null;',
        "const runJq = (value) => execFileSync('jq', ['-r', jq], { input: JSON.stringify(value), encoding: 'utf8' });",
        'if (/\\/compare\\//.test(path)) {',
        "  const compare = JSON.parse(readFileSync(`${__dirname}/compare.json`, 'utf8'));",
        '  process.stdout.write(jq ? runJq(compare) : JSON.stringify(compare));',
        '} else if (/\\/pulls\\/\\d+\\/reviews$/.test(path)) {',
        "  const reviewPages = JSON.parse(readFileSync(`${__dirname}/reviews.json`, 'utf8'));",
        "  if (args.includes('--slurp')) process.stdout.write(JSON.stringify(reviewPages));",
        "  else process.stdout.write(reviewPages.map(runJq).join(''));",
        '} else {',
        '  process.exitCode = 1;',
        '}',
        '',
      ].join('\n'));
      const gh = join(dir, 'gh');
      writeFileSync(gh, `#!/usr/bin/env bash\nexec node "${join(dir, 'gh.cjs')}" "$@"\n`);
      chmodSync(gh, 0o755);
      const output = join(dir, 'github-output');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', tierRun], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GITHUB_OUTPUT: output,
          REVIEW_POLICY_ROOT: join(dir, 'policy'),
          TRUSTED_GH_BIN: gh,
          PR_NUMBER: '9968',
          HEAD_SHA: HEAD_9968,
          REPO: 'valerielinc-ops/frontaliere-si-o-no',
          BODY_REREVIEW: '',
          NONCODE_RE: job.env.NONCODE_RE,
        },
      });
      const outputs: Record<string, string> = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const before = (at: string) => pages.map((page) => page.filter((entry) => entry.submitted_at < at));
  const reviewsOneToFour = before('2026-09-26T19:30:00Z');
  const SAME = 'a'.repeat(64);

  it('replays #9968: 4 PR locale files in the compare, identical fingerprints, reviews 1-4 → carry-forward', () => {
    const run = runTier({ reviewPages: reviewsOneToFour, fps: { [HEAD_9968]: SAME, [PRIOR_9968]: SAME } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs.tier).toBe('carry-forward');
    expect(run.outputs.carry_prior_review).toBe('5327040158');
    expect(run.outputs.carry_prior_commit).toBe(PRIOR_9968);
    expect(run.outputs.incremental_base).toBeUndefined();
    expect(run.stdout).toContain('delta-code portato dalla base (4 file PR nel compare)');
  });

  it('keeps the incremental review when the contribution fingerprint changed', () => {
    const run = runTier({ reviewPages: reviewsOneToFour, fps: { [HEAD_9968]: SAME, [PRIOR_9968]: 'b'.repeat(64) } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs.tier).toBe('incremental');
    expect(run.outputs.incremental_base).toBe(PRIOR_9968);
    expect(run.outputs.carry_prior_review).toBeUndefined();
  });

  it.each([
    ['the HEAD fingerprint is NULL', { [PRIOR_9968]: SAME }],
    ['both fingerprints are NULL', {}],
  ])('keeps the incremental review when %s', (_label, fps: Record<string, string>) => {
    const run = runTier({ reviewPages: reviewsOneToFour, fps });
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs.tier).toBe('incremental');
    expect(run.outputs.incremental_base).toBe(PRIOR_9968);
  });

  it('turns an identical contribution after a non-approving verdict into minimal, not incremental', () => {
    const reviewsOneToTwo = before('2026-09-26T18:45:00Z');
    const prior = reviewsOneToTwo.flat().at(-1)!.commit_id;
    const run = runTier({ reviewPages: reviewsOneToTwo, fps: { [HEAD_9968]: SAME, [prior]: SAME } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs.tier).toBe('minimal');
    expect(run.outputs.code_unchanged_since).toBe(prior);
    expect(run.outputs.incremental_base).toBeUndefined();
  });
});
