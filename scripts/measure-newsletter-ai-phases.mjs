#!/usr/bin/env node
/**
 * Measure the newsletter's AI phases (2: briefings, 3: subjects) before and
 * after the per-locale briefing, on the same input, against a simulated Codex
 * broker. No network, no Firestore, no model.
 *
 * The broker is simulated because its behaviour, not the model's, decides the
 * wall clock: codex-auth-broker.mjs runs ONE request at a time, so N calls
 * take N × service time however many callers wait. The service time comes from
 * run 36230809455 (73 calls, Phase 2 from 08:56:24 to 11:17:50 = 116 s each);
 * the worst case is the Codex CLI ceiling (CODEX_CLI_MAX_TIMEOUT_MS, 600 s).
 * A request whose turn comes after the caller's deadline is dropped, and a
 * running one is cut at the deadline, as _requestCodexExecution and
 * _codexFallbackTimeoutMs do. Time is virtual: Date.now is replaced while a
 * scenario runs, so an hour of broker time takes milliseconds.
 *
 * PRE replays the removed Phase 2 (batches of ≤3 cohorts per locale, one call
 * each, no deadline); POST runs the shipped composeCohortBriefings /
 * composeLocaleSubjects with generateLocaleBriefing / generateAISubject.
 *
 *   node scripts/measure-newsletter-ai-phases.mjs [--json]
 *
 * With `--lanes N` it measures instead Phases 2 and 3 one after the other
 * against the two together, on a broker with N parallel lanes
 * (measureNewsletterAiLanes), counting calls and prompt characters too.
 *
 *   node scripts/measure-newsletter-ai-phases.mjs --lanes 3
 */
import {
  AI_PHASE_BUDGET_MS,
  composeCohortBriefings,
  composeLocaleSubjects,
  generateAISubject,
  generateLocaleBriefing,
} from './send-newsletter.mjs';

export const MEASURED_SERVICE_MS = 116_000;
export const CODEX_CEILING_MS = 600_000;
const LOCALES = ['it', 'en', 'de', 'fr'];
const VARIANTS = ['concreto', 'curioso'];
const PRE_BATCH_SIZE = 3;
const EXCHANGE = { rate: 1.0595, previousRate: 1.0557 };

function cohortsFor(total) {
  const cohorts = new Map();
  for (let i = 0; i < total; i++) {
    const locale = LOCALES[i % LOCALES.length];
    cohorts.set(`${locale}:${i}`, {
      locale,
      subscriber: { locale },
      members: [{}],
      matchedJobs: [{ title: `Ruolo ${i}`, company: `Azienda${i}`, location: 'Lugano', url: `/lavoro/ruolo-${i}` }],
    });
  }
  return cohorts;
}

/**
 * Virtual clock driven by a time-ordered event queue: `at(t)` resolves when
 * the clock reaches t, and every continuation of one event (retries, next
 * calls) runs before the clock moves to the next one, so each caller reads
 * exactly its own completion time from Date.now.
 */
function virtualClock() {
  let now = Date.parse('2026-09-28T10:14:09Z');
  const events = [];
  let stepping = false;
  function step() {
    const next = events.shift();
    if (!next) { stepping = false; return; }
    if (next.t > now) now = next.t;
    next.resolve();
    setImmediate(step);
  }
  return {
    get now() { return now; },
    at(t) {
      return new Promise((resolve) => {
        events.push({ t, resolve });
        events.sort((a, b) => a.t - b.t);
        if (!stepping) { stepping = true; setImmediate(step); }
      });
    },
  };
}

/** One-at-a-time broker with a fixed service time and deadline cut-offs. */
function serializedBroker(clock, { serviceMs, shortFirstAttempt = false }) {
  let freeAt = clock.now;
  const attemptsByPrompt = new Map();
  const stats = { calls: 0, dropped: 0, cut: 0 };
  async function llm(messages, opts = {}) {
    stats.calls++;
    const deadline = opts.deadlineMs ?? Infinity;
    const promptKey = messages.map((m) => m.content).join('\n');
    const attempt = (attemptsByPrompt.get(promptKey) || 0) + 1;
    attemptsByPrompt.set(promptKey, attempt);
    // The broker's slot is taken when the request arrives, not when it ends:
    // that is what makes the queue serial.
    const start = Math.max(clock.now, freeAt);
    const dropped = start >= deadline;
    const end = dropped ? deadline : Math.min(start + serviceMs, deadline);
    if (!dropped) freeAt = end;
    await clock.at(end);
    if (dropped) {
      stats.dropped++;
      throw new Error('Codex auth broker queue wait timed out before Codex started (deadline)');
    }
    if (start + serviceMs > deadline) {
      stats.cut++;
      throw new Error('Codex CLI timed out at the caller deadline');
    }
    const system = messages[0]?.content || '';
    if (/email subject line/i.test(system)) return '💼 Nuove offerte a Lugano questa settimana';
    const words = shortFirstAttempt && attempt === 1 ? 40 : 90;
    return `<p>${Array.from({ length: words }, (_, w) => `parola${w}`).join(' ')}.</p>`;
  }
  return { llm, stats };
}

async function withVirtualTime(clock, fn) {
  const realNow = Date.now;
  const realWarn = console.warn;
  Date.now = () => clock.now;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    Date.now = realNow;
    console.warn = realWarn;
  }
}

async function pre({ cohorts, serviceMs }) {
  const clock = virtualClock();
  const broker = serializedBroker(clock, { serviceMs });
  return withVirtualTime(clock, async () => {
    const byLocale = new Map();
    for (const [key, cohort] of cohorts) {
      if (!byLocale.has(cohort.locale)) byLocale.set(cohort.locale, []);
      byLocale.get(cohort.locale).push(key);
    }
    const batches = [];
    for (const keys of byLocale.values()) {
      for (let i = 0; i < keys.length; i += PRE_BATCH_SIZE) batches.push(keys.slice(i, i + PRE_BATCH_SIZE));
    }
    const t0 = clock.now;
    // Concurrency is irrelevant behind a serialized broker: the calls queue.
    await Promise.all(batches.map(() => broker.llm([{ role: 'system', content: 'briefing batch' }, { role: 'user', content: String(Math.random()) }])));
    const phase2Ms = clock.now - t0;
    const phase2Calls = broker.stats.calls;
    const t1 = clock.now;
    await Promise.all(LOCALES.flatMap((loc) => VARIANTS.map((v) => broker.llm([
      { role: 'system', content: `Write ONE email subject line (${loc}/${v})` },
      { role: 'user', content: '' },
    ]))));
    return {
      phase2Calls,
      phase2Minutes: +(phase2Ms / 60_000).toFixed(1),
      phase3Calls: broker.stats.calls - phase2Calls,
      phase3Minutes: +((clock.now - t1) / 60_000).toFixed(1),
    };
  });
}

async function post({ cohorts, serviceMs, shortFirstAttempt }) {
  const clock = virtualClock();
  const broker = serializedBroker(clock, { serviceMs, shortFirstAttempt });
  return withVirtualTime(clock, async () => {
    const t0 = clock.now;
    const briefingDeadlineMs = clock.now + AI_PHASE_BUDGET_MS;
    const phase2 = await composeCohortBriefings(cohorts, {
      locales: LOCALES,
      exchangeRate: EXCHANGE,
      generate: (loc) => generateLocaleBriefing({ locale: loc, exchangeRate: EXCHANGE, exchangeInsight: null, weeklyFact: null, featuredTool: null },
        { deadlineMs: briefingDeadlineMs, llm: broker.llm }),
    });
    const phase2Ms = clock.now - t0;
    const phase2Calls = broker.stats.calls;
    const phase2Dropped = broker.stats.dropped;
    const t1 = clock.now;
    const subjectDeadlineMs = clock.now + AI_PHASE_BUDGET_MS;
    const subjects = await composeLocaleSubjects(cohorts, {
      locales: LOCALES,
      variantIds: VARIANTS,
      briefingMap: phase2.briefingMap,
      exchangeRate: EXCHANGE,
      generate: (ctx) => generateAISubject(ctx, { deadlineMs: subjectDeadlineMs, llm: broker.llm }),
    });
    return {
      phase2Calls,
      phase2Retries: phase2Calls - LOCALES.length,
      phase2Minutes: +(phase2Ms / 60_000).toFixed(1),
      localesOnAi: phase2.localeBriefings.size,
      cohortsOnFallback: phase2.fallbackCohorts,
      phase2DroppedAtDeadline: phase2Dropped,
      phase3Calls: broker.stats.calls - phase2Calls,
      phase3DroppedAtDeadline: broker.stats.dropped - phase2Dropped,
      phase3Minutes: +((clock.now - t1) / 60_000).toFixed(1),
      subjects: subjects.size,
      cutAtDeadline: broker.stats.cut,
    };
  });
}

/**
 * Broker with `lanes` parallel slots (codex-auth-broker.mjs --max-concurrency),
 * first come first served, with a service time per request kind. It counts the
 * calls and the prompt characters sent, a proxy of the input tokens.
 */
function lanedBroker(clock, { lanes, briefingMs, subjectMs }) {
  const freeAt = Array(lanes).fill(clock.now);
  const stats = { calls: 0, promptChars: 0 };
  async function llm(messages) {
    stats.calls++;
    stats.promptChars += messages.reduce((n, m) => n + String(m.content || '').length, 0);
    const subject = /email subject line/i.test(messages[0]?.content || '');
    const lane = freeAt.indexOf(Math.min(...freeAt));
    const start = Math.max(clock.now, freeAt[lane]);
    const end = start + (subject ? subjectMs : briefingMs);
    freeAt[lane] = end;
    await clock.at(end);
    if (subject) return '💼 Nuove offerte a Lugano questa settimana';
    return `<p>${Array.from({ length: 90 }, (_, w) => `parola${w}`).join(' ')}.</p>`;
  }
  return { llm, stats };
}

/** Cohorts whose jobs paragraph alone covers the subject Theme (3 long titles). */
function cohortsWithLongJobs(total) {
  const cohorts = cohortsFor(total);
  for (const cohort of cohorts.values()) {
    cohort.matchedJobs = [
      { title: 'Specialista in contabilità e controllo di gestione', company: 'Azienda A', location: 'Lugano', url: '/lavoro/a' },
      { title: 'Responsabile della logistica di magazzino', company: 'Azienda B', location: 'Mendrisio', url: '/lavoro/b' },
      { title: 'Tecnico di laboratorio chimico', company: 'Azienda C', location: 'Bellinzona', url: '/lavoro/c' },
    ];
  }
  return cohorts;
}

/**
 * Phases 2 and 3 on a broker with lanes: one after the other (`together:
 * false`, the order before the phases ran together) or together, with Phase 3
 * reading each locale's briefing through `briefingFor` as send-newsletter.mjs
 * does.
 */
async function lanedPhases({ cohorts, lanes, briefingMs, subjectMs, together }) {
  const clock = virtualClock();
  const broker = lanedBroker(clock, { lanes, briefingMs, subjectMs });
  return withVirtualTime(clock, async () => {
    const t0 = clock.now;
    const deadlineMs = clock.now + AI_PHASE_BUDGET_MS;
    const ctx = (loc) => ({ locale: loc, exchangeRate: EXCHANGE, exchangeInsight: null, weeklyFact: null, featuredTool: null });
    const briefingCalls = new Map();
    const briefingFor = (loc) => {
      if (!briefingCalls.has(loc)) briefingCalls.set(loc, generateLocaleBriefing(ctx(loc), { deadlineMs, llm: broker.llm }));
      return briefingCalls.get(loc);
    };
    const subjectsWith = (source) => composeLocaleSubjects(cohorts, {
      locales: LOCALES,
      variantIds: VARIANTS,
      ...source,
      exchangeRate: EXCHANGE,
      generate: (subjectCtx) => generateAISubject(subjectCtx, { deadlineMs, llm: broker.llm }),
    });
    let subjects;
    if (together) {
      [, subjects] = await Promise.all([
        composeCohortBriefings(cohorts, { locales: LOCALES, exchangeRate: EXCHANGE, generate: briefingFor }),
        subjectsWith({ briefingFor }),
      ]);
    } else {
      const phase2 = await composeCohortBriefings(cohorts, { locales: LOCALES, exchangeRate: EXCHANGE, generate: briefingFor });
      subjects = await subjectsWith({ briefingMap: phase2.briefingMap });
    }
    return {
      seconds: Math.round((clock.now - t0) / 1000),
      calls: broker.stats.calls,
      promptChars: broker.stats.promptChars,
      subjects: [...subjects.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
  });
}

// Service times of the per-locale design, run 36385271711 (2026-09-28): one
// briefing in 34 s, two subjects in 35 s one after the other.
export const LANE_SERVICE = Object.freeze({ briefingMs: 34_000, subjectMs: 17_000 });

/**
 * The phases one after the other and together, on the same cohorts, prompts
 * and service times, with `lanes` broker lanes. Two inputs: short jobs
 * paragraphs (every subject has to wait for its locale's briefing) and long
 * ones (no subject waits).
 */
export async function measureNewsletterAiLanes({ lanes = 3, cohortCount = 700 } = {}) {
  const results = [];
  for (const [input, cohorts] of [['short-jobs-paragraph', cohortsFor(cohortCount)], ['long-jobs-paragraph', cohortsWithLongJobs(cohortCount)]]) {
    const sequential = await lanedPhases({ cohorts, lanes, ...LANE_SERVICE, together: false });
    const together = await lanedPhases({ cohorts, lanes, ...LANE_SERVICE, together: true });
    results.push({ input, lanes, sequential, together, savedSeconds: sequential.seconds - together.seconds });
  }
  return results;
}

export const SCENARIOS = Object.freeze([
  { id: 'measured-116s', serviceMs: MEASURED_SERVICE_MS, shortFirstAttempt: false },
  { id: 'measured-116s-every-first-answer-too-short', serviceMs: MEASURED_SERVICE_MS, shortFirstAttempt: true },
  { id: 'codex-ceiling-600s-every-first-answer-too-short', serviceMs: CODEX_CEILING_MS, shortFirstAttempt: true },
]);

export async function measureNewsletterAiPhases({ cohortCount = 700 } = {}) {
  const cohorts = cohortsFor(cohortCount);
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push({
      scenario: scenario.id,
      cohorts: cohortCount,
      locales: LOCALES.length,
      budgetMinutes: AI_PHASE_BUDGET_MS / 60_000,
      pre: await pre({ cohorts, serviceMs: scenario.serviceMs }),
      post: await post({ cohorts, serviceMs: scenario.serviceMs, shortFirstAttempt: scenario.shortFirstAttempt }),
    });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--lanes')) {
  const lanes = Number(process.argv[process.argv.indexOf('--lanes') + 1]) || 3;
  const results = await measureNewsletterAiLanes({ lanes });
  console.log(`| input (${lanes} lanes) | one after the other: s, calls, prompt chars | together: s, calls, prompt chars | saved s |`);
  console.log('|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.input} | ${r.sequential.seconds}, ${r.sequential.calls}, ${r.sequential.promptChars} | ${r.together.seconds}, ${r.together.calls}, ${r.together.promptChars} | ${r.savedSeconds} |`);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await measureNewsletterAiPhases();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('| scenario | PRE Phase 2: calls, min | PRE Phase 3: calls, min | POST Phase 2: calls (retries, dropped at deadline), min | POST Phase 3: calls (dropped at deadline), min | POST locales on AI |');
    console.log('|---|---|---|---|---|---|');
    for (const r of results) {
      console.log(`| ${r.scenario} | ${r.pre.phase2Calls}, ${r.pre.phase2Minutes} | ${r.pre.phase3Calls}, ${r.pre.phase3Minutes} | ${r.post.phase2Calls} (${r.post.phase2Retries}, ${r.post.phase2DroppedAtDeadline}), ${r.post.phase2Minutes} | ${r.post.phase3Calls} (${r.post.phase3DroppedAtDeadline}), ${r.post.phase3Minutes} | ${r.post.localesOnAi}/${r.locales} |`);
    }
  }
  process.exit(0);
}
