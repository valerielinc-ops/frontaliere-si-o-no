/**
 * Crawler quarantine: the entry, the tolerated verdict and BOTH exits.
 *
 * Il gruppo di quarantena (crawler-group-24) e' nato il 2026-09-22 (#9522) come
 * raccolta a mano dei crawler che fallivano, e da allora ci si entrava solo con
 * PR manuali (#9580, #9632, #9796, #9970, #10012, #10111) senza alcuna uscita:
 * il gruppo chiudeva rosso a ogni ondata per costruzione («16 succeeded, 4
 * failed» il 28-09), e un rosso nuovo dentro lo stesso gruppo non si vedeva.
 *
 * Il contratto, in `data/crawler-quarantine.json`:
 *
 *   - ogni membro del gruppo di quarantena ha una voce, con il gruppo in cui
 *     rientra (`homeGroup`, `null` = posizionamento deterministico del
 *     generatore) e la data di ingresso; il generatore rifiuta un membro senza
 *     voce e una voce il cui crawler e' pinnato altrove;
 *   - una voce con `failingSince` e' un fallimento NOTO: ha un'issue e una
 *     scadenza (`failingSince` + RETIRE_DAYS). Fino alla scadenza il suo rosso
 *     e' escluso dal verdetto del gruppo (warning, riga di summary); dopo, torna
 *     a far fallire il gruppo;
 *   - il rosso di qualunque altro membro (nuovo, o gia' verde: una regressione)
 *     fa fallire il gruppo come prima;
 *   - `retired` elenca i crawler ritirati: restano nel manifest (riattivarli e'
 *     togliere la voce) ma il generatore non li schedula.
 *
 * Le due uscite le decide `decideQuarantine()` sulle ondate osservate (le run
 * completate del gruppo), in modo deterministico:
 *
 *   - RIENTRO dopo REJOIN_GREEN_WAVES ondate verdi consecutive;
 *   - RITIRO quando la serie rossa corrente conta RETIRE_RED_WAVES ondate
 *     oppure dura RETIRE_DAYS giorni da `failingSince`, la prima che scatta.
 *
 * Il gruppo pero' non si svuota mai (`holdLastQuarantineMember()`): il roster
 * di generazione rifiuta un gruppo senza crawler, quindi se tutti i membri
 * uscirebbero insieme l'ultimo rientro resta in attesa.
 *
 * I numeri, dalla storia reale del gruppo (8 run, 23-09 → 28-09):
 *
 *   - cadenza osservata: ~2 ondate al giorno (09:00 e 21:00 UTC piu' i
 *     dispatch di recupero, fino a 3 il 28-09);
 *   - la serie rossa piu' lunga poi guarita e' di 4 ondate (confederazione,
 *     26-09 14:06 → 27-09 15:05); fachkraft ne ha fatte 2, tsmg/postfinance/
 *     sunrise 1;
 *   - REJOIN_GREEN_WAVES = 4: due giorni puliti alla cadenza osservata, cioe'
 *     entrambe le finestre giornaliere viste due volte, e quanto la serie rossa
 *     piu' lunga che si e' poi risolta;
 *   - RETIRE_RED_WAVES = 10: 2,5 volte quella serie, ~5 giorni alla cadenza
 *     osservata; con i dispatch di recupero puo' arrivare prima di RETIRE_DAYS,
 *     ed e' voluto: dieci tentativi rossi di fila non sono un caso transitorio;
 *   - RETIRE_DAYS = 7: la stessa soglia oltre la quale
 *     `scripts/check-crawler-health.mjs` considera stantio un crawler
 *     (STALE_AFTER_DAYS). Oltre, gli annunci pubblicati sono comunque vecchi.
 *
 * Tutto qui dentro e' puro (niente rete, niente fs salvo load/serialize): la
 * raccolta delle ondate e gli effetti (issue, PR) stanno in
 * `scripts/crawler-quarantine-review.mjs`.
 */
import fs from 'node:fs';

export const QUARANTINE_REJOIN_GREEN_WAVES = 4;
export const QUARANTINE_RETIRE_RED_WAVES = 10;
export const QUARANTINE_RETIRE_DAYS = 7;
export const QUARANTINE_OUTCOMES_NOTICE_TITLE = 'crawler-quarantine-outcomes';
export const QUARANTINE_REGISTRY_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const OUTCOMES = new Set(['success', 'failure', 'missing', 'systemic']);

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value) && Number.isFinite(Date.parse(value));
}

function isIssueNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * The `reason` an AUTOMATIC retirement writes into `retired[slug]`, and its
 * recognizer, side by side so the two cannot drift (a test round-trips them).
 *
 * A threshold retirement says only "it stayed red long enough": it is not the
 * triangulated evidence DECISIONS 2026-09-23 asks for before calling a source
 * gone. `scripts/ci/close-retired-crawler-issues.mjs` uses the recognizer to
 * tell such a retirement apart from one whose reason was written by hand.
 */
export function automaticRetireReason({ streak, retireRedWaves, days, failingSince, retireDays }) {
  return streak >= retireRedWaves
    ? `${streak} ondate rosse consecutive (soglia ${retireRedWaves})`
    : `${Math.floor(days)} giorni di fallimenti da ${String(failingSince).slice(0, 10)} (soglia ${retireDays})`;
}

export const AUTOMATIC_RETIRE_REASON_RE =
  /^(?:\d+ ondate rosse consecutive|\d+ giorni di fallimenti da \d{4}-\d{2}-\d{2}) \(soglia \d+\)$/;

export function isAutomaticRetireReason(reason) {
  return typeof reason === 'string' && AUTOMATIC_RETIRE_REASON_RE.test(reason.trim());
}

/** YYYY-MM-DD of the last day a known failure is still excluded from the verdict. */
export function quarantineDeadline(entry, retireDays = QUARANTINE_RETIRE_DAYS) {
  if (!entry?.failingSince) return null;
  return new Date(Date.parse(entry.failingSince) + retireDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Validate the registry document shape. Throws a single error listing every
 * problem, so a hand edit gets one complete answer instead of one per run.
 */
export function validateQuarantineRegistry(doc, { groupCount } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('crawler quarantine registry must be a JSON object');
  }
  if (doc.schemaVersion !== QUARANTINE_REGISTRY_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${QUARANTINE_REGISTRY_SCHEMA_VERSION}`);
  }
  const groupOk = Number.isSafeInteger(doc.group) && doc.group >= 1 && (!groupCount || doc.group <= groupCount);
  if (!groupOk) problems.push(`group must be an integer in 1..${groupCount ?? 'groupCount'}`);
  const members = doc.members;
  if (!members || typeof members !== 'object' || Array.isArray(members)) {
    problems.push('members must be an object keyed by crawler slug');
  } else {
    for (const [slug, entry] of Object.entries(members)) {
      const where = `members.${slug}`;
      if (!SLUG_RE.test(slug)) problems.push(`${where}: invalid slug`);
      if (!entry || typeof entry !== 'object') {
        problems.push(`${where}: entry must be an object`);
        continue;
      }
      if (entry.homeGroup !== null && !(Number.isSafeInteger(entry.homeGroup)
        && entry.homeGroup >= 1 && (!groupCount || entry.homeGroup <= groupCount) && entry.homeGroup !== doc.group)) {
        problems.push(`${where}.homeGroup must be null or a group other than the quarantine group`);
      }
      if (!isIsoTimestamp(entry.enteredAt)) problems.push(`${where}.enteredAt must be an ISO timestamp`);
      if (entry.failingSince !== null && !isIsoTimestamp(entry.failingSince)) {
        problems.push(`${where}.failingSince must be null or an ISO timestamp`);
      }
      if (entry.failingSince !== null && !isIssueNumber(entry.issue)) {
        problems.push(`${where}: a known failure (failingSince) must name its tracking issue`);
      }
      if (entry.issue !== null && entry.issue !== undefined && !isIssueNumber(entry.issue)) {
        problems.push(`${where}.issue must be null or a positive issue number`);
      }
    }
  }
  const retired = doc.retired ?? {};
  if (typeof retired !== 'object' || Array.isArray(retired)) {
    problems.push('retired must be an object keyed by crawler slug');
  } else {
    for (const [slug, entry] of Object.entries(retired)) {
      const where = `retired.${slug}`;
      if (!SLUG_RE.test(slug)) problems.push(`${where}: invalid slug`);
      if (members && Object.prototype.hasOwnProperty.call(members, slug)) {
        problems.push(`${where}: a crawler cannot be both quarantined and retired`);
      }
      if (!isIsoTimestamp(entry?.retiredAt)) problems.push(`${where}.retiredAt must be an ISO timestamp`);
      if (!isIssueNumber(entry?.issue)) problems.push(`${where}: a retirement must name the issue that announces it`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid crawler quarantine registry:\n  ${problems.join('\n  ')}`);
  }
  return doc;
}

/** Missing file = no quarantine configured (synthetic manifests, scratch runs). */
export function loadQuarantineRegistry(filePath, { groupCount } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return validateQuarantineRegistry(JSON.parse(fs.readFileSync(filePath, 'utf8')), { groupCount });
}

export function quarantineRegistryDoc(registry) {
  return {
    _comment: [
      'Crawler quarantine registry (scripts/lib/crawler-quarantine.mjs). Every member of the',
      'quarantine group has an entry; failingSince + issue mark a KNOWN failure, excluded from',
      'the group verdict until failingSince + 7 days. scripts/crawler-quarantine-review.mjs',
      'moves a crawler back after 4 green waves and retires it after 10 red waves or 7 days.',
      'Edit together with data/crawler-group-assignments.json and re-run the generator.',
    ].join(' '),
    schemaVersion: QUARANTINE_REGISTRY_SCHEMA_VERSION,
    group: registry.group,
    members: registry.members,
    retired: registry.retired ?? {},
  };
}

/**
 * Pin membership must match the registry exactly: a crawler pinned into the
 * quarantine group without an entry would be excluded from nothing but also
 * leave with nothing, and an entry for a crawler pinned elsewhere would be a
 * tolerance that no workflow applies.
 */
export function assertQuarantineMembership(registry, assignments, liveSlugs) {
  if (!registry) return;
  const quarantineIndex = registry.group - 1;
  const pinned = new Set(assignments[quarantineIndex] ?? []);
  const expected = Object.keys(registry.members).filter((slug) => liveSlugs.has(slug));
  const problems = [];
  for (const slug of pinned) {
    if (!Object.prototype.hasOwnProperty.call(registry.members, slug)) {
      problems.push(`${slug} is pinned in the quarantine group ${registry.group} without an entry in data/crawler-quarantine.json`);
    }
  }
  for (const slug of expected) {
    if (!pinned.has(slug)) {
      problems.push(`${slug} has a quarantine entry but is not pinned in group ${registry.group}`);
    }
  }
  if (problems.length > 0) throw new Error(`crawler quarantine membership mismatch:\n  ${problems.join('\n  ')}`);
}

/** Known failures the quarantine group excludes from its verdict, with their deadline. */
export function toleratedQuarantineFailures(registry, memberSlugs) {
  if (!registry) return new Map();
  const tolerated = new Map();
  for (const slug of memberSlugs) {
    const entry = registry.members[slug];
    if (!entry?.failingSince) continue;
    tolerated.set(slug, { issue: entry.issue, deadline: quarantineDeadline(entry) });
  }
  return tolerated;
}

/**
 * Turn the annotations of one completed quarantine-group run into a wave.
 *
 * Preferred source: the machine-readable notice the aggregate step emits
 * (QUARANTINE_OUTCOMES_NOTICE_TITLE). Runs generated before it existed are read
 * from the aggregate's own annotations; a failed run is trusted only when the
 * per-crawler errors add up to the failure count its verdict line states (the
 * runner keeps at most 10 annotations of a kind per step), otherwise it is not
 * a usable observation. A run without a verdict (setup failure, cancellation)
 * is not a wave at all.
 */
export function waveFromRunAnnotations({ run, annotations, memberSlugs }) {
  const messages = (annotations ?? []).map((a) => ({
    title: String(a?.title ?? ''),
    message: String(a?.message ?? ''),
  }));
  const base = { runId: run.id, createdAt: run.createdAt };
  const notice = messages.find((m) => m.title === QUARANTINE_OUTCOMES_NOTICE_TITLE);
  if (notice) {
    try {
      const parsed = JSON.parse(notice.message);
      const outcomes = {};
      for (const [slug, outcome] of Object.entries(parsed?.outcomes ?? {})) {
        if (OUTCOMES.has(outcome)) outcomes[slug] = outcome;
      }
      return { ...base, source: 'notice', outcomes };
    } catch {
      return null;
    }
  }
  if (run.conclusion === 'success') {
    return { ...base, source: 'legacy', outcomes: Object.fromEntries(memberSlugs.map((slug) => [slug, 'success'])) };
  }
  if (run.conclusion !== 'failure') return null;
  const verdict = messages
    .map((m) => /^crawler group completed with (\d+) succeeded, (\d+) failed, (\d+) missing/.exec(m.message))
    .find(Boolean);
  if (!verdict) return null;
  const outcomes = Object.fromEntries(memberSlugs.map((slug) => [slug, 'success']));
  let failures = 0;
  for (const { message } of messages) {
    let match = /^([a-z0-9][a-z0-9-]*): (?:crawler exited with status \d+|invalid terminal status)/.exec(message);
    if (match) {
      failures += 1;
      if (match[1] in outcomes) outcomes[match[1]] = 'failure';
      continue;
    }
    match = /^([a-z0-9][a-z0-9-]*): runner shutdown recorded/.exec(message);
    if (match && match[1] in outcomes) {
      outcomes[match[1]] = 'systemic';
      continue;
    }
    match = /^([a-z0-9][a-z0-9-]*): no terminal status/.exec(message);
    if (match && match[1] in outcomes) outcomes[match[1]] = 'missing';
  }
  if (failures !== Number(verdict[2])) return null;
  return { ...base, source: 'legacy', outcomes };
}

function streaksFor(slug, entry, waves) {
  const enteredAtMs = Date.parse(entry.enteredAt);
  const series = waves
    .filter((wave) => Date.parse(wave.createdAt) >= enteredAtMs)
    .map((wave) => ({ createdAt: wave.createdAt, runId: wave.runId, outcome: wave.outcomes?.[slug] }))
    .filter((point) => point.outcome === 'success' || point.outcome === 'failure')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latest = series[0]?.outcome ?? null;
  let streak = 0;
  while (streak < series.length && series[streak].outcome === latest) streak += 1;
  return {
    latest,
    streak,
    streakStart: streak > 0 ? series[streak - 1].createdAt : null,
    streakRuns: series.slice(0, streak).map((point) => point.runId),
    observed: series.length,
  };
}

/**
 * Decide, deterministically, what happens to every quarantined crawler.
 *
 * `waves` are completed runs of the quarantine group (any order); only the
 * ones started after a crawler entered quarantine count for it, and only
 * success/failure outcomes (a runner shutdown or a missing status says nothing
 * about the crawler).
 */
export function decideQuarantine({
  registry,
  waves,
  now,
  rejoinGreenWaves = QUARANTINE_REJOIN_GREEN_WAVES,
  retireRedWaves = QUARANTINE_RETIRE_RED_WAVES,
  retireDays = QUARANTINE_RETIRE_DAYS,
}) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`decideQuarantine: invalid now ${JSON.stringify(now)}`);
  const decisions = [];
  for (const [slug, entry] of Object.entries(registry.members)) {
    const s = streaksFor(slug, entry, waves);
    const evidence = { latest: s.latest, streak: s.streak, streakStart: s.streakStart, runs: s.streakRuns, observed: s.observed };
    if (s.latest === 'success' && s.streak >= rejoinGreenWaves) {
      decisions.push({ slug, action: 'rejoin', homeGroup: entry.homeGroup, issue: entry.issue ?? null, evidence });
      continue;
    }
    if (s.latest === 'failure') {
      if (!entry.failingSince) {
        decisions.push({ slug, action: 'mark-failing', failingSince: s.streakStart, evidence });
        continue;
      }
      const days = (nowMs - Date.parse(entry.failingSince)) / DAY_MS;
      if (s.streak >= retireRedWaves || days >= retireDays) {
        decisions.push({
          slug,
          action: 'retire',
          homeGroup: entry.homeGroup,
          issue: entry.issue,
          failingSince: entry.failingSince,
          reason: automaticRetireReason({
            streak: s.streak, retireRedWaves, days, failingSince: entry.failingSince, retireDays,
          }),
          evidence,
        });
        continue;
      }
      decisions.push({ slug, action: 'keep-failing', issue: entry.issue, deadline: quarantineDeadline(entry, retireDays), evidence });
      continue;
    }
    if (s.latest === 'success' && entry.failingSince) {
      decisions.push({ slug, action: 'mark-recovering', issue: entry.issue ?? null, evidence });
      continue;
    }
    decisions.push({ slug, action: 'observe', evidence });
  }
  return decisions;
}

/**
 * The quarantine group never empties.
 *
 * It is one of the generated groups, and the crawler generation roster refuses
 * a group without crawlers (`Invalid roster for group 24`,
 * createCrawlerGenerationRoster in scripts/lib/crawler-generation-contract.mjs):
 * a group run with nothing to crawl has no receipt for the generation barrier
 * to wait on. Run 36789918924 (2026-09-30) decided four rejoins and one
 * retirement for all five members, emptied group 24 and died in the generator
 * after the retirement issue had already been opened.
 *
 * When the decisions would remove every crawler pinned in the group, the
 * rejoin with the weakest evidence (shortest green streak, then the latest
 * entry, then the slug) is held instead: the crawler stays as the last member
 * and rejoins at the first review after another crawler enters. It is green,
 * and a held known failure also loses its tolerance, so a new red of it fails
 * the quarantine verdict exactly as it would at home. A retirement is never
 * held, because it would keep a crawler past its deadline scheduled: with no
 * rejoin to hold this throws before any side effect.
 */
export function holdLastQuarantineMember({ registry, assignments, decisions }) {
  const pinned = assignments[registry.group - 1] ?? [];
  const leaving = new Set(decisions
    .filter((d) => d.action === 'rejoin' || d.action === 'retire')
    .map((d) => d.slug));
  if (pinned.length === 0 || pinned.some((slug) => !leaving.has(slug))) return decisions;
  const enteredAtMs = (slug) => Date.parse(registry.members[slug]?.enteredAt ?? '') || 0;
  const [held] = decisions
    .filter((d) => d.action === 'rejoin' && pinned.includes(d.slug))
    .sort((a, b) => (a.evidence?.streak ?? 0) - (b.evidence?.streak ?? 0)
      || enteredAtMs(b.slug) - enteredAtMs(a.slug)
      || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  if (!held) {
    const retiring = pinned.filter((slug) => leaving.has(slug)).join(', ');
    throw new Error(
      `crawler quarantine: retiring ${retiring} would leave the quarantine group ${registry.group} empty, `
      + 'and the crawler generation roster refuses an empty group. A retirement is not held (the crawler '
      + 'would stay scheduled past its deadline): another crawler has to enter the quarantine group '
      + '(data/crawler-quarantine.json + data/crawler-group-assignments.json) before it can leave.',
    );
  }
  const dropsTolerance = Boolean(registry.members[held.slug]?.failingSince);
  return decisions.map((d) => (d === held
    ? {
      slug: d.slug,
      action: 'hold',
      homeGroup: d.homeGroup,
      issue: d.issue ?? null,
      dropsTolerance,
      reason: `ultimo membro del gruppo di quarantena ${registry.group}: il roster di generazione rifiuta un gruppo vuoto`,
      evidence: d.evidence,
    }
    : d));
}

/** Decisions that change the registry or the pins (the others are reports). */
export function isMutatingDecision(decision) {
  if (decision.action === 'hold') return decision.dropsTolerance === true;
  return ['rejoin', 'retire', 'mark-failing', 'mark-recovering'].includes(decision.action);
}

/**
 * Apply decisions to a registry and to the pinned groups. Pure: returns new
 * objects. `issues` maps slug -> issue number for the decisions that need one
 * (mark-failing: the tracking issue; retire: the announcement).
 *
 * A rejoining crawler is appended to its home group; with no recorded home it
 * is simply unpinned, so the generator places it with its deterministic
 * new-crawler rule (never into the quarantine group).
 */
export function applyQuarantineDecisions({ registry, assignments, decisions, now, issues = {} }) {
  const next = structuredClone({ ...registry, retired: registry.retired ?? {} });
  const groups = assignments.map((group) => [...group]);
  const q = registry.group - 1;
  const unpin = (slug) => {
    groups[q] = groups[q].filter((s) => s !== slug);
  };
  for (const decision of decisions) {
    const { slug } = decision;
    switch (decision.action) {
      case 'rejoin': {
        delete next.members[slug];
        unpin(slug);
        if (decision.homeGroup) groups[decision.homeGroup - 1].push(slug);
        break;
      }
      case 'retire': {
        const issue = issues[slug];
        if (!isIssueNumber(issue)) throw new Error(`retiring ${slug} requires the issue that announces it`);
        delete next.members[slug];
        unpin(slug);
        next.retired[slug] = {
          retiredAt: now,
          issue,
          homeGroup: decision.homeGroup ?? null,
          reason: decision.reason,
        };
        break;
      }
      case 'mark-failing': {
        const issue = issues[slug];
        if (!isIssueNumber(issue)) throw new Error(`tolerating ${slug} requires its tracking issue`);
        next.members[slug] = { ...next.members[slug], failingSince: decision.failingSince, issue };
        break;
      }
      case 'mark-recovering':
      case 'hold': {
        if (decision.action === 'hold' && !decision.dropsTolerance) break;
        next.members[slug] = { ...next.members[slug], failingSince: null };
        break;
      }
      default:
        break;
    }
  }
  // Defense for callers that skip holdLastQuarantineMember(): an empty
  // quarantine group would only surface later as `Invalid roster for group N`.
  if ((assignments[q] ?? []).length > 0 && groups[q].length === 0) {
    throw new Error(`crawler quarantine: the decisions would leave the quarantine group ${registry.group} empty; run holdLastQuarantineMember() first`);
  }
  return { registry: next, assignments: groups };
}
