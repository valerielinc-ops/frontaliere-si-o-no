import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as signJwt } from 'node:crypto';
import { dispatchGenerationSlot, inspectGenerationWorkflowContract } from '../functions/src/generationSlotDispatch.js';
import {
  admitGenerationSlotClaim,
  claimGenerationSlot,
  generationSlotKey,
  getGenerationSlotClaim,
  handleGenerationSlotClaimRequest,
  releaseGenerationSlotClaim,
  renewGenerationSlotClaim,
} from '../functions/src/generationSlotLedger.js';
import { GENERATION_SLOT_ENTRIES, parseCantonGenerationSchedule, parseHighCadenceSections } from '../functions/src/generationSlotSchedule.js';
import { dispatchLoopClock } from '../functions/src/loopClockDispatch.js';
import {
  allowGenerationClaimRequest,
  GENERATION_CLAIM_REQUESTS_PER_IP,
  GENERATION_SLOT_CLAIM_AUDIENCE,
  GITHUB_ACTIONS_OIDC_ISSUER,
  resetGithubActionsOidcStateForTests,
  verifyGithubActionsIdToken,
} from '../functions/src/githubActionsOidc.js';

const workflow = `name: Generate Blog Article
run-name: \${{ github.event_name == 'workflow_dispatch' && inputs.loop_clock != '' && format('Generate Blog Article [loop-clock {0}] [generation-slot {1}]', inputs.loop_clock, inputs.recovery_slot) || 'Generate Blog Article' }}
# generation-cloud-clock-contract: v1
on:
  workflow_dispatch:
    inputs:
      section:
        required: false
        type: string
      dry_run:
        required: false
        type: boolean
      dispatch_origin:
        required: true
        type: choice
        options:
          - manual
          - cloud_scheduler
          - chain
          - editorial_signal
      loop_clock:
        required: false
        type: string
      recovery_slot:
        required: false
        type: string
      recovery_claim:
        required: false
        type: string
permissions:
  contents: read
`;

function memoryDb() {
  const values = new Map<string, Record<string, unknown>>();
  const reference = (id: string) => ({
    id,
    get: async () => {
      const value = values.get(id);
      return { exists: Boolean(value), data: () => value };
    },
  });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
    runTransaction: async <T>(callback: (transaction: {
      get: (ref: ReturnType<typeof reference>) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      set: (ref: ReturnType<typeof reference>, value: Record<string, unknown>, options?: { merge?: boolean }) => void;
      update: (ref: ReturnType<typeof reference>, value: Record<string, unknown>) => void;
    }) => Promise<T>) => callback({
      get: (ref) => ref.get(),
      set: (ref, value, options = {}) => values.set(ref.id, options.merge ? { ...values.get(ref.id), ...value } : value),
      update: (ref, value) => values.set(ref.id, { ...values.get(ref.id), ...value }),
    }),
  };
  return db;
}

function responseForWorkflow(source = workflow) {
  return new Response(JSON.stringify({
    encoding: 'base64',
    content: Buffer.from(source).toString('base64'),
  }), { status: 200 });
}

const cantonWorkflow = workflow
  .replace(/(      dispatch_origin:\n)        required: true\n/u, '$1        default: manual\n')
  .replace(/^          - (?:chain|editorial_signal)\n/gmu, '');

describe('generation workflow readiness contract', () => {
  it('requires the readiness marker, explicit origin contract, recovery inputs and removal of native cron', () => {
    expect(inspectGenerationWorkflowContract(workflow)).toMatchObject({ ready: true, reason: 'ready' });
    expect(inspectGenerationWorkflowContract(workflow.replace('      dispatch_origin:\n        required: true', '      dispatch_origin:\n        required: false')))
      .toMatchObject({ ready: false, reason: 'dispatch_origin_invalid' });
    expect(inspectGenerationWorkflowContract(workflow.replace('      dispatch_origin:\n        required: true\n        type:', '      dispatch_origin:\n        required: true\n        default: manual\n        type:')))
      .toMatchObject({ ready: false, reason: 'dispatch_origin_invalid' });
    expect(inspectGenerationWorkflowContract(workflow.replace('      dispatch_origin:\n', '      other_input:\n')))
      .toMatchObject({ ready: false, reason: 'dispatch_origin_missing' });
    expect(inspectGenerationWorkflowContract(workflow.replace('recovery_claim:', 'other_input:')))
      .toMatchObject({ ready: false, reason: 'recovery_inputs_missing' });
    expect(inspectGenerationWorkflowContract(workflow.replace('  workflow_dispatch:', "  schedule:\n    - cron: '7 * * * *'\n  workflow_dispatch:")))
      .toMatchObject({ ready: false, reason: 'native_schedule_still_present' });
    expect(inspectGenerationWorkflowContract(workflow.replace('# generation-cloud-clock-contract: v1\n', '')))
      .toMatchObject({ ready: false, reason: 'contract_marker_missing' });
  });

  it('does not borrow recovery inputs from a later workflow trigger', () => {
    const withoutRecoveryInputs = workflow
      .replace(`      recovery_slot:\n        required: false\n        type: string\n`, '')
      .replace(`      recovery_claim:\n        required: false\n        type: string\n`, '')
      .replace('permissions:', `  workflow_call:\n    inputs:\n      recovery_slot:\n        required: true\n        type: string\n      recovery_claim:\n        required: true\n        type: string\npermissions:`);

    expect(inspectGenerationWorkflowContract(withoutRecoveryInputs))
      .toMatchObject({ ready: false, reason: 'recovery_inputs_missing' });
  });
});

describe('generation claim endpoint authentication', () => {
  it('rejects missing verified claims before touching the Firestore database', async () => {
    const result = await handleGenerationSlotClaimRequest({ method: 'POST', body: {} }, null, { claims: null });
    expect(result).toMatchObject({ status: 401, body: { reason: 'unauthorized' } });
  });

  it('verifies the signed GitHub Actions OIDC token and binds it to the corpus workflow run', async () => {
    resetGithubActionsOidcStateForTests();
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const now = Date.parse('2026-11-06T10:10:00Z');
    const claims = {
      iss: GITHUB_ACTIONS_OIDC_ISSUER,
      aud: GENERATION_SLOT_CLAIM_AUDIENCE,
      sub: 'repo:nanakokyobashi-rgb/frontaliere-articles:ref:refs/heads/main',
      repository: 'nanakokyobashi-rgb/frontaliere-articles',
      ref: 'refs/heads/main',
      workflow_ref: 'nanakokyobashi-rgb/frontaliere-articles/.github/workflows/generate-article.yml@refs/heads/main',
      event_name: 'workflow_dispatch',
      run_id: '123456',
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 300,
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signingInput = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(claims)}`;
    const token = `${signingInput}.${signJwt('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
    expect(await verifyGithubActionsIdToken(token, {
      audience: GENERATION_SLOT_CLAIM_AUDIENCE,
      now,
      fetchImpl,
    })).toMatchObject({ run_id: '123456', repository: 'nanakokyobashi-rgb/frontaliere-articles' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const wrongWorkflow = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ ...claims, workflow_ref: 'other.yml' })}`;
    const badToken = `${wrongWorkflow}.${signJwt('RSA-SHA256', Buffer.from(wrongWorkflow), privateKey).toString('base64url')}`;
    expect(await verifyGithubActionsIdToken(badToken, {
      audience: GENERATION_SLOT_CLAIM_AUDIENCE,
      now,
      fetchImpl,
    })).toBeNull();
  });

  it('limits repeat requests from a single source before Firestore work', () => {
    resetGithubActionsOidcStateForTests();
    const request = { ip: '198.51.100.10' };
    for (let index = 0; index < GENERATION_CLAIM_REQUESTS_PER_IP; index += 1) {
      expect(allowGenerationClaimRequest(request, { now: 1_000 })).toBe(true);
    }
    expect(allowGenerationClaimRequest(request, { now: 1_000 })).toBe(false);
    expect(allowGenerationClaimRequest(request, { now: 61_001 })).toBe(true);
  });
});

describe('generation slot dispatch', () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const nominal = new Date('2001-02-03T23:14:00Z');
  const slotMs = nominal.getTime();
  const dispatchMs = slotMs + 6 * minute;
  const cantonEntry = (cron: string) => parseCantonGenerationSchedule({
    schema: 1,
    entries: [{ section: 'canton-ti', workflow: 'generate-article-ti.yml', cron }],
  })[0];

  it('recovers the Sciaffusa slot on a third tick after two GitHub errors', async () => {
    const [entry] = parseCantonGenerationSchedule({
      schema: 1,
      entries: [{ section: 'canton-sh', workflow: 'generate-article-sh.yml', cron: '59 3,9,15,21 * * *' }],
    });
    const db = memoryDb();
    const statuses = [500, 502, 204];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(null, { status: statuses.shift() })
      : responseForWorkflow(cantonWorkflow));
    const dispatch = (scheduledAt: string) => dispatchGenerationSlot({
      entry,
      scheduledAt: new Date(scheduledAt),
      now: Date.parse(scheduledAt),
      context: { pat: 'test-token', owner: 'test-owner', repo: 'test-corpus' },
      fetchImpl,
      getAdminDbImpl: () => db,
    });

    const slotKey = 'generate-article/canton-sh/2026-11-25T15:59Z';
    expect(await dispatch('2026-11-25T16:05:00Z')).toMatchObject({ slotKey, reason: 'generation_dispatch_failed:500' });
    expect(await dispatch('2026-11-25T16:10:00Z')).toMatchObject({ slotKey, reason: 'generation_dispatch_failed:502' });
    expect(await dispatch('2026-11-25T16:15:00Z')).toMatchObject({ slotKey, dispatched: true, attempt: 3 });
    expect(await dispatch('2026-11-25T16:20:00Z')).toMatchObject({ dispatched: false, reason: 'slot_not_due' });
    const posts = fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts.map(([, options]) => JSON.parse(String(options?.body)).inputs.recovery_slot))
      .toEqual([slotKey, slotKey, slotKey]);
  });

  it.each([
    { hours: '2,11,23', duration: 3 * hour, offset: -1, admitted: true },
    { hours: '2,11,23', duration: 3 * hour, offset: 0, admitted: false },
    { hours: '2,11,23', duration: 3 * hour, offset: 1, admitted: false },
    { hours: '*', duration: hour, offset: -1, admitted: true },
    { hours: '*', duration: hour, offset: 0, admitted: false },
  ])('dispatches canton hours $hours and admits at deadline offset $offset ms: $admitted', async ({
    hours, duration, offset, admitted,
  }) => {
    const entry = cantonEntry(`14 ${hours} * * *`);
    const db = memoryDb();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(null, { status: 204 })
      : responseForWorkflow(cantonWorkflow));
    const result = await dispatchGenerationSlot({
      entry,
      scheduledAt: new Date(dispatchMs),
      now: dispatchMs,
      context: { pat: 'test-token', owner: 'test-owner', repo: 'test-corpus' },
      fetchImpl,
      getAdminDbImpl: () => db,
    });
    const key = generationSlotKey(entry.generationSlot, nominal, entry);
    expect(result).toMatchObject({ dispatched: true, slotKey: key });
    const { inputs } = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    const token = inputs.recovery_claim;
    const deadline = new Date(slotMs + duration);
    expect(await getGenerationSlotClaim(db, key)).toMatchObject({ admitBefore: deadline, claimToken: token });
    expect(await renewGenerationSlotClaim(db, key, token, { now: dispatchMs + 6 * minute })).toBe(true);
    expect(await getGenerationSlotClaim(db, key)).toMatchObject({ admitBefore: deadline });

    const now = deadline.getTime() + offset;
    expect(await admitGenerationSlotClaim(db, key, token, '1', { now })).toEqual({
      admitted, reason: admitted ? 'admitted' : 'claim_not_current',
    });
    if (admitted) {
      expect(await admitGenerationSlotClaim(db, key, token, '1', { now: deadline.getTime() }))
        .toEqual({ admitted: true, reason: 'already_admitted' });
      expect(await admitGenerationSlotClaim(db, key, token, '2', { now }))
        .toEqual({ admitted: false, reason: 'claim_not_current' });
    }
  });

  it.each(['legacy', 'national', 'remint'])('keeps the hourly deadline for %s claims', async (scenario) => {
    const db = memoryDb();
    const entry = cantonEntry('14 2,11,23 * * *');
    const slot = new Date(slotMs - 7 * minute);
    const key = scenario === 'national'
      ? generationSlotKey('frontaliere', slot)
      : generationSlotKey(entry.generationSlot, nominal, entry);
    const deadline = new Date(slotMs + 3 * hour);
    const previous = await claimGenerationSlot(db, key, {
      now: dispatchMs,
      ...(scenario === 'remint' && { admitBefore: deadline }),
    });
    let token = previous.claimToken;
    if (scenario === 'remint') {
      const current = await claimGenerationSlot(db, key, { now: dispatchMs + 6 * minute });
      token = current.claimToken;
      expect(token).not.toBe(previous.claimToken);
      expect(await getGenerationSlotClaim(db, key)).toMatchObject({ admitBefore: null });
      expect(await admitGenerationSlotClaim(db, key, previous.claimToken, '1', { now: dispatchMs + 7 * minute }))
        .toEqual({ admitted: false, reason: 'claim_not_current' });
    } else {
      const record = await getGenerationSlotClaim(db, key);
      if (scenario === 'legacy') delete record.admitBefore;
      else record.admitBefore = deadline;
    }
    const now = (scenario === 'national' ? slot.getTime() : slotMs) + hour;
    expect(await admitGenerationSlotClaim(db, key, token, '1', { now }))
      .toEqual({ admitted: false, reason: 'claim_not_current' });
    expect(await admitGenerationSlotClaim(db, key, token, '1', { now: now - 1 }))
      .toEqual({ admitted: true, reason: 'admitted' });
  });

  it('rejects invalid deadlines on write and fails closed on corrupt stored values', async () => {
    const db = memoryDb();
    const entry = cantonEntry('14 23 * * *');
    const key = generationSlotKey(entry.generationSlot, nominal, entry);
    const tooLong = new Date(slotMs + 24 * hour + 1);
    for (const admitBefore of [new Date(NaN), nominal, tooLong]) {
      await expect(claimGenerationSlot(db, key, { now: dispatchMs, admitBefore }))
        .rejects.toThrow('generation slot admission deadline is invalid');
    }
    const deadline = new Date(slotMs + 24 * hour);
    const national = generationSlotKey('frontaliere', new Date(slotMs - 7 * minute));
    await expect(claimGenerationSlot(db, national, { now: dispatchMs, admitBefore: deadline }))
      .rejects.toThrow('generation slot admission deadline is invalid');

    const claim = await claimGenerationSlot(db, key, { now: dispatchMs, admitBefore: deadline });
    const record = await getGenerationSlotClaim(db, key);
    for (const invalid of [deadline.toISOString(), NaN, nominal, tooLong]) {
      record.admitBefore = invalid;
      expect(await admitGenerationSlotClaim(db, key, claim.claimToken, '1', { now: dispatchMs }))
        .toEqual({ admitted: false, reason: 'claim_not_current' });
    }
    record.admitBefore = { toMillis: () => deadline.getTime() };
    expect(await admitGenerationSlotClaim(db, key, claim.claimToken, '1', { now: deadline.getTime() - 1 }))
      .toEqual({ admitted: true, reason: 'admitted' });
  });

  it('rejects a released canton token during the extended admission window', async () => {
    const db = memoryDb();
    const entry = cantonEntry('14 2,11,23 * * *');
    const key = generationSlotKey(entry.generationSlot, nominal, entry);
    const claim = await claimGenerationSlot(db, key, { now: dispatchMs, admitBefore: new Date(slotMs + 3 * hour) });
    expect(await releaseGenerationSlotClaim(db, key, claim.claimToken, { now: dispatchMs + minute })).toBe(true);
    expect(await admitGenerationSlotClaim(db, key, claim.claimToken, '1', { now: slotMs + 2 * hour }))
      .toEqual({ admitted: false, reason: 'claim_not_current' });
  });
  it('dispatches a nominal UTC slot once and fences the slot after workflow admission', async () => {
    const entry = GENERATION_SLOT_ENTRIES.find((candidate) => candidate.generationSlot === 'frontaliere')!;
    const db = memoryDb();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => (
      url.includes('/contents/')
        ? responseForWorkflow()
        : url.endsWith('/dispatches') && init?.method === 'POST'
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })
    ));
    const first = await dispatchGenerationSlot({
      entry,
      scheduledAt: '2026-11-06T10:10:00Z',
      now: Date.parse('2026-11-06T10:10:00Z'),
      context: { pat: 'test-token', owner: 'nanakokyobashi-rgb', repo: 'frontaliere-articles' },
      fetchImpl,
      getAdminDbImpl: () => db,
    });
    expect(first).toMatchObject({ dispatched: true, generationSlot: 'frontaliere', slotKey: 'generate-article/frontaliere/2026-11-06T10:07Z' });

    const dispatchCall = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit?]>)
      .find(([url]) => url.endsWith('/dispatches'));
    expect(dispatchCall).toBeDefined();
    const inputs = JSON.parse(String(dispatchCall?.[1]?.body)).inputs;
    expect(inputs).toMatchObject({
      section: 'frontaliere',
      dry_run: 'false',
      dispatch_origin: 'cloud_scheduler',
      recovery_slot: first.slotKey,
      loop_clock: 'corpus-generation-slot-frontaliere@2026-11-06T10:07Z',
    });
    expect(typeof inputs.recovery_claim).toBe('string');

    const admitted = await admitGenerationSlotClaim(db, String(first.slotKey), inputs.recovery_claim, '123456', {
      now: Date.parse('2026-11-06T10:11:00Z'),
    });
    expect(admitted).toMatchObject({ admitted: true, reason: 'admitted' });

    const second = await dispatchGenerationSlot({
      entry,
      scheduledAt: '2026-11-06T10:15:00Z',
      now: Date.parse('2026-11-06T10:15:00Z'),
      context: { pat: 'test-token', owner: 'nanakokyobashi-rgb', repo: 'frontaliere-articles' },
      fetchImpl,
      getAdminDbImpl: () => db,
    });
    expect(second).toMatchObject({ dispatched: false, reason: 'slot_already_admitted' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('loads the canton calendar and leaves native schedules in shadow mode', async () => {
    const schedule = { schema: 1, entries: [
      { section: 'canton-ow', workflow: 'generate-article-ow.yml', cron: '14 3,9,15,21 * * *' },
      { section: 'canton-ti', workflow: 'generate-article-ti.yml', cron: '14 4,10,16,22 * * *' },
    ] };
    const fetchImpl = vi.fn(async (url: string) => url.includes('canton-generation-slots.json')
      ? new Response(JSON.stringify(schedule))
      : responseForWorkflow(cantonWorkflow.replace('on:\n', "on:\n  schedule:\n    - cron: '14 3,9,15,21 * * *'\n")));
    const report = await dispatchLoopClock({
      scheduledAt: new Date('2026-11-20T09:25:00Z'),
      entries: [{ id: 'idle', repo: 'site', workflow: 'idle.yml', everyMinutes: 1440 }],
      includeGenerationSlots: true,
      fetchImpl,
      getRemoteConfigValueImpl: async (name: string) => name === 'GITHUB_PAT_NANAKO' ? 'test-token' : '',
    });
    expect(report.results).toEqual([expect.objectContaining({
      generationSlot: 'canton-ow',
      dispatched: false,
      reason: 'shadow:native_schedule_still_present',
    })]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining('/contents/generator/data/canton-generation-slots.json?ref=main'),
      expect.stringContaining('/contents/.github/workflows/generate-article-ow.yml?ref=main'),
    ]);
  });

  it('dispatches the canton workflow on the canonical slot and admits only that workflow', async () => {
    const [entry] = parseCantonGenerationSchedule({
      schema: 1,
      entries: [{ section: 'canton-ow', workflow: 'generate-article-ow.yml', cron: '14 3,9,15,21 * * *' }],
    });
    const db = memoryDb();
    const fetchImpl = vi.fn(async (url: string) => url.includes('/contents/')
      ? responseForWorkflow(cantonWorkflow)
      : new Response(null, { status: 204 }));
    const now = Date.parse('2026-11-20T09:20:00Z');
    const result = await dispatchGenerationSlot({
      entry,
      scheduledAt: new Date(now),
      now,
      context: { pat: 'test-token', owner: 'nanakokyobashi-rgb', repo: 'frontaliere-articles' },
      fetchImpl,
      getAdminDbImpl: () => db,
    });
    expect(result).toMatchObject({ dispatched: true, slotKey: 'generate-article/canton-ow/2026-11-20T09:14Z' });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining('/contents/.github/workflows/generate-article-ow.yml?ref=main'),
      expect.stringContaining('/actions/workflows/generate-article-ow.yml/dispatches'),
    ]);
    const claim = await getGenerationSlotClaim(db, String(result.slotKey));
    const req = { method: 'POST', body: {
      action: 'admit',
      slotKey: result.slotKey,
      runId: '123456',
      claimToken: claim.claimToken,
    } };
    const ref = 'nanakokyobashi-rgb/frontaliere-articles/.github/workflows';
    const claims = { run_id: '123456', workflow_ref: `${ref}/generate-article-ti.yml@refs/heads/main` };
    expect(await handleGenerationSlotClaimRequest(req, db, { now, claims })).toMatchObject({ status: 401 });
    claims.workflow_ref = `${ref}/generate-article-ow.yml@refs/heads/main`;
    expect(await handleGenerationSlotClaimRequest(req, db, { now, claims })).toMatchObject({ status: 200 });
  });

  it('admits a delayed runner only with the current, unconsumed hourly claim', async () => {
    const db = memoryDb();
    const key = 'generate-article/svizzera/2026-11-19T08:37Z';
    const dispatch = Date.parse('2026-11-19T08:40:00Z');
    const queued = Date.parse('2026-11-19T09:18:43Z');
    const old = await claimGenerationSlot(db, key, { now: dispatch });
    const current = await claimGenerationSlot(db, key, { now: dispatch + 6 * 60_000 });
    expect(current.claimToken).not.toBe(old.claimToken);
    expect(await admitGenerationSlotClaim(db, key, old.claimToken, '101', { now: queued }))
      .toMatchObject({ admitted: false, reason: 'claim_not_current' });
    expect(await admitGenerationSlotClaim(db, key, current.claimToken, '102', { now: queued }))
      .toMatchObject({ admitted: true, reason: 'admitted' });
    expect(await admitGenerationSlotClaim(db, key, current.claimToken, '103', { now: queued }))
      .toMatchObject({ admitted: false, reason: 'claim_not_current' });
  });

  it('expires unused admission at the next hourly slot', async () => {
    const db = memoryDb();
    const key = 'generate-article/svizzera/2026-11-19T08:37Z';
    const claim = await claimGenerationSlot(db, key, { now: Date.parse('2026-11-19T08:40:00Z') });
    expect(await admitGenerationSlotClaim(db, key, claim.claimToken, '102', {
      now: Date.parse('2026-11-19T09:37:00Z'),
    })).toMatchObject({ admitted: false, reason: 'claim_not_current' });
  });

  it('bounds expired-claim reconciliation to runs created on the nominal slot day', async () => {
    const entry = GENERATION_SLOT_ENTRIES.find((candidate) => candidate.generationSlot === 'frontaliere')!;
    const db = memoryDb();
    const slotKey = 'generate-article/frontaliere/2026-11-06T10:07Z';
    await claimGenerationSlot(db, slotKey, {
      now: Date.parse('2026-11-06T10:09:00Z'),
      claimTokenFactory: () => '11111111-1111-4111-8111-111111111111',
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => (
      url.includes('/contents/')
        ? responseForWorkflow()
        : url.includes('/runs?')
          ? new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })
          : url.endsWith('/dispatches') && init?.method === 'POST'
            ? new Response(null, { status: 204 })
            : new Response('{}', { status: 404 })
    ));

    const result = await dispatchGenerationSlot({
      entry,
      scheduledAt: '2026-11-06T10:15:00Z',
      now: Date.parse('2026-11-06T10:15:00Z'),
      context: { pat: 'test-token', owner: 'nanakokyobashi-rgb', repo: 'frontaliere-articles' },
      fetchImpl,
      getAdminDbImpl: () => db,
    });

    expect(result).toMatchObject({ dispatched: true, slotKey });
    const lookup = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit?]>)
      .find(([url]) => url.includes('/runs?'));
    expect(lookup?.[0]).toContain('created=%3E%3D2026-11-06');
    expect(lookup?.[0]).toContain('branch=main');
  });

  it('keeps an expired claim while a matching generation run is pending', async () => {
    const entry = GENERATION_SLOT_ENTRIES.find((candidate) => candidate.generationSlot === 'frontaliere')!;
    const db = memoryDb();
    const slotKey = 'generate-article/frontaliere/2026-11-06T10:07Z';
    const claim = await claimGenerationSlot(db, slotKey, {
      now: Date.parse('2026-11-06T10:09:00Z'),
      claimTokenFactory: () => '11111111-1111-4111-8111-111111111111',
    });
    const pendingRun = {
      event: 'workflow_dispatch',
      head_branch: 'main',
      display_title: `Generate Blog Article [generation-slot ${slotKey}]`,
      status: 'pending',
      created_at: '2026-11-06T10:09:30Z',
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => (
      url.includes('/contents/')
        ? responseForWorkflow()
        : url.includes('/runs?')
          ? new Response(JSON.stringify({ workflow_runs: [pendingRun] }), { status: 200 })
          : url.endsWith('/dispatches') && init?.method === 'POST'
            ? new Response(null, { status: 204 })
            : new Response('{}', { status: 404 })
    ));

    const result = await dispatchGenerationSlot({
      entry,
      scheduledAt: '2026-11-06T10:15:00Z',
      now: Date.parse('2026-11-06T10:15:00Z'),
      context: { pat: 'test-token', owner: 'nanakokyobashi-rgb', repo: 'frontaliere-articles' },
      fetchImpl,
      getAdminDbImpl: () => db,
    });

    expect(claim.claimed).toBe(true);
    expect(result).toMatchObject({ dispatched: false, reason: 'matching_run_active', slotKey });
    expect((fetchImpl.mock.calls as unknown as Array<[string, RequestInit?]>).some(([url]) => url.endsWith('/dispatches')))
      .toBe(false);
    const retained = await getGenerationSlotClaim(db, slotKey);
    expect(retained).toMatchObject({ status: 'claimed', claimToken: claim.claimToken });
    expect(Date.parse(String(retained?.leaseUntil))).toBeGreaterThan(Date.parse('2026-11-06T10:15:00Z'));
  });

  it('stays in shadow when the corpus workflow has not opted into cloud-clock ownership', async () => {
    const entry = GENERATION_SLOT_ENTRIES.find((candidate) => candidate.generationSlot === 'svizzera')!;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      encoding: 'base64',
      content: Buffer.from(workflow.replace('# generation-cloud-clock-contract: v1\n', '')).toString('base64'),
    }), { status: 200 }));
    const result = await dispatchGenerationSlot({
      entry,
      scheduledAt: '2026-11-06T10:40:00Z',
      context: { pat: 'test-token', owner: 'nanakokyobashi-rgb', repo: 'frontaliere-articles' },
      fetchImpl,
      getAdminDbImpl: () => { throw new Error('database must not be opened while in shadow'); },
    });
    expect(result).toMatchObject({ dispatched: false, reason: 'shadow:contract_marker_missing' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('canton base cadence filter', () => {
  const hourly = (section: string, baseSlotHours?: unknown) => ({
    section,
    workflow: `generate-article-${section.slice(7)}.yml`,
    cron: '14 * * * *',
    ...(baseSlotHours === undefined ? {} : { baseSlotHours }),
  });
  const parse = (entry: Record<string, unknown>) => parseCantonGenerationSchedule({ schema: 1, entries: [entry] });
  const known = ['canton-ow', 'canton-ti', 'canton-ge'];

  it('parses valid baseSlotHours and defaults to null when absent', () => {
    expect(parse(hourly('canton-ow'))[0].baseSlotHours).toBeNull();
    expect(parse(hourly('canton-ow', [3, 9, 15, 21]))[0].baseSlotHours).toEqual([3, 9, 15, 21]);
    expect(parse(hourly('canton-ow', [0, 23]))[0].baseSlotHours).toEqual([0, 23]);
  });

  it.each([[[]], [[24]], [[-1]], [[3, 3]], [[1.5]], [['3']], ['3'], [null], [{}]])(
    'rejects invalid baseSlotHours %j with a TypeError',
    (bad) => {
      expect(() => parse(hourly('canton-ow', bad))).toThrow(TypeError);
    },
  );

  it('parses high-cadence sections from codes, ids and all', () => {
    expect([...parseHighCadenceSections('TI, canton-ge;zz', known)].sort()).toEqual(['canton-ge', 'canton-ti']);
    expect([...parseHighCadenceSections('ow ti', known)].sort()).toEqual(['canton-ow', 'canton-ti']);
    expect(parseHighCadenceSections('all', known).size).toBe(3);
    expect(parseHighCadenceSections('*', known).size).toBe(3);
    expect(parseHighCadenceSections('zz, canton-xx', known).size).toBe(0);
    expect(parseHighCadenceSections('', known).size).toBe(0);
    expect(parseHighCadenceSections(undefined, known).size).toBe(0);
  });

  const dueSlots = async (entries: unknown[], tick: string, rc: string | Error) => {
    const rcReads: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => url.includes('canton-generation-slots.json')
      ? new Response(JSON.stringify({ schema: 1, entries }))
      : new Response('{}', { status: 500 }));
    const report = await dispatchLoopClock({
      scheduledAt: new Date(tick),
      entries: [{ id: 'idle', repo: 'site', workflow: 'idle.yml', everyMinutes: 1440 }],
      includeGenerationSlots: true,
      fetchImpl,
      getRemoteConfigValueImpl: async (name: string) => {
        rcReads.push(name);
        if (name === 'GITHUB_PAT_NANAKO') return 'test-token';
        if (name === 'CANTON_HIGH_CADENCE_SECTIONS') {
          if (rc instanceof Error) throw rc;
          return rc;
        }
        return '';
      },
    });
    const slots = report.results
      .map((result: { generationSlot?: string }) => result.generationSlot)
      .filter(Boolean)
      .sort();
    return { slots, rcReads, warnings: report.warnings as string[] };
  };
  const calendar = (withBase: boolean) => [
    hourly('canton-ow', withBase ? [3, 9, 15, 21] : undefined),
    hourly('canton-ti', withBase ? [4, 10, 16, 22] : undefined),
  ];

  it('leaves an old calendar without baseSlotHours unchanged and never reads the list', async () => {
    const { slots, rcReads } = await dueSlots(calendar(false), '2026-11-20T09:25:00Z', 'TI');
    expect(slots).toEqual(['canton-ow', 'canton-ti']);
    expect(rcReads).not.toContain('CANTON_HIGH_CADENCE_SECTIONS');
  });

  it('with an empty list runs only the base hours of each section', async () => {
    expect((await dueSlots(calendar(true), '2026-11-20T09:25:00Z', '')).slots).toEqual(['canton-ow']);
    expect((await dueSlots(calendar(true), '2026-11-20T10:25:00Z', '')).slots).toEqual(['canton-ti']);
    expect((await dueSlots(calendar(true), '2026-11-20T11:25:00Z', '')).slots).toEqual([]);
  });

  it('runs a listed section on all 24 hours and the others only on base hours', async () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const tick = `2026-11-20T${String(hour).padStart(2, '0')}:25:00Z`;
      const { slots } = await dueSlots(calendar(true), tick, 'TI');
      expect(slots).toContain('canton-ti');
      expect(slots.includes('canton-ow')).toBe([3, 9, 15, 21].includes(hour));
    }
  });

  it('treats a failed Remote Config read as an empty list and warns', async () => {
    const off = await dueSlots(calendar(true), '2026-11-20T11:25:00Z', new Error('rc down'));
    expect(off.slots).toEqual([]);
    expect(off.warnings).toContain('remote_config_unavailable:CANTON_HIGH_CADENCE_SECTIONS');
    const base = await dueSlots(calendar(true), '2026-11-20T09:25:00Z', new Error('rc down'));
    expect(base.slots).toEqual(['canton-ow']);
  });
});
