/**
 * Invariants of the company-keyed demand table
 * (scripts/identify-top-marquee-by-gsc.mjs + refresh-gsc-marquee-demand.yml).
 *
 * The artifact this pair produces, data/gsc-top-marquee-candidates.json, is the
 * single missing input for a demand-aware employer-profile floor — see the
 * block comment in build-plugins/shared/employerProfileConfig.mjs, which names
 * "scheduling it and committing the artifact" as the whole remaining gap.
 *
 * Three ways this can regress silently, one describe block each:
 *   1) credentials resolve to a path that does not exist in CI — which is how
 *      the script sat unschedulable: it looked in `mcp-gsc-main/` FIRST, a
 *      directory that is not in the repo, so every CI run would have degraded
 *      before touching the network while looking fine on a developer machine;
 *   2) a degraded run overwrites a good demand table with an empty one — a
 *      floor reading that would demote on absent evidence;
 *   3) the workflow acquires a dependency it never installs, or starts paying
 *      for a full SEO deploy on every refresh.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveServiceAccount,
  // @ts-expect-error — plain .mjs, no type declarations
} from '../scripts/identify-top-marquee-by-gsc.mjs';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

const SCRIPT_PATH = 'scripts/identify-top-marquee-by-gsc.mjs';
const WORKFLOW_PATH = '.github/workflows/refresh-gsc-marquee-demand.yml';

const FAKE_SA = {
  type: 'service_account',
  client_email: 'gsc-service-account@frontaliere-ticino.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
};

function withTempSaFile(body: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gsc-marquee-sa-'));
  try {
    const p = join(dir, 'sa.json');
    writeFileSync(p, JSON.stringify(FAKE_SA));
    body(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveServiceAccount — CI credentials come first', () => {
  it('reads GOOGLE_APPLICATION_CREDENTIALS, the path every workflow writes', () => {
    withTempSaFile((p) => {
      const { sa, source } = resolveServiceAccount({ GOOGLE_APPLICATION_CREDENTIALS: p });
      expect(sa.client_email).toBe(FAKE_SA.client_email);
      expect(source).toBe('GOOGLE_APPLICATION_CREDENTIALS');
    });
  });

  it('falls back to the raw FIREBASE_SERVICE_ACCOUNT_JSON secret', () => {
    const { sa, source } = resolveServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(FAKE_SA) });
    expect(sa.client_email).toBe(FAKE_SA.client_email);
    expect(source).toBe('FIREBASE_SERVICE_ACCOUNT_JSON');
  });

  it('prefers the credentials FILE over the raw secret when both are present', () => {
    // Both are set in a workflow that runs the canonical "Prepare Firebase
    // credentials" step, and the file is the one the rest of the repo's Google
    // callers read (scripts/lib/evidence/gscFetcher.mjs materialises the secret
    // into exactly this path before using it).
    withTempSaFile((p) => {
      const { source } = resolveServiceAccount({
        GOOGLE_APPLICATION_CREDENTIALS: p,
        FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...FAKE_SA, client_email: 'other@example.com' }),
      });
      expect(source).toBe('GOOGLE_APPLICATION_CREDENTIALS');
    });
  });

  it('THROWS on a malformed credentials file instead of degrading to a local path', () => {
    // A broken CI secret must be loud. Silently falling through would turn a
    // misconfigured credential into "GSC had no data", i.e. into the exact
    // silent-empty-artifact failure the last-good rule exists to prevent.
    const dir = mkdtempSync(join(tmpdir(), 'gsc-marquee-bad-'));
    try {
      const p = join(dir, 'sa.json');
      writeFileSync(p, '{ not json');
      expect(() => resolveServiceAccount({ GOOGLE_APPLICATION_CREDENTIALS: p })).toThrow(
        /GOOGLE_APPLICATION_CREDENTIALS/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names all three sources when nothing is configured', () => {
    // `mcp-gsc-main/` is a developer-local convenience and is not in the repo;
    // if someone's checkout has one, the resolver correctly finds it and the
    // "nothing configured" branch is unreachable — assert whichever applies.
    const localDirPresent = existsSync(resolve('mcp-gsc-main'));
    if (localDirPresent) {
      expect(resolveServiceAccount({}).source).toMatch(/^mcp-gsc-main\//);
      return;
    }
    expect(() => resolveServiceAccount({})).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
    expect(() => resolveServiceAccount({})).toThrow(/FIREBASE_SERVICE_ACCOUNT_JSON/);
  });
});

describe('identify-top-marquee-by-gsc.mjs — last-good wins on degradation', () => {
  const src = read(SCRIPT_PATH);

  it('never writes the artifact from the degraded path', () => {
    // Once this file is committed, an `{ candidates: [], _error }` stub is not
    // a graceful degradation — it is a data refresh that replaces a good demand
    // table with an empty one, and a promotion floor reading it demotes on
    // absent evidence.
    const fn = /function failGracefully\([\s\S]*?\n}/.exec(src)?.[0];
    expect(fn, 'failGracefully must still exist').toBeDefined();
    expect(fn).not.toMatch(/writeOutput/);
    expect(fn).toMatch(/process\.exit\(0\)/);
  });

  it('treats an empty 90-day GSC read as a failure, not as zero demand', () => {
    expect(src).toMatch(/if \(!rows\.length\) \{\s*\n\s*return failGracefully\(/);
  });

  it('paginates and reports truncation, so a cut tail cannot pass as complete', () => {
    // GSC caps a response at 25 000 rows and never says so. It orders by clicks
    // desc, so the cut discards the low-click tail — precisely where the
    // below-floor employers this table exists to find are.
    expect(src).toMatch(/startRow: page \* ROW_LIMIT/);
    expect(src).toMatch(/_truncated: truncated/);
  });

  it('signs the JWT with the shared helper, not a fourth local copy', () => {
    // scripts/lib/google-service-account-token.mjs was extracted (#4837)
    // because this exact routine had already been duplicated twice.
    expect(src).toMatch(/from '\.\/lib\/google-service-account-token\.mjs'/);
    expect(src).not.toMatch(/createSign\(/);
  });

  it('does not run main() on import', () => {
    // The module exports resolveServiceAccount for this file; an unguarded
    // main() would run a live GSC pull — and its process.exit — inside vitest.
    expect(src).toMatch(/const invokedDirectly = import\.meta\.url === pathToFileURL/);
  });
});

describe('refresh-gsc-marquee-demand.yml', () => {
  const workflow = read(WORKFLOW_PATH);
  // The workflow's header comment explains, at length, why it does NOT npm ci
  // and does NOT dispatch a deploy — so the absence assertions below have to
  // read the steps, not the prose that documents them.
  const steps = workflow
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('is scheduled and manually dispatchable', () => {
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
  });

  it('runs weekly, not daily', () => {
    // The extractor reads a 90-day window, so a daily run moves ~1/90 of the
    // corpus while costing a commit on main — and data/** is not in deploy.yml's
    // paths-ignore, so each commit is a potential 130-minute SEO build.
    const cron = /- cron: '([^']+)'/.exec(workflow)?.[1] ?? '';
    const dayOfWeek = cron.trim().split(/\s+/)[4];
    expect(dayOfWeek, `cron "${cron}" must pin a weekday, not run daily`).not.toBe('*');
  });

  it('can commit the artifact', () => {
    expect(workflow).toMatch(/^\s*contents:\s*write\b/m);
    expect(workflow).toContain('data/gsc-top-marquee-candidates.json');
  });

  it('hydrates the service account the canonical way', () => {
    expect(workflow).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
    expect(workflow).toContain('GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-sa.json');
  });

  it('invokes the extractor', () => {
    expect(workflow).toContain('node scripts/identify-top-marquee-by-gsc.mjs');
  });

  it('no-ops the commit when a degraded run produced no artifact', () => {
    // Belt to the script's braces: a missing file must not fail the job, or a
    // transient GSC outage turns into a red cron every week.
    expect(workflow).toMatch(/if \[ ! -f data\/gsc-top-marquee-candidates\.json \]/);
  });

  it('installs dependencies if — and only if — the script needs any', () => {
    // The job deliberately skips `npm ci` because the script imports node
    // builtins and one relative helper. That saves the whole runtime of the
    // job, and it is safe exactly as long as the premise holds; the moment
    // someone adds a package import the cron would break at 02:55 on a Monday
    // with nobody watching. Assert the pair, not either half.
    const src = read(SCRIPT_PATH);
    const specifiers = [...src.matchAll(/^import\s[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
    expect(specifiers.length, 'expected the script to import something').toBeGreaterThan(0);
    const external = specifiers.filter((s) => !s.startsWith('node:') && !s.startsWith('.'));
    if (external.length > 0) {
      expect(steps, `script imports ${external.join(', ')} — the workflow must npm ci`).toMatch(/npm ci/);
    } else {
      expect(steps).not.toMatch(/npm ci/);
    }
  });

  it('does not dispatch a deploy for an artifact nothing reads yet', () => {
    // deploy.yml's own comment measures manual dispatches at 40 of 141 deploy
    // runs in 48 h. Until a build plugin consumes this file, a dispatch here
    // buys nothing and costs a 130-minute build slot.
    expect(steps).not.toContain('trigger-deploy.sh');
  });
});
