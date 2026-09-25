/**
 * Cross-run defect memory for the article generator — the first learning link
 * of the loop described in docs/ARTICLE-LEARNING-LOOP.md.
 *
 * WHY THIS EXISTS. Every `generate-article` run is amnesic. A defect committed
 * at run N does not make the same defect less likely at run N+1: the only
 * standing defences are hand-written lists that a human must extend after an
 * incident. `FABRICATED_INSTITUTION_ACRONYMS` in article-factuality-gates.mjs
 * carries `UFI` solely because the owner typed it there on 2026-07-28; the
 * other 55 invented acronyms in the corpus were found by an agent checking
 * them one at a time. The corpus audit measured 52 published articles citing
 * institutions that do not exist — the single most frequent defect class, and
 * the one whose truth value is binary and therefore learnable.
 *
 * WHAT THIS IS NOT. It is deliberately NOT "count how often the generator
 * writes an acronym, block the frequent ones". That rebuilds the exact
 * degeneracy of the 2026-07-28 loop at a slower clock. On that day the
 * fact-checker's own verdicts were fed back as ground truth, so the pipeline
 * optimised against its own measurement and converged on the article that
 * pleased the measurer instead of the one that matched reality. Frequency
 * measures how often the generator EMITS a token, never whether the entity
 * EXISTS: USTRA, EOC and DECS are real and frequent. A frequency-triggered
 * denylist would block correct articles, and — this is the part that makes it
 * unrecoverable — a blocked article is never published, so the system can
 * never observe the counter-evidence that would clear its own mistake.
 *
 * THE TWO AXES. So the store keeps two orthogonal quantities per entity and
 * never lets one stand in for the other:
 *
 *   PREVALENCE  how often the generator emits it. Learned automatically from
 *               every run and from corpus scans. Drives review priority and
 *               negative prompt examples. NEVER blocks on its own.
 *
 *   SUPPORT     whether the run's own source text backs the entity up. This is
 *               an external oracle relative to the generator: the source is
 *               fetched, not written, so it cannot be gamed by the model that
 *               is being judged. Absence of support across independent sources
 *               is the only evidence that can promote an entity to blocking.
 *
 * THE STABILITY ARGUMENT (see the doc for the full version). Evidence is
 * asymmetric on purpose:
 *
 *   - Evidence FOR blocking accumulates slowly, needs several distinct
 *     articles across several distinct RUNS (one runaway run cannot
 *     self-confirm), and decays if the entity stops being emitted.
 *   - Evidence AGAINST blocking lands instantly: a single appearance in any
 *     real source clears the entity permanently on the automatic path, and
 *     that clearance never decays.
 *
 * A false positive therefore has a cheap, automatic exit; a false negative
 * costs one more sighting. Plus three hard stops that no amount of learning
 * can walk past: the curated allowlist can never be promoted (human > machine),
 * the learned denylist is size-capped and REFUSES to grow past the cap rather
 * than quietly blocking more (issue #2947: over-tight gates took the evergreen
 * path to ~0 articles/run), and an entity nobody has seen for months is
 * amnestied with its blocking evidence halved.
 *
 * Zero model calls, zero network. Everything here is a comparison over strings
 * we already hold, so it costs nothing against the shared Max quota and cannot
 * fail open by "the verifier was down".
 */

import { readFileSync, existsSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { KNOWN_INSTITUTION_ACRONYMS } from './article-factuality-gates.mjs';

export const MEMORY_SCHEMA_VERSION = 1;
export const DEFAULT_MEMORY_FILE = 'data/article-defect-memory.json';

/**
 * Every threshold that decides whether a learned entity blocks publication,
 * in one place, with the reasoning attached. Non-Negotiable: no automatic
 * promotion to BLOCKING without an explicit, documented evidence bar.
 */
export const PROMOTION_POLICY = {
  /**
   * Distinct (run, article) sightings with the source failing to support the
   * entity, required before auto-promotion. 3 because 2 is one coincidence
   * away — a niche real office can plausibly be named by the writer twice
   * while two different sources happen not to spell it out; three independent
   * misses is a pattern.
   */
  minUnsupportedSightings: 3,
  /**
   * Distinct runs those sightings must span. This is the anti-runaway clause:
   * a single degraded run that emits the same hallucination in six retries
   * satisfies minUnsupportedSightings on its own, and would otherwise write
   * its own defect straight into the blocking set.
   */
  minUnsupportedRuns: 2,
  /**
   * Hard ceiling on AUTO-confirmed entities. At the cap, promotion stops and
   * says so loudly instead of continuing (see memoryHealth().saturated).
   * The corpus audit found 56 invented acronyms across 3574 articles, so a
   * healthy loop should sit far below 120; reaching it means the classifier
   * is wrong, not that the generator got 120× more inventive.
   */
  maxAutoConfirmed: 120,
  /**
   * Entities a SINGLE policy application may promote to blocking. Above this,
   * ALL promotions in that application are refused.
   *
   * This is the oracle-failure guard, and it is a different failure from
   * saturation. If source extraction breaks — a fetch returning a cookie wall,
   * a paywall stub, an encoding change — then every acronym in every article
   * suddenly reads as "the source does not mention it", and the evidence bar
   * is met legitimately and simultaneously for a dozen real institutions. From
   * inside the store that is indistinguishable from the generator becoming
   * twelve times more inventive overnight. The two hypotheses are not equally
   * likely: hallucination rates drift, they do not step. So a burst is treated
   * as evidence about the ORACLE, not about the entities, and nothing is
   * promoted until a human has looked.
   */
  maxPromotionsPerApplication: 5,
  /** Total entity cap; low-prevalence suspects are evicted first. */
  maxEntities: 600,
  /** A suspect nobody has emitted for this long is forgotten entirely. */
  suspectStaleDays: 90,
  /**
   * Amnesty window for an AUTO-confirmed entity. If the generator has not
   * emitted it for this long, the block is lifted back to `suspect` and its
   * blocking evidence is HALVED — so re-blocking needs fresh evidence, not the
   * old evidence plus one sighting. Clearing evidence is never halved.
   */
  confirmedAmnestyDays: 180,
  /** Recent-sighting samples kept per entity, for human review. */
  maxEvidencePerEntity: 8,
  /** Recent dedup keys kept per entity (see recordObservations). */
  maxKeysPerEntity: 40,
};

export const ENTITY_STATUS = /** @type {const} */ ({
  SUSPECT: 'suspect',
  CONFIRMED: 'confirmed',
  CLEARED: 'cleared',
});

/** Support verdict of a single sighting against the run's own source text. */
export const SUPPORT = /** @type {const} */ ({
  /** The source names the entity → clearing evidence. */
  PRESENT: 'present',
  /** A usable source exists and does not name it → blocking evidence. */
  ABSENT: 'absent',
  /** No source to check against (evergreen path, corpus scan) → prevalence only. */
  UNKNOWN: 'unknown',
});

export function emptyMemory() {
  return { schemaVersion: MEMORY_SCHEMA_VERSION, updatedAt: null, entities: {} };
}

function emptyEntity(now) {
  return {
    status: ENTITY_STATUS.SUSPECT,
    statusSource: 'auto',
    statusAt: now,
    firstSeen: now,
    lastSeen: now,
    seen: 0,
    unsupportedSightings: 0,
    unsupportedRuns: [],
    supportedSightings: 0,
    names: [],
    recentKeys: [],
    evidence: [],
  };
}

/**
 * Parses a memory document, reporting degradation instead of hiding it.
 *
 * Never throws and never returns a half-parsed store: a corrupt file yields an
 * EMPTY memory plus `degraded` with the reason. Callers must surface that —
 * a defence that silently evaluates against an empty memory is a fail-open,
 * and the whole point of the deterministic gates is that they cannot fail open.
 *
 * @param {string} text
 * @returns {{memory: object, degraded: string|null}}
 */
export function parseMemory(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { memory: emptyMemory(), degraded: `JSON non valido: ${e.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { memory: emptyMemory(), degraded: 'documento non è un oggetto' };
  }
  if (raw.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    // Refuse to guess at an unknown layout. A future writer bumping the version
    // must ship a migration; until then this reader is honestly unusable.
    return {
      memory: emptyMemory(),
      degraded: `schemaVersion ${raw.schemaVersion} non supportata (attesa ${MEMORY_SCHEMA_VERSION})`,
    };
  }
  if (!raw.entities || typeof raw.entities !== 'object' || Array.isArray(raw.entities)) {
    return { memory: emptyMemory(), degraded: 'campo "entities" mancante o non è un oggetto' };
  }

  // Drop individually malformed entries rather than the whole store: one bad
  // record written by a buggy producer must not blind every defence.
  const entities = {};
  const skipped = [];
  for (const [key, value] of Object.entries(raw.entities)) {
    if (!value || typeof value !== 'object' || !Object.values(ENTITY_STATUS).includes(value.status)) {
      skipped.push(key);
      continue;
    }
    entities[key] = {
      ...emptyEntity(value.firstSeen || null),
      ...value,
      unsupportedRuns: Array.isArray(value.unsupportedRuns) ? value.unsupportedRuns : [],
      names: Array.isArray(value.names) ? value.names : [],
      recentKeys: Array.isArray(value.recentKeys) ? value.recentKeys : [],
      evidence: Array.isArray(value.evidence) ? value.evidence : [],
    };
  }

  return {
    memory: { schemaVersion: MEMORY_SCHEMA_VERSION, updatedAt: raw.updatedAt || null, entities },
    degraded: skipped.length ? `${skipped.length} voci scartate perché malformate: ${skipped.slice(0, 5).join(', ')}` : null,
  };
}

/**
 * Loads the memory from disk.
 *
 * A MISSING file is not degradation — it is the cold-start state, and the loop
 * must run from empty on day one. An unreadable or corrupt file IS degradation
 * and is reported.
 *
 * @param {string} [filePath]
 * @returns {{memory: object, degraded: string|null, path: string}}
 */
export function loadDefectMemory(filePath = DEFAULT_MEMORY_FILE) {
  if (!existsSync(filePath)) {
    return { memory: emptyMemory(), degraded: null, path: filePath };
  }
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { memory: emptyMemory(), degraded: `file illeggibile: ${e.message}`, path: filePath };
  }
  const parsed = parseMemory(text);
  return { ...parsed, path: filePath };
}

/**
 * Writes the memory back, sorted by key so the git diff of a one-entity change
 * is a one-entity change (these files are committed to `main` by the article
 * workflow and reviewed by eye).
 */
export function saveDefectMemory(memory, filePath = DEFAULT_MEMORY_FILE, now = new Date().toISOString()) {
  const entities = {};
  for (const key of Object.keys(memory.entities || {}).sort()) entities[key] = memory.entities[key];
  writeJsonAtomic(filePath, { schemaVersion: MEMORY_SCHEMA_VERSION, updatedAt: now, entities });
  return filePath;
}

/**
 * Folds a run's observations into the memory.
 *
 * Sightings are deduplicated on `runId:articleId` before they count as
 * evidence. Without that, the six retry attempts of a single run each emit the
 * same acronym and a lone bad run reaches the evidence bar by itself — which
 * is exactly the failure mode `minUnsupportedRuns` exists to stop, so the two
 * guards are deliberately redundant.
 *
 * `supported` sightings are recorded even for entities the store has never
 * seen: an entity the source itself names is worth remembering precisely so it
 * can never be promoted later.
 *
 * @param {object} memory
 * @param {Array<{acronym: string, name?: string, support?: string}>} observations
 * @param {{runId?: string, articleId?: string, now?: string}} [ctx]
 * @returns {{recorded: number, entities: string[]}}
 */
export function recordObservations(memory, observations, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  const runId = String(ctx.runId || 'local');
  const articleId = String(ctx.articleId || 'unknown');
  const key = `${runId}:${articleId}`;
  const touched = new Set();
  let recorded = 0;

  memory.entities = memory.entities || {};

  for (const obs of observations || []) {
    const acronym = String(obs?.acronym || '').trim().toUpperCase();
    if (!acronym) continue;
    const support = Object.values(SUPPORT).includes(obs.support) ? obs.support : SUPPORT.UNKNOWN;

    const entry = memory.entities[acronym] || (memory.entities[acronym] = emptyEntity(now));
    entry.lastSeen = now;
    entry.firstSeen = entry.firstSeen || now;
    entry.seen = (entry.seen || 0) + 1;
    touched.add(acronym);
    recorded++;

    const name = String(obs?.name || '').trim();
    if (name && !entry.names.includes(name)) {
      entry.names.unshift(name);
      entry.names.length = Math.min(entry.names.length, 5);
    }

    // Evidence samples are kept for every support kind — a reviewer needs to
    // see the sighting that CLEARED an entity as much as the ones that damn it.
    entry.evidence.unshift({ at: now, runId, articleId, support, name: name || undefined });
    entry.evidence.length = Math.min(entry.evidence.length, PROMOTION_POLICY.maxEvidencePerEntity);

    if (support === SUPPORT.PRESENT) {
      entry.supportedSightings = (entry.supportedSightings || 0) + 1;
      continue;
    }
    if (support !== SUPPORT.ABSENT) continue; // UNKNOWN: prevalence only, by design.

    // Blocking evidence: once per (run, article).
    if (entry.recentKeys.includes(key)) continue;
    entry.recentKeys.unshift(key);
    entry.recentKeys.length = Math.min(entry.recentKeys.length, PROMOTION_POLICY.maxKeysPerEntity);
    entry.unsupportedSightings = (entry.unsupportedSightings || 0) + 1;
    if (!entry.unsupportedRuns.includes(runId)) {
      entry.unsupportedRuns.unshift(runId);
      entry.unsupportedRuns.length = Math.min(entry.unsupportedRuns.length, PROMOTION_POLICY.maxKeysPerEntity);
    }
  }

  return { recorded, entities: [...touched] };
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * The status an entity DESERVES given its evidence, ignoring what it currently
 * holds. Pure — no mutation — so it can be unit-tested and printed in a review
 * queue without side effects.
 *
 * @param {string} acronym
 * @param {object} entry
 * @param {{policy?: object, allowlist?: Set<string>}} [opts]
 * @returns {{status: string, reason: string}}
 */
export function evaluateEntity(acronym, entry, opts = {}) {
  const policy = { ...PROMOTION_POLICY, ...(opts.policy || {}) };
  const allowlist = opts.allowlist || KNOWN_INSTITUTION_ACRONYMS;
  // An absent entry is "we have never seen this", which is the weakest possible
  // state — never a reason to block. Returning it instead of throwing keeps the
  // gate path total: a lookup miss must not be able to crash a generation run.
  if (!entry || typeof entry !== 'object') {
    return { status: ENTITY_STATUS.SUSPECT, reason: 'nessuna osservazione registrata' };
  }

  // Hard stop 1: a human verdict outranks every amount of machine evidence.
  // The curated lists are the product of someone checking a register; the
  // learner is the product of counting. When they disagree the human wins.
  if (entry.statusSource === 'human') {
    return { status: entry.status, reason: 'verdetto umano — la promozione automatica non lo tocca' };
  }

  // Hard stop 2: nothing on the curated allowlist can ever be learned as fake.
  if (allowlist.has(acronym)) {
    return { status: ENTITY_STATUS.CLEARED, reason: 'presente nell\'allowlist curata degli enti reali' };
  }

  // Clearing evidence is absorbing: one appearance in a real source outranks
  // any quantity of "the source didn't mention it". This is the cheap exit
  // path that stops a false positive from living in the denylist forever.
  if ((entry.supportedSightings || 0) > 0) {
    return {
      status: ENTITY_STATUS.CLEARED,
      reason: `citato da ${entry.supportedSightings} fonte/i reali — non è un'invenzione del generatore`,
    };
  }

  const sightings = entry.unsupportedSightings || 0;
  const runs = (entry.unsupportedRuns || []).length;
  if (sightings >= policy.minUnsupportedSightings && runs >= policy.minUnsupportedRuns) {
    return {
      status: ENTITY_STATUS.CONFIRMED,
      reason: `${sightings} avvistamenti senza riscontro nella fonte su ${runs} run distinti `
        + `(soglia ${policy.minUnsupportedSightings}/${policy.minUnsupportedRuns})`,
    };
  }

  return {
    status: ENTITY_STATUS.SUSPECT,
    reason: `evidenza insufficiente: ${sightings}/${policy.minUnsupportedSightings} avvistamenti `
      + `su ${runs}/${policy.minUnsupportedRuns} run`,
  };
}

/**
 * Applies decay, amnesty, promotion and the saturation stop, in that order.
 *
 * Order matters: decay runs FIRST so a stale confirmation is halved and demoted
 * before promotion gets a chance to look at it, and the saturation check runs
 * last so it counts the post-decay population rather than a stale high-water
 * mark that would freeze the learner permanently.
 *
 * @param {object} memory
 * @param {{now?: string, policy?: object, allowlist?: Set<string>}} [opts]
 * @returns {{promoted: object[], demoted: object[], cleared: object[], evicted: string[],
 *            saturated: boolean, blockedPromotions: string[], warnings: string[]}}
 */
export function applyPromotionPolicy(memory, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const policy = { ...PROMOTION_POLICY, ...(opts.policy || {}) };
  const out = {
    promoted: [], demoted: [], cleared: [], evicted: [],
    saturated: false, oracleSuspect: false, blockedPromotions: [], warnings: [],
  };
  memory.entities = memory.entities || {};

  // ── 1. Decay ────────────────────────────────────────────────────────
  for (const [acronym, entry] of Object.entries(memory.entities)) {
    if (entry.statusSource === 'human') continue;
    const idleDays = daysBetween(entry.lastSeen, now);

    if (entry.status === ENTITY_STATUS.CONFIRMED && idleDays >= policy.confirmedAmnestyDays) {
      // Amnesty. The generator has stopped emitting this for half a year; the
      // block is now costing us the risk of a false positive with none of the
      // benefit. Halve the blocking evidence — NOT reset it: what we observed
      // did happen. Halving means re-blocking needs fresh sightings rather
      // than the old pile plus one, so a wrong confirmation genuinely expires.
      entry.unsupportedSightings = Math.floor((entry.unsupportedSightings || 0) / 2);
      entry.unsupportedRuns = (entry.unsupportedRuns || []).slice(0, Math.floor((entry.unsupportedRuns || []).length / 2));
      entry.status = ENTITY_STATUS.SUSPECT;
      entry.statusAt = now;
      out.demoted.push({ acronym, reason: `amnistia: nessun avvistamento da ${idleDays} giorni, evidenza dimezzata` });
      continue;
    }

    if (entry.status === ENTITY_STATUS.SUSPECT && idleDays >= policy.suspectStaleDays) {
      delete memory.entities[acronym];
      out.evicted.push(acronym);
    }
  }

  // ── 2. Promotion / clearing ─────────────────────────────────────────
  const confirmedCount = () => Object.values(memory.entities)
    .filter((e) => e.status === ENTITY_STATUS.CONFIRMED && e.statusSource !== 'human').length;

  // Burst guard, decided BEFORE anything is promoted: a simultaneous rush of
  // qualifying entities is far better explained by the source oracle breaking
  // than by a step change in the generator, so the whole batch is held.
  // Clearings and demotions still apply — they only ever loosen the defences,
  // and a broken oracle cannot manufacture a clearance (that needs the source
  // to POSITIVELY name the entity).
  const pendingPromotions = Object.entries(memory.entities)
    .filter(([acr, e]) => e.status !== ENTITY_STATUS.CONFIRMED
      && evaluateEntity(acr, e, { policy, allowlist: opts.allowlist }).status === ENTITY_STATUS.CONFIRMED)
    .map(([acr]) => acr);
  const burst = pendingPromotions.length > policy.maxPromotionsPerApplication;
  if (burst) {
    out.oracleSuspect = true;
    out.blockedPromotions.push(...pendingPromotions);
    out.warnings.push(
      `${pendingPromotions.length} entità hanno superato la soglia di evidenza NELLO STESSO passaggio `
      + `(max ${policy.maxPromotionsPerApplication}): ${pendingPromotions.slice(0, 10).join(', ')}. `
      + 'Nessuna promossa. Un picco simultaneo si spiega molto meglio con un guasto '
      + "dell'estrazione fonte (paywall, cookie wall, encoding) che con un salto improvviso del generatore: "
      + 'verifica che le fonti dei run recenti arrivino davvero complete, poi rilancia.',
    );
  }

  for (const [acronym, entry] of Object.entries(memory.entities)) {
    const verdict = evaluateEntity(acronym, entry, { policy, allowlist: opts.allowlist });
    if (verdict.status === entry.status) continue;

    if (verdict.status === ENTITY_STATUS.CONFIRMED && burst) continue;

    if (verdict.status === ENTITY_STATUS.CONFIRMED && confirmedCount() >= policy.maxAutoConfirmed) {
      // Hard stop 3. Refuse, loudly. Growing the blocking set without bound is
      // how the evergreen path reached ~0 articles/run in #2947; a learner
      // that can only ever tighten is a ratchet, and a ratchet on a content
      // pipeline eventually stops the pipeline.
      out.saturated = true;
      out.blockedPromotions.push(acronym);
      continue;
    }

    const previous = entry.status;
    entry.status = verdict.status;
    entry.statusAt = now;
    entry.statusSource = 'auto';
    const record = { acronym, from: previous, to: verdict.status, reason: verdict.reason };
    if (verdict.status === ENTITY_STATUS.CONFIRMED) out.promoted.push(record);
    else if (verdict.status === ENTITY_STATUS.CLEARED) out.cleared.push(record);
    else out.demoted.push(record);
  }

  if (out.saturated) {
    out.warnings.push(
      `Denylist appresa satura: ${confirmedCount()}/${policy.maxAutoConfirmed} entità confermate, `
      + `${out.blockedPromotions.length} promozioni RIFIUTATE (${out.blockedPromotions.slice(0, 10).join(', ')}). `
      + 'Il loop non blocca oltre il cap: revisiona la memoria a mano invece di alzare la soglia.',
    );
  }

  // ── 3. Population cap ───────────────────────────────────────────────
  const total = Object.keys(memory.entities).length;
  if (total > policy.maxEntities) {
    // Evict the least informative first: suspects with the lowest prevalence,
    // oldest last-seen. `confirmed`, `cleared` and human verdicts are never
    // evicted — losing a clearance would let a false positive come back.
    const evictable = Object.entries(memory.entities)
      .filter(([, e]) => e.status === ENTITY_STATUS.SUSPECT && e.statusSource !== 'human')
      .sort((a, b) => (a[1].seen || 0) - (b[1].seen || 0) || String(a[1].lastSeen).localeCompare(String(b[1].lastSeen)));
    for (const [acronym] of evictable.slice(0, total - policy.maxEntities)) {
      delete memory.entities[acronym];
      out.evicted.push(acronym);
    }
    if (Object.keys(memory.entities).length > policy.maxEntities) {
      out.warnings.push(
        `Memoria oltre il cap (${Object.keys(memory.entities).length}/${policy.maxEntities}) e non più riducibile: `
        + 'restano solo voci confermate/scagionate o con verdetto umano. Serve una revisione manuale.',
      );
    }
  }

  return out;
}

/** Acronyms the memory considers proven fabrications → BLOCKING in the gate. */
export function learnedDenylist(memory) {
  const out = new Set();
  for (const [acronym, entry] of Object.entries(memory?.entities || {})) {
    if (entry.status === ENTITY_STATUS.CONFIRMED) out.add(acronym);
  }
  return out;
}

/**
 * Acronyms under suspicion → reported, never blocking.
 *
 * This tier is the reason the loop can afford to be wrong. A suspect costs the
 * pipeline a warning line and a prompt hint; a confirmation costs it a
 * regeneration. Everything the learner is unsure about lives here.
 */
export function learnedSuspects(memory) {
  const out = new Set();
  for (const [acronym, entry] of Object.entries(memory?.entities || {})) {
    if (entry.status === ENTITY_STATUS.SUSPECT) out.add(acronym);
  }
  return out;
}

/**
 * Human review queue: what the loop wants a person to adjudicate, most
 * expensive uncertainty first. Prevalence ranks the queue precisely because it
 * must not decide it — an entity the generator writes constantly is where a
 * human minute buys the most, whichever way the verdict goes.
 */
export function reviewQueue(memory, { limit = 25 } = {}) {
  return Object.entries(memory?.entities || {})
    .filter(([, e]) => e.status === ENTITY_STATUS.SUSPECT)
    .map(([acronym, e]) => ({
      acronym,
      seen: e.seen || 0,
      unsupportedSightings: e.unsupportedSightings || 0,
      unsupportedRuns: (e.unsupportedRuns || []).length,
      names: e.names || [],
      lastSeen: e.lastSeen,
      evidence: e.evidence || [],
    }))
    .sort((a, b) => b.unsupportedSightings - a.unsupportedSightings || b.seen - a.seen)
    .slice(0, limit);
}

/**
 * Whether the loop itself is healthy — the metric that says "stop trusting the
 * learner" before anyone notices articles have stopped shipping.
 */
export function memoryHealth(memory, { policy = PROMOTION_POLICY } = {}) {
  const entries = Object.values(memory?.entities || {});
  const byStatus = { suspect: 0, confirmed: 0, cleared: 0 };
  let humanPinned = 0;
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    if (e.statusSource === 'human') humanPinned++;
  }
  const autoConfirmed = entries.filter((e) => e.status === ENTITY_STATUS.CONFIRMED && e.statusSource !== 'human').length;
  return {
    total: entries.length,
    byStatus,
    humanPinned,
    autoConfirmed,
    saturated: autoConfirmed >= policy.maxAutoConfirmed,
    nearCapacity: entries.length >= policy.maxEntities * 0.9,
  };
}

/** One-line-per-entity rendering for CI step summaries. */
export function formatPolicyOutcome(outcome) {
  const lines = [];
  for (const p of outcome.promoted) lines.push(`  🚫 ${p.acronym}: ${p.from} → CONFERMATO come inventato — ${p.reason}`);
  for (const c of outcome.cleared) lines.push(`  ✅ ${c.acronym}: ${c.from} → SCAGIONATO — ${c.reason}`);
  for (const d of outcome.demoted) lines.push(`  ↩️  ${d.acronym}: declassato — ${d.reason}`);
  if (outcome.evicted.length) lines.push(`  🗑️  ${outcome.evicted.length} voci dimenticate (inattive): ${outcome.evicted.slice(0, 10).join(', ')}`);
  for (const w of outcome.warnings) lines.push(`  ⚠️  ${w}`);
  return lines.join('\n');
}
