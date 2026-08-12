/**
 * autologinProbe.mjs — the synthetic half of #5724.
 *
 * WHAT IT PROVES THAT THE METRIC CANNOT
 *
 * The refusal/acceptance ratio answers "is the policy locking people out?".
 * It cannot answer "does the deployed endpoint still agree with the code that
 * mints the links?", because a total mint/verify skew produces no anomalous
 * ratio at all — it produces `invalid_auth_code`, which is the one family the
 * rate deliberately ignores as scanner noise. #5726 moved the v1 signature onto
 * its own HMAC domain; a half-deployed change of that shape makes every link in
 * the next newsletter dead, and the metric would show it as a quiet rise in the
 * bucket everyone has learned to discount.
 *
 * So this presents a code minted HERE, by the same module the senders use, to
 * the endpoint running THERE, and asserts the verdict.
 *
 * WHY A FUTURE-DATED CODE, AND WHY THAT IS THE ONLY SAFE CHOICE
 *
 * An authentic, currently-valid code would be ACCEPTED — and acceptance is not
 * read-only: `exchange_auth_code` calls `admin.auth().createUser()` for an
 * address it has never seen, so a daily probe would mint a fake production Auth
 * user every day. A code stamped 30 days in the future is authentic (so it
 * exercises the full signature path, the Firestore read and the policy read)
 * but is refused by the `futureDated` gate — which is one-sided and therefore
 * cannot be switched off by any value of the three Remote Config parameters.
 *
 * That gives a probe that is:
 *   - deterministic under EVERY policy setting, before and after the flip;
 *   - incapable of succeeding, so incapable of writing anything;
 *   - sensitive to exactly the failure it is for — if the HMAC domain, the v1
 *     tag, the stamp format or the day-granularity ever drift, the endpoint
 *     answers `invalid_auth_code` instead of `auth_code_not_yet_valid`, and the
 *     probe fails loudly.
 *
 * The second probe is the negative control: the same code with one hex digit of
 * the signature changed must come back `invalid_auth_code`. Without it, an
 * endpoint that answered `auth_code_not_yet_valid` to everything would pass.
 *
 * COST TO THE METRIC
 *
 * Each run contributes one `auth_code_not_yet_valid` and one
 * `invalid_auth_code`. Both are outside the lockout rate by design, and
 * `CLOCK_PROBE_BUDGET` in autologinRefusalMetrics.mjs is sized for it.
 */

import { mintAutologinCode } from '../../functions/src/lib/autologinCode.js';

export const PROBE_ENDPOINT = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/newsletterManageSubscription';

/**
 * Repo is public and this address reaches the live production endpoint: it must
 * be un-deliverable and un-ownable by construction. RFC 2606 reserves
 * `example.com` for exactly this.
 */
export const PROBE_EMAIL = 'ac-probe@example.com';

const DAY_MS = 86_400_000;
/** Comfortably past the one-day tolerance `futureDated` allows for the
 *  day-granular stamp, so the verdict cannot flip on a clock a few hours out. */
const PROBE_FUTURE_DAYS = 30;

/** Flip one hex digit of the trailing signature — a code that parses as v1 and
 *  fails to verify, which is a different assertion from sending garbage. */
export function tamperSignature(code) {
  const str = String(code || '');
  if (!str) return str;
  const last = str.slice(-1);
  const swapped = last === '0' ? '1' : '0';
  return str.slice(0, -1) + swapped;
}

async function ask(endpoint, email, token, fetchImpl, timeoutMs) {
  const url = `${endpoint}?action=exchange_auth_code&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}&format=json`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, error: body?.error ?? null, success: body?.success === true };
}

/**
 * @param {object} opts
 * @param {string} opts.secret NEWSLETTER_SECRET
 * @param {string} [opts.endpoint]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.now]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Array<{label: string, passed: boolean, skipped?: boolean, error?: string}>>}
 */
export async function runAutologinProbe({
  secret,
  endpoint = PROBE_ENDPOINT,
  fetchImpl = fetch,
  now = Date.now(),
  timeoutMs = 15_000,
} = {}) {
  // FAIL-OPEN on "cannot probe", FAIL-CLOSED on "probed and the answer was
  // wrong". This runs inside newsletter-qa.mjs, whose artifact gates
  // `send-newsletter.mjs --send`: a missing secret in a local run, or one
  // network blip, must not stop a send, while a real mint/verify skew must —
  // every autologin link in that send would already be dead.
  if (!secret) {
    return [{
      label: 'autologin probe: NEWSLETTER_SECRET assente — sonda saltata',
      passed: true,
      skipped: true,
    }];
  }

  const futureCode = mintAutologinCode(PROBE_EMAIL, {
    secret,
    scheme: 'v1',
    now: now + PROBE_FUTURE_DAYS * DAY_MS,
  });
  if (!futureCode) {
    return [{
      label: 'autologin probe: mintAutologinCode non ha prodotto un codice',
      passed: false,
      error: 'mint_returned_null',
    }];
  }

  const cases = [
    {
      label: `autologin probe: codice v1 datato +${PROBE_FUTURE_DAYS}g → auth_code_not_yet_valid`,
      token: futureCode,
      expect: 'auth_code_not_yet_valid',
    },
    {
      label: 'autologin probe: firma manomessa → invalid_auth_code',
      token: tamperSignature(futureCode),
      expect: 'invalid_auth_code',
    },
  ];

  const results = [];
  for (const c of cases) {
    let observed;
    try {
      observed = await ask(endpoint, PROBE_EMAIL, c.token, fetchImpl, timeoutMs);
    } catch (err) {
      results.push({
        label: c.label,
        passed: true,
        skipped: true,
        error: `endpoint irraggiungibile: ${err?.message || err}`,
      });
      continue;
    }
    // A 200 is the one answer that is never acceptable: it means the probe just
    // minted a session (and an Auth user) for a reserved address, i.e. a gate
    // that should be unconditional has been switched off.
    if (observed.success) {
      results.push({ label: c.label, passed: false, error: 'endpoint ha ACCETTATO un codice che doveva rifiutare' });
      continue;
    }
    const ok = observed.status === 403 && observed.error === c.expect;
    results.push({
      label: c.label,
      passed: ok,
      ...(ok ? {} : { error: `atteso 403/${c.expect}, ricevuto ${observed.status}/${observed.error ?? 'null'}` }),
    });
  }
  return results;
}
