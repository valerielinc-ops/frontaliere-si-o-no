import { GITHUB_API } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';
import {
  GENERATION_SLOT_CLAIM_LEASE_MS,
  GENERATION_SLOT_RETRY_DELAY_MS,
  claimGenerationSlot,
  generationSlotKey,
  getGenerationSlotClaim,
  releaseGenerationSlotClaim,
  renewGenerationSlotClaim,
} from './generationSlotLedger.js';
import { generationSlotDateForEntry } from './generationSlotSchedule.js';
import { LOOP_CLOCK_INPUT, loopClockInputValue } from './loopClockTable.js';
import { GENERATION_WORKFLOW_CONTRACT_MARKER, inspectGenerationWorkflowContract } from './generationWorkflowContract.js';

export { GENERATION_WORKFLOW_CONTRACT_MARKER, inspectGenerationWorkflowContract };
export const GENERATION_WORKFLOW_PATH = '.github/workflows/generate-article.yml';
const GENERATION_WORKFLOW_ID = 'generate-article.yml';
const GENERATION_RUN_MARKER = '[generation-slot ';
const DISPATCH_TIMEOUT_MS = 20_000;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested']);

async function readGenerationWorkflow({ owner, repo, token, fetchImpl }) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${GENERATION_WORKFLOW_PATH}?ref=main`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: githubApiHeaders(token),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`generation_contract_lookup_failed:${response.status}`);
  const payload = await response.json().catch(() => null);
  if (payload?.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error('generation_contract_lookup_invalid');
  }
  return Buffer.from(payload.content.replace(/\s+/gu, ''), 'base64').toString('utf8');
}

async function listMatchingRuns({ owner, repo, token, slotKey, nominalSlot, fetchImpl }) {
  const createdSince = `>=${new Date(nominalSlot).toISOString().slice(0, 10)}`;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${GENERATION_WORKFLOW_ID}/runs?branch=main&per_page=100&created=${encodeURIComponent(createdSince)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: githubApiHeaders(token),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`generation_run_lookup_failed:${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.workflow_runs)) throw new Error('generation_run_lookup_invalid');
  const expected = `${GENERATION_RUN_MARKER}${slotKey}]`;
  return payload.workflow_runs.filter((run) => (
    run?.event === 'workflow_dispatch'
    && run?.head_branch === 'main'
    && String(run?.display_title ?? '').includes(expected)
  )).sort((left, right) => Date.parse(right?.created_at ?? '') - Date.parse(left?.created_at ?? ''));
}

function result(entry, fields = {}) {
  return {
    id: entry.id,
    repo: entry.repo,
    workflow: entry.workflow,
    generationSlot: entry.generationSlot,
    ...fields,
  };
}

/**
 * Dispatch one recovery slot after the corpus workflow has explicitly opted in.
 *
 * @param {{
 *   entry: { id: string, repo: string, workflow: string, generationSlot: string },
 *   scheduledAt?: string | Date,
 *   context?: { pat?: string, owner?: string, repo?: string } | undefined,
 *   fetchImpl?: typeof fetch,
 *   getAdminDbImpl?: () => object,
 *   now?: number | Date
 * }} options
 */
export async function dispatchGenerationSlot({
  entry,
  scheduledAt,
  context,
  fetchImpl = fetch,
  getAdminDbImpl,
  now = Date.now(),
} = {}) {
  const nominalSlot = generationSlotDateForEntry(entry, scheduledAt);
  if (!nominalSlot) return result(entry, { dispatched: false, reason: 'slot_not_due' });
  const slotKey = generationSlotKey(entry.generationSlot, nominalSlot);
  const { pat: token, owner, repo } = context ?? {};
  if (!token || !owner || !repo) {
    return result(entry, { dispatched: false, failed: true, reason: 'corpus_token_missing' });
  }

  let workflowText;
  try {
    workflowText = await readGenerationWorkflow({ owner, repo, token, fetchImpl });
  } catch (error) {
    const reason = error instanceof Error && /^generation_contract_lookup_/u.test(error.message)
      ? error.message
      : 'generation_contract_lookup_failed:network';
    return result(entry, { dispatched: false, failed: true, reason, slotKey });
  }
  const contract = inspectGenerationWorkflowContract(workflowText);
  if (!contract.ready) {
    return result(entry, { dispatched: false, reason: `shadow:${contract.reason}`, slotKey });
  }
  if (typeof getAdminDbImpl !== 'function') {
    return result(entry, { dispatched: false, failed: true, reason: 'generation_slot_database_unavailable', slotKey });
  }

  let db;
  try {
    db = getAdminDbImpl();
  } catch {
    return result(entry, { dispatched: false, failed: true, reason: 'generation_slot_database_unavailable', slotKey });
  }
  let previous;
  try {
    previous = await getGenerationSlotClaim(db, slotKey);
  } catch {
    return result(entry, { dispatched: false, failed: true, reason: 'generation_slot_ledger_read_failed', slotKey });
  }
  if (previous?.status === 'admitted') {
    return result(entry, { dispatched: false, reason: 'slot_already_admitted', slotKey });
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const leaseUntil = previous?.leaseUntil instanceof Date
    ? previous.leaseUntil.getTime()
    : typeof previous?.leaseUntil?.toMillis === 'function'
      ? previous.leaseUntil.toMillis()
      : Date.parse(previous?.leaseUntil);
  if (previous?.status === 'claimed' && leaseUntil > nowMs) {
    return result(entry, { dispatched: false, reason: 'claim_lease_active', slotKey });
  }

  if (previous?.status === 'claimed') {
    let matchingRuns;
    try {
      matchingRuns = await listMatchingRuns({ owner, repo, token, slotKey, nominalSlot, fetchImpl });
    } catch (error) {
      const reason = error instanceof Error && /^generation_run_lookup_/u.test(error.message)
        ? error.message
        : 'generation_run_lookup_failed:network';
      return result(entry, { dispatched: false, failed: true, reason, slotKey });
    }
    const activeRun = matchingRuns.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
    if (activeRun) {
      const renewed = await renewGenerationSlotClaim(db, slotKey, previous.claimToken, {
        now: nowMs,
        leaseMs: GENERATION_SLOT_CLAIM_LEASE_MS,
      }).catch(() => false);
      return result(entry, {
        dispatched: false,
        failed: !renewed,
        reason: renewed ? 'matching_run_active' : 'claim_renew_failed',
        slotKey,
      });
    }
    if (matchingRuns.length > 0) {
      const released = await releaseGenerationSlotClaim(db, slotKey, previous.claimToken, {
        now: nowMs,
        retryDelayMs: GENERATION_SLOT_RETRY_DELAY_MS,
      }).catch(() => false);
      return result(entry, {
        dispatched: false,
        failed: !released,
        reason: released ? 'matching_run_terminal_retry_delayed' : 'claim_release_failed',
        slotKey,
      });
    }
  }

  let claim;
  try {
    claim = await claimGenerationSlot(db, slotKey, { now: nowMs });
  } catch {
    return result(entry, { dispatched: false, failed: true, reason: 'generation_slot_claim_failed', slotKey });
  }
  if (!claim.claimed) return result(entry, { dispatched: false, reason: claim.reason, slotKey });

  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${GENERATION_WORKFLOW_ID}/dispatches`;
  const inputs = {
    section: entry.generationSlot,
    dry_run: 'false',
    dispatch_origin: 'cloud_scheduler',
    recovery_slot: slotKey,
    recovery_claim: claim.claimToken,
    [LOOP_CLOCK_INPUT]: loopClockInputValue(entry, nominalSlot),
  };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: githubApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: 'main', inputs }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const released = await releaseGenerationSlotClaim(db, slotKey, claim.claimToken, { now: nowMs }).catch(() => false);
      return result(entry, {
        dispatched: false,
        failed: true,
        reason: released ? `generation_dispatch_failed:${response.status}` : 'generation_dispatch_failed:claim_release_failed',
        slotKey,
        attempt: claim.attempt,
      });
    }
    return result(entry, { dispatched: true, status: response.status, slotKey, attempt: claim.attempt });
  } catch {
    // Network errors are ambiguous: keep the lease, then reconcile against the
    // run-name marker before any retry can acquire a new claim token.
    return result(entry, { dispatched: false, failed: true, reason: 'generation_dispatch_failed:network', slotKey, attempt: claim.attempt });
  }
}
