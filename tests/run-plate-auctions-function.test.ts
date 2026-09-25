import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  expectedSourceKeys,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  runPlateAuctionsFunction,
  selectRefreshJob,
} from '../scripts/ci/run-plate-auctions-function.mjs';

const CREDENTIALS = { client_email: 'sa@example.iam.gserviceaccount.com', private_key: 'PRIVATE', project_id: 'demo-project' };
const TOKEN = 'ya29.secret-cloud-token';
const JOB = 'projects/demo-project/locations/europe-west6/jobs/firebase-schedule-refreshPlateAuctions-europe-west6';
const OTHER_JOB = 'projects/demo-project/locations/europe-west6/jobs/firebase-schedule-dispatchTrafficCollection-europe-west6';
const START = Date.parse('2026-09-25T10:00:00.000Z');
const RELAY = 'https://relay.example.test/getPlateAuctions';

type Call = { method: string; url: string };
type RelaySources = Record<string, Record<string, unknown>>;

/** Google Cloud Scheduler e relay finti, con un orologio che avanza solo con `sleep`. Nessuna rete. */
function fakeWorld({
  jobs = [[{ name: JOB, schedule: 'every 6 hours', timeZone: 'Europe/Zurich', state: 'ENABLED' }, { name: OTHER_JOB }]] as Array<Array<{ name: string; [key: string]: unknown }>>,
  relayResponses = [] as RelaySources[],
  forbidden = null as null | 'list' | 'run',
  serverDate = 'Fri, 25 Sep 2026 10:00:00 GMT',
} = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const masked: string[] = [];
  const summaries: string[] = [];
  let clock = START;
  let relayIndex = 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  const fetchImpl = async (url: string, init: { method?: string } = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url });
    if (url.startsWith('https://cloudscheduler.googleapis.com/v1/projects/demo-project/locations/europe-west6/jobs?')) {
      if (forbidden === 'list') return json(403, { error: { message: 'Permission denied', details: [{ reason: 'IAM_PERMISSION_DENIED' }] } });
      const page = new URL(url).searchParams.get('pageToken');
      const index = page ? Number(page) : 0;
      return json(200, { jobs: jobs[index] || [], ...(index + 1 < jobs.length ? { nextPageToken: String(index + 1) } : {}) });
    }
    if (url === `https://cloudscheduler.googleapis.com/v1/${JOB}:run` && method === 'POST') {
      if (forbidden === 'run') return json(403, { error: { message: "Permission 'cloudscheduler.jobs.run' denied" } });
      return json(200, { name: JOB }, { date: serverDate });
    }
    if (url.startsWith(`${RELAY}?fresh=`)) {
      const sources = relayResponses[Math.min(relayIndex, relayResponses.length - 1)] || {};
      relayIndex += 1;
      return json(200, { schema: 1, sources, auctions: [] });
    }
    return json(404, { error: { message: `unexpected ${method} ${url}` } });
  };
  const run = (overrides: Record<string, unknown> = {}) => runPlateAuctionsFunction({
    credentials: CREDENTIALS,
    fetchImpl: fetchImpl as never,
    getAccessToken: async () => TOKEN,
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    log: (line: string) => { logs.push(line); },
    mask: (value: string) => { masked.push(value); },
    summary: (markdown: string) => { summaries.push(markdown); },
    relayUrl: RELAY,
    expectedKeys: ['fr', 'sz', 'ti'],
    ...overrides,
  });
  return { calls, logs, masked, summaries, run, relayReads: () => relayIndex };
}

const at = (ms: number) => new Date(ms).toISOString();
const source = (lastFetchedAt: string, extra: Record<string, unknown> = {}) => ({
  status: 'active', lastFetchedAt, lastSuccessAt: lastFetchedAt, rowCount: 3, ...extra,
});
const OLD = at(START - 6 * 60 * 60 * 1000);

describe('run-plate-auctions-function', () => {
  it('picks the single refreshPlateAuctions job and refuses 0 or several', () => {
    expect(selectRefreshJob([{ name: OTHER_JOB }, { name: JOB }]).name).toBe(JOB);
    expect(() => selectRefreshJob([{ name: OTHER_JOB }])).toThrow(/no Cloud Scheduler job .* contains "refreshPlateAuctions".*dispatchTrafficCollection/);
    expect(() => selectRefreshJob([{ name: JOB }, { name: `${JOB}-copy` }])).toThrow(/2 Cloud Scheduler jobs contain "refreshPlateAuctions"/);
  });

  it('waits for exactly the sources the function registry marks active', () => {
    const keys = expectedSourceKeys();
    expect(keys).toEqual(expect.arrayContaining(['fr', 'sz', 'ti']));
    expect(keys).not.toContain('ju');
    expect(expectedSourceKeys({ a: { status: 'active' }, b: { status: 'blocked' } })).toEqual(['a']);
  });

  it('dry run: lists the jobs across pages, never triggers, prints the current relay state', async () => {
    const world = fakeWorld({
      jobs: [[{ name: OTHER_JOB }], [{ name: JOB, schedule: 'every 6 hours' }]],
      relayResponses: [{ fr: source(OLD), sz: source(OLD), ti: { status: 'blocked', rowCount: 0 } }],
    });
    const result = await world.run({ dryRun: true });
    expect(result).toMatchObject({ dryRun: true, job: JOB });
    expect(world.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(world.calls.filter((call) => call.url.includes('/jobs?'))).toHaveLength(2);
    const table = world.logs.join('\n');
    expect(table).toMatch(/source\s+status\s+lastFetchedAt\s+lastSuccessAt\s+rowCount\s+lastError/);
    expect(table).toMatch(/ti\s+blocked\s+-\s+-\s+0\s+-/);
    expect(world.masked).toEqual([TOKEN]);
    expect(world.logs.join('\n')).not.toContain(TOKEN);
  });

  it('triggers the job, polls until every active source is fresh and prints the table', async () => {
    const fresh = at(START + 5_000);
    const world = fakeWorld({
      relayResponses: [
        { fr: source(fresh), sz: source(OLD), ti: source(OLD) },
        { fr: source(fresh), sz: source(fresh), ti: source(fresh) },
      ],
    });
    const result = await world.run({ dryRun: false });
    expect(world.calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([`https://cloudscheduler.googleapis.com/v1/${JOB}:run`]);
    expect(result).toMatchObject({ dryRun: false, job: JOB, triggeredAt: at(START) });
    expect(world.relayReads()).toBe(2);
    const output = world.logs.join('\n');
    expect(output).toMatch(new RegExp(`fr\\s+active\\s+${fresh}\\s+${fresh}\\s+3\\s+-`));
    expect(output).not.toContain(TOKEN);
    expect(world.summaries.join('\n')).toContain('| ti | active |');
  });

  it('fails when a source was reached by the run but has no successful snapshot from it', async () => {
    // Criterio della review (5315920943): lastFetchedAt del giro, status
    // degraded e lastSuccessAt vecchio → il comando esce con errore.
    const fresh = at(START + 5_000);
    const world = fakeWorld({
      relayResponses: [
        { fr: source(fresh), sz: source(fresh), ti: source(fresh, { status: 'degraded', errorCode: 'zero_rows', lastSuccessAt: OLD }) },
      ],
    });
    await expect(world.run({ dryRun: false }))
      .rejects.toThrow('these active sources were reached by this run but have no successful snapshot from it: ti degraded (zero_rows)');
    expect(world.relayReads()).toBe(1);
    // La tabella resta stampata anche sul fallimento.
    expect(world.summaries.join('\n')).toContain('| ti | degraded |');
  });

  it('an active source with a fresh lastFetchedAt but an old lastSuccessAt is not a success', async () => {
    const fresh = at(START + 5_000);
    const world = fakeWorld({
      relayResponses: [
        { fr: source(fresh), sz: source(fresh), ti: source(fresh, { lastSuccessAt: OLD }) },
      ],
    });
    await expect(world.run({ dryRun: false })).rejects.toThrow('ti active');
  });

  it('uses the earlier of the local clock and Google Date header as the trigger time', async () => {
    // Orologio del runner 2 s avanti rispetto a Google: il giro partito alle
    // 09:59:59 di Google, prima delle 10:00:00 locali, resta del giro nuovo.
    const world = fakeWorld({
      serverDate: 'Fri, 25 Sep 2026 09:59:58 GMT',
      relayResponses: [{ fr: source(at(START - 1_000)), sz: source(at(START - 1_000)), ti: source(at(START - 1_000)) }],
    });
    const result = await world.run({ dryRun: false });
    expect(result.triggeredAt).toBe('2026-09-25T09:59:58.000Z');
  });

  it('fails after the window naming the sources that were never refreshed', async () => {
    const world = fakeWorld({ relayResponses: [{ fr: source(at(START + 1_000)), sz: source(OLD), ti: source(OLD) }] });
    await expect(world.run({ dryRun: false })).rejects.toThrow('after 12 min these active sources still have no lastFetchedAt from this run: sz, ti');
    expect(world.relayReads()).toBe(POLL_TIMEOUT_MS / POLL_INTERVAL_MS);
  });

  it('names the missing Cloud Scheduler permission on 403', async () => {
    await expect(fakeWorld({ forbidden: 'list' }).run({ dryRun: true }))
      .rejects.toThrow(/HTTP 403 IAM_PERMISSION_DENIED.*cloudscheduler\.jobs\.list.*roles\/cloudscheduler\.admin/);
    await expect(fakeWorld({ forbidden: 'run' }).run({ dryRun: false }))
      .rejects.toThrow(/:run → HTTP 403.*cloudscheduler\.jobs\.run.*roles\/cloudscheduler\.admin/);
  });

  it('refuses credentials that are not a service account', async () => {
    await expect(fakeWorld().run({ credentials: { project_id: 'x' } })).rejects.toThrow(/not a service account JSON/);
  });
});

describe('plate-auctions-function-run.yml', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/plate-auctions-function-run.yml', import.meta.url), 'utf8'));

  it('is manual-only, dry-run by default, least privilege and serialized', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toMatchObject({ group: 'plate-auctions-function-run', 'cancel-in-progress': false });
    const job = workflow.jobs.run;
    expect(job.permissions).toEqual({ contents: 'read' });
    const step = job.steps.find((candidate: { run?: string }) => candidate.run?.includes('run-plate-auctions-function.mjs'));
    expect(step.env.FIREBASE_SERVICE_ACCOUNT_JSON).toBe('${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}');
    expect(step.env.PLATE_AUCTIONS_FUNCTION_RUN_DRY_RUN).toBe("${{ inputs.dry_run == true && 'true' || 'false' }}");
  });
});
