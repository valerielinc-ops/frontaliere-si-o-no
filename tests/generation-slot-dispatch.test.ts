import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as signJwt } from 'node:crypto';
import { dispatchGenerationSlot, inspectGenerationWorkflowContract } from '../functions/src/generationSlotDispatch.js';
import { getGenerationSlotClaim } from '../functions/src/generationSlotLedger.js';
import { admitGenerationSlotClaim, claimGenerationSlot, handleGenerationSlotClaimRequest } from '../functions/src/generationSlotLedger.js';
import { GENERATION_SLOT_ENTRIES } from '../functions/src/generationSlotSchedule.js';
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

function responseForWorkflow() {
  return new Response(JSON.stringify({
    encoding: 'base64',
    content: Buffer.from(workflow).toString('base64'),
  }), { status: 200 });
}

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
