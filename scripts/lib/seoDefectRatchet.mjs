/**
 * seoDefectRatchet.mjs
 *
 * Per-family descending ceiling for the content-defect SEO families tracked by
 * the aggregate follow-up issues #5845 and #6222.
 *
 * WHAT PROBLEM THIS SOLVES. Those two issues are one flat list of seven defect
 * families. Nothing in the repo tracked them family by family: there was no
 * place to read "how many are left in family X", no way for a family that
 * reached zero to be recorded as closed, and no gate that noticed a family
 * growing again. Two of the seven sat permanently red inside `audit:all`
 * (`link-anchor-text`'s non-descriptive half, `duplicate-meta-description`)
 * because they carry a zero-tolerance verdict over a corpus that has ~48 and
 * ~197'000 historical offenders respectively. A gate that can never be green
 * reports the same thing on the day someone fixes half the corpus as on the day
 * someone doubles it, which is to say it reports nothing.
 *
 * WHY A CEILING IS NOT A RELAXATION HERE. AGENTS.md non-negotiable #1 forbids
 * lowering a quality threshold to make a build pass, and carries one delimited
 * exception, decided by the owner on 2026-08-20: the gates that judge the
 * REASSEMBLED corpus in `post-deploy-validate-dist.yml`. That `dist/` is not
 * this build's output — it is the whole published site rehydrated from the
 * shards, carrying pages emitted months ago by code that no longer exists. The
 * exception's contract is «has emission broken?», i.e. a RATE over a sample
 * that covers the corpus, and it requires the measured rate to be printed on
 * every run so the next ceiling tightens on a datum instead of on an
 * intuition. That is exactly this module. Both auditors that consult it run
 * only in that workflow; their vitest mirrors behind `RUN_DIST_GATES=1` keep
 * zero tolerance, and every OTHER family in the ledger keeps its zero-tolerance
 * gate untouched (see `data/seo-defect-families.json`, `enforcement` field).
 *
 * THE ONE-WAY PROPERTY. `tightenLedger()` REFUSES to raise a ceiling unless the
 * caller passes `allowRaise` explicitly. That refusal — not a comment, not a
 * convention — is what makes this a ratchet, and
 * `tests/seo/seo-defect-ratchet.test.ts` asserts it.
 *
 * SAMPLING. `post-deploy-validate-dist.yml` pins `AUDIT_SAMPLE_RATE=0.25`, so
 * every count reaching this module is a rotating quarter of `dist/`. Ceilings
 * are therefore stored as RATES (offenders per 100 files scanned), which is the
 * only scale on which a sampled run and a full walk are comparable — the same
 * reasoning `scripts/lib/mixAdjustedRateGate.mjs` documents at length, and the
 * same shape `data/title-length-baseline.json` already uses.
 *
 * Tolerance defaults deliberately match `DEFAULT_TOL` in
 * `scripts/audit-title-length.mjs` / `scripts/audit-h1-title-duplicates.mjs`
 * (`relPct: 20`). They are NOT imported from there and the four existing
 * rate-ratchet auditors are NOT refactored onto this module: that would be the
 * drive-by refactor AGENTS.md #6 forbids, on four funnel-critical gates, inside
 * a PR about something else. The duplication is one constant, it is named here,
 * and folding those four in is tracked as a chained PR instead.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repo-relative location of the family ledger. */
export const LEDGER_PATH = 'data/seo-defect-families.json';

/**
 * Applied when a family entry does not override it.
 *
 * `relPct: 20` is the repo's existing rate-ratchet tolerance (see the header).
 * `minAbsDelta` is the noise floor in OFFENDERS, on the scale of the run being
 * judged: without it a family whose denominator shrinks (fewer files in this
 * bucket) reads as a rate regression with no extra defects behind it — class
 * #1604, documented in `scripts/audit-text-html-ratio.mjs`.
 */
export const DEFAULT_TOLERANCE = Object.freeze({
  relPct: 20,
  absPp: 0,
  maxDeltaPp: Infinity,
  minAbsDelta: 5,
});

export function resolveLedgerPath(ledgerPath = LEDGER_PATH) {
  return isAbsolute(ledgerPath) ? ledgerPath : join(ROOT, ledgerPath);
}

/**
 * Read the ledger. Throws on a missing or malformed file — callers that must
 * not be turned green by a missing ledger use `readLedgerOrNull()` and fall
 * back to their pre-ratchet verdict.
 *
 * @param {string} [ledgerPath]
 * @returns {{version:number, families:Record<string, object>}}
 */
export function readLedger(ledgerPath = LEDGER_PATH) {
  const parsed = JSON.parse(readFileSync(resolveLedgerPath(ledgerPath), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !parsed.families || typeof parsed.families !== 'object') {
    throw new Error(`seoDefectRatchet: ${ledgerPath} has no \`families\` object`);
  }
  return parsed;
}

/**
 * FAIL-CLOSED READER. Returns `null` instead of throwing, so an auditor can say
 * "no ledger → keep the strict verdict I had before the ratchet existed".
 *
 * The direction matters and is the whole point of having two readers: a missing
 * or corrupt ledger must never be the thing that makes a red gate green. Every
 * call site here treats `null` as "enforce zero tolerance", never as "pass".
 *
 * @param {string} [ledgerPath]
 * @returns {object|null}
 */
export function readLedgerOrNull(ledgerPath = LEDGER_PATH) {
  try { return readLedger(ledgerPath); }
  catch { return null; }
}

/**
 * @param {object|null} ledger
 * @param {string} family
 * @returns {object|null} the family entry, or null when absent/not ratcheted
 */
export function familyEntry(ledger, family) {
  const entry = ledger?.families?.[family];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.enforcement !== 'ratchet') return null;
  if (typeof entry.ceilingRatePct !== 'number' || !(entry.ceilingRatePct >= 0)) return null;
  return entry;
}

/**
 * Judge one family's current draw against its ceiling.
 *
 * @param {object} args
 * @param {string} args.family
 * @param {number} args.offenders offender count AS COUNTED ON THIS RUN (sampled scale)
 * @param {number} args.filesScanned denominator AS COUNTED ON THIS RUN (same scale)
 * @param {object|null} args.entry ledger entry from `familyEntry()`
 * @returns {{
 *   family:string, ratcheted:boolean, measured:boolean, passed:boolean,
 *   offenders:number, filesScanned:number, ratePct:number|null,
 *   ceilingRatePct:number|null, capRatePct:number|null,
 *   expectedOffenders:number|null, exceededBy:number|null,
 *   heldByNoiseFloor:boolean, tightenToRatePct:number|null, humanSummary:string
 * }}
 */
export function evaluateCeiling({ family, offenders, filesScanned, entry }) {
  const base = {
    family,
    ratcheted: false,
    measured: false,
    passed: true,
    offenders,
    filesScanned,
    ratePct: null,
    ceilingRatePct: null,
    capRatePct: null,
    expectedOffenders: null,
    exceededBy: null,
    heldByNoiseFloor: false,
    tightenToRatePct: null,
    humanSummary: '',
  };

  if (!entry) {
    return { ...base, humanSummary: `${family}: no ratchet entry — caller keeps its own verdict` };
  }

  // A run that looked at nothing must not invent a verdict in either
  // direction, and above all must not be allowed to TIGHTEN the ceiling to 0.
  // `tightenToRatePct` stays null here for exactly that reason: a
  // fully-sampled-out or empty slice would otherwise seal a ceiling no real
  // corpus can meet, and the next real run would be red with nothing to fix.
  if (!(filesScanned > 0)) {
    return {
      ...base,
      ratcheted: true,
      ceilingRatePct: entry.ceilingRatePct,
      humanSummary: `${family}: 0 files scanned — VACUOUS run, no verdict taken and no tightening proposed`,
    };
  }

  const tol = { ...DEFAULT_TOLERANCE, ...(entry.tolerance ?? {}) };
  const ceilingRatePct = entry.ceilingRatePct;
  const ratePct = (offenders / filesScanned) * 100;
  const capRatePct =
    ceilingRatePct + Math.min((ceilingRatePct * tol.relPct) / 100, tol.maxDeltaPp) + tol.absPp;
  const expectedOffenders = (ceilingRatePct / 100) * filesScanned;

  // AND-condition, same shape as every other rate ratchet in the repo: a rate
  // that drifts over the cap without a matching absolute rise is a denominator
  // artifact, not a defect.
  const exceeded = ratePct > capRatePct && offenders > expectedOffenders + tol.minAbsDelta;

  const tightenToRatePct = ratePct < ceilingRatePct ? Number(ratePct.toFixed(7)) : null;

  // Three outcomes, not two, and the third one has to say its own name.
  //
  // A draw can sit ABOVE the rate cap and still pass, because the AND-condition
  // holds it: the absolute count is within `minAbsDelta` of what the ceiling
  // allows on this denominator. That is a correct verdict and a dangerous
  // sentence — an earlier version of this function printed it as "at/within the
  // ceiling" while the rate was 27.5 % against a ceiling of 0.0017 %, which
  // reads as the opposite of what happened. `scripts/lib/mixAdjustedRateGate.mjs`
  // has the written record of what that costs: on 2026-08-06 an ambiguous pass/
  // fail line led to a conclusion that two real regressions were denominator
  // artifacts and that the ratchet could be re-sealed over them.
  const allowed = expectedOffenders < 10 ? expectedOffenders.toFixed(2) : String(Math.round(expectedOffenders));
  const scale = `${offenders} offender(s) / ${filesScanned} file(s) = ${ratePct.toFixed(6)} %`;
  const heldByNoiseFloor = !exceeded && ratePct > capRatePct;

  const humanSummary = exceeded
    ? `${family}: REGRESSION — ${scale}, over the ceiling ${ceilingRatePct.toFixed(6)} % ` +
      `(cap ${capRatePct.toFixed(6)} % incl. tolerance; ~${allowed} allowed on this draw, ` +
      `+${Math.round(offenders - expectedOffenders)} more than that)`
    : heldByNoiseFloor
      ? `${family}: ${scale} — ABOVE the ceiling ${ceilingRatePct.toFixed(6)} % (cap ${capRatePct.toFixed(6)} %), ` +
        `but held by the absolute noise floor: ${offenders} offender(s) is within minAbsDelta=${tol.minAbsDelta} of the ` +
        `~${allowed} this ceiling allows on a ${filesScanned}-file draw. NOT a clean pass — a draw this small cannot ` +
        'distinguish a regression from sampling noise.'
      : tightenToRatePct !== null
        ? `${family}: ${scale}, under the ceiling ${ceilingRatePct.toFixed(6)} % — TIGHTEN IT: ` +
          `npm run audit:seo-families:tighten -- --family=${family} --rate=${tightenToRatePct} --run=<run-id>`
        : `${family}: ${scale}, at/within the ceiling ${ceilingRatePct.toFixed(6)} % (cap ${capRatePct.toFixed(6)} %)`;

  return {
    family,
    ratcheted: true,
    measured: true,
    passed: !exceeded,
    offenders,
    filesScanned,
    ratePct: Number(ratePct.toFixed(7)),
    ceilingRatePct,
    capRatePct: Number(capRatePct.toFixed(7)),
    expectedOffenders: Number(expectedOffenders.toFixed(2)),
    exceededBy: exceeded ? Math.round(offenders - expectedOffenders) : null,
    heldByNoiseFloor,
    tightenToRatePct,
    humanSummary,
  };
}

/**
 * THE ONE-WAY VALVE.
 *
 * Returns a NEW ledger object with `family`'s ceiling set to `ratePct`, or
 * throws when that would RAISE the ceiling. Raising is possible only by passing
 * `allowRaise: true`, which exists so a deliberate, reviewed re-seal (a gate
 * whose measurement definition changed, say) is expressible — and so that doing
 * it is a visible, greppable act rather than a quiet edit to a JSON file.
 *
 * Mutation-free by construction: a caller that catches the throw still holds an
 * unmodified ledger.
 *
 * @param {object} args
 * @param {object} args.ledger
 * @param {string} args.family
 * @param {number} args.ratePct new ceiling
 * @param {object} args.provenance `{ runId, measuredAt, filesScanned, sampleRate, observedOffenders }`
 * @param {boolean} [args.allowRaise]
 * @returns {object} the new ledger
 */
export function tightenLedger({ ledger, family, ratePct, provenance, allowRaise = false }) {
  const entry = ledger?.families?.[family];
  if (!entry) throw new Error(`seoDefectRatchet: unknown family "${family}"`);
  if (entry.enforcement !== 'ratchet') {
    throw new Error(
      `seoDefectRatchet: family "${family}" is enforcement="${entry.enforcement}", not a ratchet — ` +
      'nothing to tighten (a zero-tolerance family is already at the tightest possible ceiling)',
    );
  }
  if (!(typeof ratePct === 'number' && ratePct >= 0 && Number.isFinite(ratePct))) {
    throw new Error(`seoDefectRatchet: ratePct must be a finite number >= 0, got ${ratePct}`);
  }
  if (ratePct > entry.ceilingRatePct && !allowRaise) {
    throw new Error(
      `seoDefectRatchet: refusing to RAISE the ceiling for "${family}" ` +
      `(${entry.ceilingRatePct} % → ${ratePct} %). A ratchet only descends. ` +
      'If the measurement definition genuinely changed, re-seal explicitly with allowRaise.',
    );
  }
  if (!provenance || !provenance.runId || !provenance.measuredAt) {
    throw new Error('seoDefectRatchet: provenance { runId, measuredAt, ... } is required — no ceiling without an audit trail');
  }
  return {
    ...ledger,
    families: {
      ...ledger.families,
      [family]: {
        ...entry,
        ceilingRatePct: ratePct,
        raised: ratePct > entry.ceilingRatePct ? true : undefined,
        previousCeilingRatePct: entry.ceilingRatePct,
        measurement: { ...provenance },
      },
    },
  };
}

/** Persist a ledger produced by `tightenLedger()`. */
export function writeLedger(ledger, ledgerPath = LEDGER_PATH) {
  writeFileSync(resolveLedgerPath(ledgerPath), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}
