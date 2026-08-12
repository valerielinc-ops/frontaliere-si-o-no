/**
 * #5724 — the measure that has to exist before the `ac` expiry can be switched on.
 *
 * The three Remote Config parameters that make the autologin code expire are
 * empty today, and the owner's condition for filling them is that a number
 * exists to say whether the change is locking out 3 people or 3.000. These tests
 * pin that number's arithmetic, because production is not a place to discover
 * that the denominator was wrong.
 *
 * The property under test throughout is the one the issue is actually about:
 * a refusal count is NOT a lockout signal. Anti-phishing scanners hammer this
 * endpoint (35 hits, 25 of them inside 7 seconds from Microsoft IPs, measured on
 * this domain), so any metric that counts 403s cannot tell a policy that is too
 * tight from a Tuesday.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  REFUSED_PREFIX,
  ACCEPTED_PREFIX,
  classifyReason,
  entryText,
  parseExchangeLine,
  policyKey,
  isPreFlightPolicy,
  aggregate,
  lockoutRate,
  evaluate,
  LOCKOUT_RATE_WARN,
  LOCKOUT_RATE_URGENT,
  MIN_SAMPLE,
  CLOCK_PROBE_BUDGET,
} from '../scripts/lib/autologinRefusalMetrics.mjs';
import { runAutologinProbe, tamperSignature, PROBE_EMAIL } from '../scripts/lib/autologinProbe.mjs';

/** Byte-for-byte the shape `refuseAutologin` emits (verified against the
 *  deployed function's Cloud Logging output, 2026-08-12). */
const refusedLine = (reason: string, over: Record<string, unknown> = {}) =>
  `${REFUSED_PREFIX} ${JSON.stringify({
    reason, scheme: 'legacy', mint_scheme: 'legacy', ttl_days: 0, legacy_sunset: null, ...over,
  })}`;

const acceptedLine = (over: Record<string, unknown> = {}) =>
  `${ACCEPTED_PREFIX} ${JSON.stringify({
    scheme: 'legacy', mint_scheme: 'legacy', ttl_days: 0, legacy_sunset: null, age_days: null, ...over,
  })}`;

const parseAll = (lines: string[]) => lines.map((l) => parseExchangeLine(l)).filter(Boolean);

describe('#5724 — parsing the structured lines', () => {
  it('reads a refusal and an acceptance, keeping the policy fields', () => {
    const refused = parseExchangeLine(refusedLine('auth_code_expired', { mint_scheme: 'v1', ttl_days: 30 }));
    expect(refused).toMatchObject({
      kind: 'refused', reason: 'auth_code_expired', family: 'lockout', mintScheme: 'v1', ttlDays: 30,
    });

    const accepted = parseExchangeLine(acceptedLine({ scheme: 'v1', age_days: 12 }));
    expect(accepted).toMatchObject({ kind: 'accepted', scheme: 'v1', ageDays: 12, reason: null });
  });

  it('reads jsonPayload.message as well as textPayload', () => {
    // Not hypothetical: a bare console.log in a gen-2 function lands as
    // textPayload today, but becomes jsonPayload.message the moment anything
    // under functions/ imports firebase-functions/logger. Handling only the
    // shape observed today would make this monitor read a silent zero after an
    // unrelated refactor — the failure mode it exists to catch.
    expect(entryText({ textPayload: refusedLine('invalid_auth_code') })).toContain(REFUSED_PREFIX);
    expect(entryText({ jsonPayload: { message: refusedLine('invalid_auth_code') } })).toContain(REFUSED_PREFIX);
    expect(parseExchangeLine(entryText({ jsonPayload: { message: acceptedLine() } })))
      .toMatchObject({ kind: 'accepted' });
  });

  it('returns null — never throws — on foreign or truncated lines', () => {
    // A single truncated line must not take down a run that reads a day of them.
    expect(parseExchangeLine('📧 Email cascade: 1 to send')).toBeNull();
    expect(parseExchangeLine(`${REFUSED_PREFIX} {"reason":"auth_code_exp`)).toBeNull();
    expect(parseExchangeLine(`${REFUSED_PREFIX} no json here`)).toBeNull();
    expect(parseExchangeLine('')).toBeNull();
    expect(entryText(null)).toBe('');
  });
});

describe('#5724 — the families, i.e. which refusals a rollback can undo', () => {
  it('counts ONLY expired and revoked as lockout', () => {
    // These two are the only refusals NEWSLETTER_AC_TTL_DAYS /
    // NEWSLETTER_AC_LEGACY_SUNSET / NEWSLETTER_AC_SCHEME can cause, and the only
    // ones clearing those three parameters can undo. Everything else in the
    // numerator would make the rollback trigger fire on things a rollback cannot
    // fix.
    expect(classifyReason('auth_code_expired')).toBe('lockout');
    expect(classifyReason('auth_code_revoked')).toBe('lockout');

    expect(classifyReason('invalid_auth_code')).toBe('noise');   // scanners
    expect(classifyReason('autologin_disabled')).toBe('optout'); // the subscriber asked for it
    expect(classifyReason('auth_code_not_yet_valid')).toBe('clock'); // a minter's clock
    expect(classifyReason('something_new')).toBe('unknown');
  });

  it('a scanner storm does not move the rate at all', () => {
    // THE test. 1.000 scanner refusals against 100 real sessions and zero policy
    // refusals is a 91% "403 rate" and a 0% lockout rate. A monitor that read the
    // first number would page at 03:00 over a crawler; this one does not move.
    const agg = aggregate(parseAll([
      ...Array.from({ length: 1000 }, () => refusedLine('invalid_auth_code')),
      ...Array.from({ length: 100 }, () => acceptedLine()),
    ]));
    expect(agg.counts.noise).toBe(1000);
    expect(agg.counts.accepted).toBe(100);
    expect(agg.lockoutRate).toBe(0);
    expect(evaluate(agg).alert).toBe(false);
  });

  it('a deliberate opt-out is not a lockout, and does not enter the denominator', () => {
    // autologin_disabled is a refusal the person requested. Counting it would put
    // a permanent floor under the rate and make the 2% threshold meaningless.
    const agg = aggregate(parseAll([
      ...Array.from({ length: 40 }, () => refusedLine('autologin_disabled')),
      ...Array.from({ length: 60 }, () => acceptedLine()),
    ]));
    expect(agg.counts.optout).toBe(40);
    expect(agg.graded).toBe(60);
    expect(agg.lockoutRate).toBe(0);
  });

  it('lockoutRate is null — not 0 — with nothing to divide', () => {
    // A window with no traffic is not a window with a perfect score. Returning 0
    // would let a dead endpoint read as healthy, which is the "silence looks like
    // success" shape this whole issue is about.
    expect(lockoutRate({ counts: { accepted: 0, lockout: 0 } })).toBeNull();
    expect(lockoutRate({ counts: { accepted: 0, lockout: 0, noise: 500 } })).toBeNull();
  });
});

describe('#5724 — thresholds and the rollback trigger', () => {
  const withRate = (lockout: number, accepted: number) => aggregate(parseAll([
    ...Array.from({ length: lockout }, () => refusedLine('auth_code_expired', { mint_scheme: 'v1', ttl_days: 30 })),
    ...Array.from({ length: accepted }, () => acceptedLine({ mint_scheme: 'v1', ttl_days: 30 })),
  ]));

  it('fires priority 2 at the warn threshold and priority 1 at the urgent one', () => {
    const warn = evaluate(withRate(30, 970)); // 3%
    expect(warn.alert).toBe(true);
    expect(warn.priority).toBe(2);
    expect(warn.findings.map((f) => f.code)).toContain('lockout_rate_warn');

    const urgent = evaluate(withRate(80, 920)); // 8%
    expect(urgent.priority).toBe(1);
    expect(urgent.findings.map((f) => f.code)).toContain('lockout_rate_urgent');

    // And stays quiet below warn.
    const quiet = evaluate(withRate(5, 995), { baseline: { lockoutRate: 0.01 } }); // 0,5%
    expect(quiet.alert).toBe(false);
  });

  it('the thresholds are ordered and expressed as shares, not counts', () => {
    expect(LOCKOUT_RATE_WARN).toBeLessThan(LOCKOUT_RATE_URGENT);
    expect(LOCKOUT_RATE_URGENT).toBeLessThan(1);
  });

  it('abstains below the sample floor, and says it abstained', () => {
    // At n=10 one auth_code_revoked is a 10% rate. Without a floor the loudest
    // alert this monitor can raise is also its least informative one. The
    // abstention is reported rather than silent: a run that read nothing
    // conclusive must not look identical to a green run.
    const thin = evaluate(withRate(1, 9));
    expect(thin.findings.map((f) => f.code)).toContain('insufficient_sample');
    expect(thin.alert).toBe(false);
    expect(withRate(1, 9).graded).toBeLessThan(MIN_SAMPLE);
  });

  it('flags the FIRST policy refusal when the baseline is zero, well below 2%', () => {
    // The one that actually fires on flip day. The pre-flip baseline is zero by
    // construction — with the three parameters empty neither `expired` nor
    // `revoked` is reachable in verifyAutologinCode — so the first policy-caused
    // refusal ever recorded is a state change, long before it is a percentage.
    const firstBite = evaluate(withRate(2, 998), { baseline: { lockoutRate: 0 } }); // 0,2%
    expect(firstBite.alert).toBe(true);
    expect(firstBite.priority).toBe(3);
    expect(firstBite.findings.map((f) => f.code)).toContain('first_lockout_after_zero_baseline');

    // With a non-zero baseline the same rate is business as usual.
    const known = evaluate(withRate(2, 998), { baseline: { lockoutRate: 0.004 } });
    expect(known.alert).toBe(false);
  });

  it('does not alert on the clock refusals its own probe produces', () => {
    // The synthetic probe presents a deliberately future-dated code, so it scores
    // one clock refusal per run. A raw count would make the health check that
    // proves the endpoint is alive the thing that pages — the self-inflicted
    // alert that gets a monitor muted.
    const budgeted = aggregate(parseAll([
      ...Array.from({ length: CLOCK_PROBE_BUDGET }, () => refusedLine('auth_code_not_yet_valid')),
      ...Array.from({ length: 200 }, () => acceptedLine()),
    ]));
    expect(evaluate(budgeted).findings.map((f) => f.code)).not.toContain('clock_skew');

    const skewed = aggregate(parseAll([
      ...Array.from({ length: CLOCK_PROBE_BUDGET + 50 }, () => refusedLine('auth_code_not_yet_valid')),
      ...Array.from({ length: 200 }, () => acceptedLine()),
    ]));
    const v = evaluate(skewed);
    expect(v.findings.map((f) => f.code)).toContain('clock_skew');
    expect(v.alert).toBe(true);
  });

  it('alerts when the denominator stops arriving instead of scoring 0%', () => {
    // A deploy that drops acceptAutologin leaves refusals with no successes to
    // divide by. Every other check here would read that as clean.
    const noDenominator = aggregate(parseAll(
      Array.from({ length: 300 }, () => refusedLine('invalid_auth_code')),
    ));
    const v = evaluate(noDenominator);
    expect(v.findings.map((f) => f.code)).toContain('denominator_missing');
    expect(v.alert).toBe(true);
  });

  it('alerts on an empty window rather than reporting all clear', () => {
    // This endpoint served 335-502 exchanges on every day of the measured week,
    // so zero lines means a broken query, an undeployed log line or a dead
    // endpoint — never a quiet day. Exiting green here would rebuild, inside the
    // monitor, the silent failure #5724 was opened about.
    const v = evaluate(aggregate([]));
    expect(v.findings.map((f) => f.code)).toEqual(['no_signal']);
    expect(v.alert).toBe(true);
    expect(v.priority).toBe(2);
  });
});

describe('#5724 — the pre-flip baseline must stay comparable', () => {
  it('treats a lone legacy sunset as post-flip', () => {
    // The trap: with mintScheme legacy and ttlDays 0 — today's state —
    // NEWSLETTER_AC_LEGACY_SUNSET alone expires EVERY code in circulation on one
    // date. A baseline guard reading only scheme and TTL would keep updating
    // itself while the entire population got locked out.
    expect(isPreFlightPolicy({ mintScheme: 'legacy', ttlDays: 0, legacySunset: null })).toBe(true);
    expect(isPreFlightPolicy({ mintScheme: 'legacy', ttlDays: 0, legacySunset: '2026-09-01' })).toBe(false);
    expect(isPreFlightPolicy({ mintScheme: 'v1', ttlDays: 0, legacySunset: null })).toBe(false);
    expect(isPreFlightPolicy({ mintScheme: 'legacy', ttlDays: 30, legacySunset: null })).toBe(false);
    expect(isPreFlightPolicy(null)).toBe(false);
  });

  it('reads the observed policy from the log lines, and shows a straddled window as straddled', () => {
    // Taken from the lines rather than from the script's own env read, because
    // load-rc-env.mjs does not overwrite a variable already in the environment —
    // a stale export would have the monitor comparing the rate against a policy
    // the deployed function is not running.
    const agg = aggregate(parseAll([
      ...Array.from({ length: 90 }, () => acceptedLine({ mint_scheme: 'v1', ttl_days: 30 })),
      ...Array.from({ length: 10 }, () => acceptedLine()),
    ]));
    expect(agg.observedPolicy).toEqual({ mintScheme: 'v1', ttlDays: 30, legacySunset: null });
    expect(Object.keys(agg.policyMix)).toHaveLength(2);
    expect(policyKey({ mintScheme: 'legacy', ttlDays: 0, legacySunset: null })).toBe('legacy:0:none');
  });

  it('reports the age distribution of ACCEPTED codes — the evidence for the TTL', () => {
    // This is what makes a TTL choosable instead of guessed: the ages of codes
    // people actually use are exactly the population a given
    // NEWSLETTER_AC_TTL_DAYS would have refused, measurable BEFORE it is set.
    const agg = aggregate(parseAll([
      ...Array.from({ length: 95 }, (_, i) => acceptedLine({ scheme: 'v1', age_days: i })),
      ...Array.from({ length: 5 }, () => acceptedLine({ scheme: 'v1', age_days: 200 })),
    ]));
    expect(agg.ageSamples).toBe(100);
    expect(agg.ageDaysP50).toBeLessThan(agg.ageDaysP95!);
    expect(agg.ageDaysP95).toBeGreaterThanOrEqual(94);
    // Legacy codes carry no issue date, so they contribute no age sample at all —
    // and must not be silently counted as age 0, which would make any TTL look safe.
    const legacyOnly = aggregate(parseAll(Array.from({ length: 50 }, () => acceptedLine())));
    expect(legacyOnly.ageSamples).toBe(0);
    expect(legacyOnly.ageDaysP95).toBeNull();
    expect(legacyOnly.acceptedByScheme).toEqual({ legacy: 50 });
  });
});

describe('#5724 — the log line must never carry the credential or the address', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../functions/src/newsletterSubscriptionManagement.js'),
    'utf8',
  );

  it('neither logger interpolates the email or the ac code', () => {
    // The `ac` code IS the credential and the address is personal data, and the
    // provider's logs are already one of the dispersion channels #5685 listed. A
    // source scan rather than a runtime assertion on purpose: the point is that
    // no code path can ever put them there, not that today's path does not.
    const loggers = [...source.matchAll(/console\.(?:log|warn)\('\[exchange_auth_code\] (?:refused|accepted)',([\s\S]*?)\n \};/g)];
    expect(loggers.length).toBe(2);
    for (const [, payload] of loggers) {
      expect(payload).not.toMatch(/normalizedEmail|\bemail\b/);
      expect(payload).not.toMatch(/\btoken\b/);
      expect(payload).not.toMatch(/verdict\.signature|\bcode\b/);
    }
  });

  it('the accepted line exists and is emitted only after a token is really minted', () => {
    // The denominator has to count sessions actually handed out: counting before
    // createCustomToken would let a mint failure inflate the "accepted" half and
    // hide a lockout behind it.
    expect(source).toContain('acceptAutologin(verdict);');
    const idx = source.indexOf('acceptAutologin(verdict);');
    const before = source.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain('createCustomToken');
  });
});

describe('#5724 — the synthetic probe', () => {
  const secret = 'a'.repeat(64);
  const okResponse = (status: number, body: unknown) => ({
    status,
    json: async () => body,
  });

  it('passes when the endpoint answers with the expected refusals', async () => {
    const fetchImpl = vi.fn(async (url: string) => (
      // Two cases: the authentic future-dated code, then the tampered one. The
      // stub replies by position, so the assertion below also pins the order.
      fetchImpl.mock.calls.length === 1
        ? okResponse(403, { success: false, error: 'auth_code_not_yet_valid' })
        : okResponse(403, { success: false, error: 'invalid_auth_code' })
    )) as never;

    const results = await runAutologinProbe({ secret, fetchImpl });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.passed)).toBe(true);
    // Reserved address only — this hits the live production endpoint from CI.
    expect(PROBE_EMAIL.endsWith('@example.com')).toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('action=exchange_auth_code');
  });

  it('FAILS when the endpoint accepts a code it had to refuse', async () => {
    // A 200 means the probe just minted a production Auth user for a reserved
    // address, i.e. an unconditional gate has been switched off. Never tolerable.
    const fetchImpl = vi.fn(async () => okResponse(200, { success: true, authToken: 'x' })) as never;
    const results = await runAutologinProbe({ secret, fetchImpl });
    expect(results.every((r) => !r.passed)).toBe(true);
    expect(results[0].error).toMatch(/ACCETTATO/);
  });

  it('FAILS when mint and verify have drifted apart', async () => {
    // The failure it exists for: after #5726 moved the v1 signature onto its own
    // HMAC domain, a half-deployed change makes the endpoint answer
    // invalid_auth_code to a code this repo minted — every autologin link in the
    // next send is dead, and the refusal rate would show it inside the one family
    // it deliberately discounts as scanner noise.
    const fetchImpl = vi.fn(async () => okResponse(403, { success: false, error: 'invalid_auth_code' })) as never;
    const results = await runAutologinProbe({ secret, fetchImpl });
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain('auth_code_not_yet_valid');
    expect(results[1].passed).toBe(true); // the negative control still holds
  });

  it('SKIPS — never fails — when it cannot probe at all', async () => {
    // This gates `send-newsletter.mjs --send` through the QA artifact. A missing
    // secret locally, or one network blip, must not stop a send; only a definite
    // wrong answer may.
    const noSecret = await runAutologinProbe({ secret: '' });
    expect(noSecret[0].skipped).toBe(true);
    expect(noSecret[0].passed).toBe(true);

    const flaky = vi.fn(async () => { throw new Error('ECONNRESET'); }) as never;
    const results = await runAutologinProbe({ secret, fetchImpl: flaky });
    expect(results.every((r) => r.passed && r.skipped)).toBe(true);
  });

  it('tampers exactly one character of the signature', () => {
    // A code that parses as v1 and fails to verify is a different assertion from
    // sending garbage: it proves the endpoint reaches the signature check.
    const code = 'ac1.20260812.deadbeef0';
    const tampered = tamperSignature(code);
    expect(tampered).toHaveLength(code.length);
    expect([...code].filter((c, i) => c !== tampered[i])).toHaveLength(1);
    expect(tampered).not.toBe(code);
  });
});
