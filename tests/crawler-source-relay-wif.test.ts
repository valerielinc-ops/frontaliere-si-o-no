import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  SOURCE_RELAY_AUTH_ACTION,
  SOURCE_RELAY_AUTH_STEP_ID,
  SOURCE_RELAY_CRAWLER_SLUGS,
  SOURCE_RELAY_SERVICE_ACCOUNT,
  SOURCE_RELAY_URL,
  SOURCE_RELAY_WORKLOAD_IDENTITY_PROVIDER,
  WORKDAY_RELAY_CRAWLER_SLUGS,
} from '../scripts/generate-crawler-group-workflows.mjs';
import {
  assertSourceRelayReady,
  fetchSourceViaRelay,
} from '../scripts/lib/source-relay-fetch.mjs';

// FU-015 / site 10831: the private Firebase relay needs a Google ID token
// (Cloud Run IAM, first gate) next to the GitHub OIDC token (second factor).
// These tests read the COMMITTED generated workflows, so a regeneration that
// drops the auth step, widens id-token to other groups or loses the
// fail-closed env is caught before it reaches the corpus.

const ROOT = path.resolve(__dirname, '..');
const WORKDAY_SLUGS = new Set<string>(WORKDAY_RELAY_CRAWLER_SLUGS);
const RELAY_SLUGS = new Set<string>([...SOURCE_RELAY_CRAWLER_SLUGS, ...WORKDAY_RELAY_CRAWLER_SLUGS]);
const ID_TOKEN_EXPR = `\${{ steps.${SOURCE_RELAY_AUTH_STEP_ID}.outputs.id_token }}`;

function groupArtifacts() {
  const sources = [
    { dir: '.github/workflows', re: /^crawler-group-\d{2}(?:-logic)?\.yml$/u },
    { dir: '.github/corpus-workflows', re: /^crawler-group-\d{2}\.yml$/u },
  ];
  return sources.flatMap(({ dir, re }) => fs.readdirSync(path.join(ROOT, dir))
    .filter((name) => re.test(name))
    .sort()
    .map((name) => {
      const doc = YAML.parse(fs.readFileSync(path.join(ROOT, dir, name), 'utf8'));
      const [jobName, job] = Object.entries(doc.jobs as Record<string, any>)[0];
      return { file: `${dir}/${name}`, doc, jobName, job };
    }));
}

function launchSteps(job: any) {
  return (job.steps as any[]).filter((step) => String(step?.id ?? '').startsWith('crawler-launch-'));
}

function relayLaunches(job: any) {
  return launchSteps(job).filter((step) => RELAY_SLUGS.has(step.id.replace(/^crawler-launch-/u, '')));
}

describe('crawler groups: WIF auth for the jobs source relay', () => {
  const artifacts = groupArtifacts();

  it('reads every committed crawler group entry point', () => {
    expect(artifacts.length).toBeGreaterThan(0);
    for (const { file, job } of artifacts) {
      expect(launchSteps(job).length, file).toBeGreaterThan(0);
    }
  });

  it('every relay crawler is wired in each of the three entry points', () => {
    const entryPoints = [
      {
        label: '.github/workflows/crawler-group-XX.yml',
        files: /^\.github\/workflows\/crawler-group-\d{2}\.yml$/u,
      },
      {
        label: '.github/workflows/crawler-group-XX-logic.yml',
        files: /^\.github\/workflows\/crawler-group-\d{2}-logic\.yml$/u,
      },
      {
        label: '.github/corpus-workflows/crawler-group-XX.yml',
        files: /^\.github\/corpus-workflows\/crawler-group-\d{2}\.yml$/u,
      },
    ];
    for (const { label, files } of entryPoints) {
      const wired = artifacts
        .filter(({ file }) => files.test(file))
        .flatMap(({ job }) => relayLaunches(job).map((step) => step.id.replace(/^crawler-launch-/u, '')));
      expect(new Set(wired), label).toEqual(RELAY_SLUGS);
    }
  });

  it('only the job of a group with a relay member gets id-token: write and the auth step', () => {
    for (const { file, doc, job } of artifacts) {
      const relays = relayLaunches(job);
      const authSteps = (job.steps as any[]).filter((step) => String(step?.uses ?? '').startsWith('google-github-actions/auth@'));
      // Never at workflow level: the scope stays on the job that needs it.
      expect(doc.permissions?.['id-token'], file).toBeUndefined();
      if (relays.length === 0) {
        expect(job.permissions, file).toBeUndefined();
        expect(authSteps, file).toEqual([]);
        for (const step of launchSteps(job)) {
          expect(Object.keys(step.env ?? {}).filter((key) => key.startsWith('JOBS_SOURCE_RELAY_')), `${file} ${step.id}`).toEqual([]);
        }
        continue;
      }
      // Job-level permissions replace the workflow ones: same scopes + id-token.
      expect(job.permissions, file).toEqual({ ...doc.permissions, 'id-token': 'write' });
      expect(authSteps, file).toHaveLength(1);
      const [auth] = authSteps;
      expect(auth, file).toMatchObject({
        id: SOURCE_RELAY_AUTH_STEP_ID,
        uses: SOURCE_RELAY_AUTH_ACTION,
        'continue-on-error': true,
        with: {
          workload_identity_provider: SOURCE_RELAY_WORKLOAD_IDENTITY_PROVIDER,
          service_account: SOURCE_RELAY_SERVICE_ACCOUNT,
          token_format: 'id_token',
          id_token_audience: SOURCE_RELAY_URL,
          create_credentials_file: false,
          export_environment_variables: false,
        },
      });
      expect(auth.if, file).toContain("steps.crawler_group_setup.outcome == 'success'");
      expect(auth.if ?? '', file).not.toContain('always()');
    }
  });

  it('relay members use private slots while non-relays keep group parallelism', () => {
    for (const { file, job } of artifacts) {
      const relays = relayLaunches(job);
      if (relays.length === 0) continue;
      const steps = job.steps as any[];
      const authAt = steps.findIndex((step) => step.id === SOURCE_RELAY_AUTH_STEP_ID);
      const launches = launchSteps(job);
      expect(authAt, file).toBeLessThan(steps.indexOf(launches[0]));
      for (const step of relays) {
        const relaySlug = step.id.replace(/^crawler-launch-/u, '');
        expect(step.env, `${file} ${step.id}`).toMatchObject({
          JOBS_SOURCE_RELAY_URL: SOURCE_RELAY_URL,
          JOBS_SOURCE_RELAY_ID_TOKEN: ID_TOKEN_EXPR,
        });
        // The original three sources have no other path: fail closed. Workday
        // members (#20279) use the relay only as a rescue after a direct 429,
        // so a failed auth step must leave their direct crawl untouched.
        if (WORKDAY_SLUGS.has(relaySlug)) {
          expect(Object.keys(step.env), `${file} ${step.id}`).not.toContain('JOBS_SOURCE_RELAY_REQUIRED');
        } else {
          expect(step.env.JOBS_SOURCE_RELAY_REQUIRED, `${file} ${step.id}`).toBe('1');
        }
        // A failed auth must not skip siblings: launches keep their own guard.
        expect(step['continue-on-error'], `${file} ${step.id}`).toBe(true);
        // The token lives one hour: the member never queues on shared slots.
        const slug = step.id.replace(/^crawler-launch-/u, '');
        expect(step.run, `${file} ${step.id}`).toContain(`export CRAWLER_LAUNCH_RELAY_SLOT='relay-${slug}.lock'`);
      }
      // The shared launcher (installed once per group) honours the private slot.
      const installer = steps.find((step) => step.name === 'Install shared crawler launcher');
      expect(installer, file).toBeDefined();
      expect(installer.run, file).toContain('max_parallel=1');
      expect(installer.run, file).toContain('slots/${CRAWLER_LAUNCH_RELAY_SLOT:-slot-${slot_index}.lock}');
      for (const step of launches.filter((launch) => !relays.includes(launch))) {
        expect(Object.keys(step.env ?? {}).filter((key) => key.startsWith('JOBS_SOURCE_RELAY_')), `${file} ${step.id}`).toEqual([]);
        expect(step.run, `${file} ${step.id}`).toContain('CRAWLER_LAUNCH_PARALLEL=4');
        expect(step.run, `${file} ${step.id}`).not.toContain('CRAWLER_LAUNCH_RELAY_SLOT');
      }
    }
  });

  it('the Workday relay roster is exactly the roster crawlers that reach the Workday client', () => {
    const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/crawler-generation-roster.json'), 'utf8'));
    const ids: string[] = Object.values(roster.groups as Record<string, string[]>).flat();
    // The two generic factories import the Workday parser for every adapter;
    // only a dedicated update script that imports it through its own parser counts.
    const stop = new Set(['shared-jobs-crawler.mjs', 'agenda-crawler-factory.mjs']);
    const importCache = new Map<string, string[]>();
    const importsOf = (file: string) => {
      if (!importCache.has(file)) {
        let source = '';
        try { source = fs.readFileSync(file, 'utf8'); } catch { /* absent module */ }
        importCache.set(file, [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/gu)]
          .map((match) => path.normalize(path.join(path.dirname(file), match[1]))));
      }
      return importCache.get(file)!;
    };
    const reachesWorkday = (entry: string) => {
      const seen = new Set([entry]);
      const queue = [entry];
      while (queue.length > 0) {
        const file = queue.pop()!;
        if (file.endsWith(path.join('ats-clients', 'workday-client.mjs'))) return true;
        if (stop.has(path.basename(file))) continue;
        for (const next of importsOf(file)) {
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      return false;
    };
    const derived = ids
      .filter((id) => fs.existsSync(path.join(ROOT, `scripts/update-${id}-jobs.mjs`)))
      .filter((id) => reachesWorkday(path.join(ROOT, `scripts/update-${id}-jobs.mjs`)))
      .sort();
    expect([...WORKDAY_RELAY_CRAWLER_SLUGS].sort()).toEqual(derived);
    // A Workday member never doubles as one of the three required-relay sources.
    expect([...WORKDAY_RELAY_CRAWLER_SLUGS].filter((slug) => SOURCE_RELAY_CRAWLER_SLUGS.includes(slug))).toEqual([]);
  });

  it('the relay URL is the run.app service URL used as audience', () => {
    expect(new URL(SOURCE_RELAY_URL).hostname.endsWith('.run.app')).toBe(true);
    expect(SOURCE_RELAY_AUTH_ACTION).toMatch(/^google-github-actions\/auth@[0-9a-f]{40}$/u);
  });
});

describe('source relay client: Google ID token and fail-closed readiness', () => {
  const ACTIONS_ENV = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/request',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-request-token',
  };
  const CHUR_URL = 'https://jobs.chur.ch/Pflegefachfrau-de-j1719.html';

  it('keeps the GitHub OIDC second factor and adds X-Serverless-Authorization', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://token.actions.githubusercontent.com/')) {
        return new Response(JSON.stringify({ value: 'github-oidc-token' }), { status: 200 });
      }
      return new Response('relayed source', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const response = await fetchSourceViaRelay(CHUR_URL, {
      relayUrl: SOURCE_RELAY_URL,
      fetchImpl,
      env: { ...ACTIONS_ENV, JOBS_SOURCE_RELAY_ID_TOKEN: 'google-id-token' },
    });
    expect(response).toEqual({ status: 200, text: 'relayed source' });
    const relayCall = fetchImpl.mock.calls.find(([input]) => String(input).startsWith(SOURCE_RELAY_URL));
    expect(relayCall?.[1]?.headers).toEqual({
      Authorization: 'Bearer github-oidc-token',
      'X-Serverless-Authorization': 'Bearer google-id-token',
      Accept: 'text/html, application/json',
    });
  });

  it('omits X-Serverless-Authorization when no Google ID token is configured', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => (
      String(input).startsWith('https://token.actions.githubusercontent.com/')
        ? new Response(JSON.stringify({ value: 'github-oidc-token' }), { status: 200 })
        : new Response('relayed source', { status: 200 })
    ));
    await fetchSourceViaRelay(CHUR_URL, { relayUrl: SOURCE_RELAY_URL, fetchImpl, env: ACTIONS_ENV });
    const relayCall = fetchImpl.mock.calls.find(([input]) => String(input).startsWith(SOURCE_RELAY_URL));
    expect(Object.keys(relayCall?.[1]?.headers ?? {})).not.toContain('X-Serverless-Authorization');
  });

  it('is a no-op outside a relay-required launch step', () => {
    expect(assertSourceRelayReady({})).toBe(false);
    expect(assertSourceRelayReady({ JOBS_SOURCE_RELAY_REQUIRED: '0' })).toBe(false);
  });

  it('passes when every relay credential reached the crawler', () => {
    expect(assertSourceRelayReady({
      ...ACTIONS_ENV,
      JOBS_SOURCE_RELAY_REQUIRED: '1',
      JOBS_SOURCE_RELAY_URL: SOURCE_RELAY_URL,
      JOBS_SOURCE_RELAY_ID_TOKEN: 'google-id-token',
    })).toBe(true);
  });

  it.each([
    ['the Google ID token (auth step failed)', { JOBS_SOURCE_RELAY_ID_TOKEN: '' }, /JOBS_SOURCE_RELAY_ID_TOKEN/u],
    ['the relay URL', { JOBS_SOURCE_RELAY_URL: '' }, /JOBS_SOURCE_RELAY_URL/u],
    ['an https relay URL', { JOBS_SOURCE_RELAY_URL: 'http://relay.example' }, /https/u],
    ['the GitHub OIDC request (no id-token: write)', { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, /id-token: write/u],
  ])('fails closed without %s', (_label, override, message) => {
    const env = {
      ...ACTIONS_ENV,
      JOBS_SOURCE_RELAY_REQUIRED: '1',
      JOBS_SOURCE_RELAY_URL: SOURCE_RELAY_URL,
      JOBS_SOURCE_RELAY_ID_TOKEN: 'google-id-token',
      ...override,
    };
    let thrown: any;
    try {
      assertSourceRelayReady(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('source_relay_auth_unavailable');
    expect(String(thrown?.message)).toMatch(message);
    // Not a transport error: exitCrawlerOnError must exit 1, not keep-jobs 0.
    expect(thrown?.status).toBeUndefined();
  });

  it('all relay crawlers check readiness before crawling', () => {
    for (const script of [
      'scripts/update-stadt-chur-jobs.mjs',
      'scripts/update-has-healthcare-jobs.mjs',
      'scripts/update-alten-jobs.mjs',
    ]) {
      const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
      const mainAt = source.indexOf('async function main()');
      expect(mainAt, script).toBeGreaterThan(-1);
      const assertAt = source.indexOf('assertSourceRelayReady();', mainAt);
      expect(assertAt, script).toBeGreaterThan(mainAt);
      expect(source.slice(mainAt, assertAt)).toContain('registerCrawlerSummaryGuard');
    }
  });
});
