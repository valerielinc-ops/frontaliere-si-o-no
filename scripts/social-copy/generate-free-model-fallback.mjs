#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AI_MODELS,
  callSingleModel,
  getProvider,
  isModelAvailable,
} from '../lib/ai-models.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import {
  assertSocialCopyTreatmentContinuity,
  normalizeSocialCopyPack,
  validatePersistedSocialCopyPack,
} from '../lib/social-copy-pack.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { reserveSocialCopyFreeFallbackInvocation } from '../lib/social-copy-invocation-limit.mjs';
import { assertSocialCopyPackProductionRef, socialCopyInvocationId } from './reserve-codex-invocation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// GitHub Models has been retired; only configured providers with an active free route belong here.
const ALLOWED_FREE_PROVIDERS = new Set(['gemini', 'groq', 'openrouter']);

// Only established no-cost tiers are eligible. Keep Cloudflare, Cohere trials,
// and paid or retired providers out of this recovery path.
export const FREE_SOCIAL_COPY_MODEL_CANDIDATES = Object.freeze([
  Object.freeze({ provider: 'gemini', model: AI_MODELS.GEMMA_4_31B, context: 'full' }),
  Object.freeze({ provider: 'openrouter', model: AI_MODELS.OR_FREE_ROUTER, context: 'full' }),
  Object.freeze({ provider: 'groq', model: AI_MODELS.GROQ_GPT_OSS_120B, context: 'compact' }),
]);

const COMPACT_CONTRACT = `Genera il prossimo pacchetto editoriale settimanale di Frontaliere Ticino in italiano naturale. Restituisci solo un oggetto JSON con esattamente le chiavi editorialPlan e channels. Mantieni la definizione degli angoli e dei pilastri esistenti; aggiorna gli hook senza cambiare il significato degli ID. Usa i brief qualificati solo come segnali descrittivi; dati assenti o sotto soglia sono sconosciuti, non zero. Usa inventario editoriale per idee specifiche e ipotesi dichiarate quando mancano evidenze. Non inventare fatti, eventi, salari, consulenza legale o fiscale, trend, risultati, audience o promesse di portata. Non raccogliere dati da account Instagram concorrenti e non definire virale un formato senza evidenza qualificata del nostro account. Non dire che un canale ha pubblicato o raggiunto persone se la sua deliveryState non è live.

Rispetta il channel matrix, i conteggi, gli obiettivi, le lunghezze e le CTA del contratto completo quando è fornito. Tre angoli distinti per ogni formato; distribuzione uniforme. Instagram article/job/border hanno tre template per ciascun obiettivo share/save/conversation; Reel ha tre template follow, uno per angolo, CTA che inizia con Segui. Facebook job ha dodici template; ogni altro slot ha tre. TikTok e Reddit restano preparazione draft dove la delivery è held. Ogni CTA deve chiedere una sola azione. Non includere URL, contatti, hashtag, markup, segnaposto o numeri nei template se il contratto li vieta. La validazione automatica rifiuterà qualsiasi pack fuori schema. Non aggiungere chiavi top-level, spiegazioni o markdown.`;

const COMPACT_INSTAGRAM_GUIDANCE = `Skill Instagram adattate al publisher: apri con una riga concreta e utile; assegna a ogni template un solo angolo, una promessa e una CTA. Il carosello avanza una sola idea per slide; il Reel ha apertura chiara e progressione, ma non inventare copione, durata o sottotitoli: il publisher compila i kit solo con fatti verificati. Non creare slot Stories: è previsto solo il riuso statico di una cornice già pubblicata, senza sticker, risposte o metriche implicite. La riproposizione usa l'inventario fornito per creare angoli distinti, non copia lo stesso post su ogni canale. La revisione ig-human è editoriale; punteggi lessicali inglesi e rilevatori AI non sono gate né prove di qualità. Una formula creativa non dimostra performance.`;

const ALLOWED_BRIEF_KEYS = Object.freeze([
  'schemaVersion', 'source', 'available', 'status', 'generatedAt', 'baselineDays',
  'minimumSessions', 'minimumObservations', 'acceptedRows', 'variants', 'faqSearchDemand',
  'instagramStories', 'instagramCommunityQuestionDemand', 'channelPilots', 'channels',
  'growthTargets', 'growthTarget90d', 'businessOutcomeTarget', 'businessOutcomeTargetCoverage',
  'growthObjective', 'audienceGrowth', 'linkedinFollowerGains', 'sourceFreshness',
  'instagramCommunityResponse', 'siteOutcomeGrowth', 'socialRobotDelivery', 'sourceCoverage', 'interpretation',
  'publishedArticles', 'historicalTopics', 'topicDiscovery', 'upcomingTicinoEvents',
]);

function argument(name, fallback = '') {
  const item = process.argv.slice(2).find((value) => value.startsWith('--' + name + '='));
  return item ? item.slice(name.length + 3) : fallback;
}

function commandPaths() {
  const names = {
    ga4: 'ga4',
    native: 'native',
    scorecard: 'scorecard',
    topics: 'topics',
    previousPack: 'previous-pack',
    prompt: 'prompt',
    viralSkill: 'viral-skill',
    creativeStudy: 'creative-study',
    output: 'output',
  };
  return Object.fromEntries(Object.entries(names)
    .map(([key, cliName]) => [key, argument(cliName)])
    .filter(([, value]) => Boolean(value)));
}

function readJson(file, label, { optional = false } = {}) {
  if (!file) {
    if (optional) return null;
    throw new Error(label + ' is missing');
  }
  if (!existsSync(file)) throw new Error(label + ' is missing');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function compactObject(value, { maxVariants = 20 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = {};
  for (const key of ALLOWED_BRIEF_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    if (key === 'variants' && Array.isArray(value.variants)) {
      result.variants = value.variants
        .filter((variant) => variant?.eligibleForDescription === true)
        .slice(0, maxVariants);
    } else {
      result[key] = value[key];
    }
  }
  return result;
}

function parsePreviousPack(raw, now = new Date()) {
  if (!raw) return null;
  const previousTime = raw.generatedAt || now;
  return validatePersistedSocialCopyPack(raw, { now: previousTime });
}

const EDITORIAL_PILLAR_FIELDS = Object.freeze(['id', 'name', 'audienceNeed']);
const EDITORIAL_ANGLE_FIELDS = Object.freeze(['id', 'pillarId', 'audienceNeed', 'angle', 'intent']);

function stableEditorialContract(pack) {
  const plan = pack?.editorialPlan;
  if (!plan || !Array.isArray(plan.pillars) || !plan.angles || typeof plan.angles !== 'object') return null;
  const project = (item, fields) => Object.fromEntries(fields.map((field) => [field, item?.[field] ?? null]));
  const sortById = (left, right) => String(left.id).localeCompare(String(right.id));
  return {
    pillars: plan.pillars.map((pillar) => project(pillar, EDITORIAL_PILLAR_FIELDS)).sort(sortById),
    angles: Object.fromEntries(Object.entries(plan.angles).sort(([left], [right]) => left.localeCompare(right)).map(([channel, slots]) => [
      channel,
      Object.fromEntries(Object.entries(slots || {}).sort(([left], [right]) => left.localeCompare(right)).map(([slot, angles]) => [
        slot,
        Array.isArray(angles)
          ? angles.map((angle) => project(angle, EDITORIAL_ANGLE_FIELDS)).sort(sortById)
          : null,
      ])),
    ])),
  };
}

/**
 * Observe whether a validated free-provider pack preserves the current Italian
 * editorial rubric. Hooks and CTAs are intentionally excluded: they refresh
 * weekly, while pillars and angle definitions are the stable treatment contract.
 *
 * @returns {{provider: string, status: 'match'|'mismatch'|'unavailable', baseline: string, stablePillars: number, stableAngles: number, mismatches: string[]}}
 */
export function fallbackPackEditorialParity() {
  const [pack, currentRubric] = arguments;
  const normalizedPack = pack;
  if (!normalizedPack?.editorialPlan || !normalizedPack?.channels || !normalizedPack?.generationProvider) {
    throw new Error('fallback pack is not normalized');
  }
  const provider = normalizedPack.generationProvider;
  const expected = stableEditorialContract(currentRubric);
  const actual = stableEditorialContract(normalizedPack);
  if (!expected || !actual) {
    return {
      provider,
      status: 'unavailable',
      baseline: 'current-pack-editorial-plan',
      stablePillars: actual?.pillars.length || 0,
      stableAngles: actual
        ? Object.values(actual.angles).flatMap((slots) => Object.values(slots)).filter(Array.isArray).reduce((total, angles) => total + angles.length, 0)
        : 0,
      mismatches: [],
    };
  }

  const stablePillars = actual.pillars.length;
  const stableAngles = Object.values(actual.angles)
    .flatMap((slots) => Object.values(slots))
    .filter(Array.isArray)
    .reduce((total, angles) => total + angles.length, 0);
  const matches = JSON.stringify(expected) === JSON.stringify(actual);
  return {
    provider,
    status: matches ? 'match' : 'mismatch',
    baseline: 'current-pack-editorial-plan',
    stablePillars,
    stableAngles,
    mismatches: matches ? [] : ['editorialPlan'],
  };
}

export function selectAvailableFreeModels({ candidates = FREE_SOCIAL_COPY_MODEL_CANDIDATES, providerOf = getProvider, available = isModelAvailable } = {}) {
  const providers = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || !ALLOWED_FREE_PROVIDERS.has(candidate.provider)
      || candidate.provider !== providerOf(candidate.model)
      || providers.has(candidate.provider) || !available(candidate.model)) return false;
    providers.add(candidate.provider);
    return true;
  });
}

function contractForPrompt({ promptFile, viralSkillFile, creativeStudyFile, context }) {
  const prompt = readFileSync(promptFile || path.join(ROOT, 'scripts/social-copy/CODEX-PROMPT.md'), 'utf8');
  const start = prompt.indexOf('Use natural Italian');
  const end = prompt.lastIndexOf('\nWrite the JSON only');
  const completeContract = prompt.slice(start >= 0 ? start : 0, end > start ? end : undefined).trim();
  const viralSkill = readFileSync(viralSkillFile || path.join(ROOT, '.agents/skills/ig-viral/SKILL.md'), 'utf8');
  const creativeStudy = context === 'full'
    ? readFileSync(creativeStudyFile || path.join(ROOT, 'docs/instagram-creative-study.md'), 'utf8')
    : '';
  return [completeContract, 'Instagram performance and research guardrail:', viralSkill, creativeStudy]
    .filter(Boolean)
    .join('\n\n');
}

export function buildSocialCopyFallbackMessages({
  context = 'compact',
  promptFile,
  viralSkillFile,
  creativeStudyFile,
  ga4 = null,
  native = null,
  scorecard = null,
  topics = null,
  previousPack = null,
  now = new Date(),
} = {}) {
  const contract = context === 'full'
    ? contractForPrompt({ promptFile, viralSkillFile, creativeStudyFile, context })
    : `${COMPACT_CONTRACT}\n\n${COMPACT_INSTAGRAM_GUIDANCE}`;
  const input = {
    generatedAt: new Date(now).toISOString(),
    ga4: compactObject(ga4),
    native: compactObject(native),
    scorecard: compactObject(scorecard),
    publishedTopicInventory: compactObject(topics),
    previousEditorialPlan: previousPack?.editorialPlan || null,
  };
  const user = [
    'GOVERNING CONTRACT',
    contract,
    'SANITIZED INPUTS: use only eligible aggregates and dated publisher-source labels. Keep channel cohorts separate.',
    JSON.stringify(input),
    'Return the complete JSON pack now. No file access is available; return JSON text only.',
  ].join('\n\n');
  return [
    { role: 'system', content: 'Sei un editor social italiano. Segui il contratto e i limiti dei dati senza eccezioni. Restituisci JSON valido e nient’altro.' },
    { role: 'user', content: user },
  ];
}

function parsePackResponse(response, { provider, generatedAt, previousPack }) {
  let text = String(response || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced) text = fenced[1].trim();
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join('|') !== 'channels|editorialPlan') {
    throw new Error('response-shape-invalid');
  }
  const normalized = normalizeSocialCopyPack(raw, { generatedAt, generationProvider: provider });
  if (previousPack) assertSocialCopyTreatmentContinuity(previousPack, normalized);
  return { raw, normalized };
}

function statusFromError(error) {
  const explicit = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (Number.isInteger(explicit) && explicit >= 100 && explicit <= 599) return explicit;
  const message = String(error?.message || error || '');
  const match = message.match(/\b(?:HTTP(?:\s+status)?\s*|status(?:[_ -]?code)?\s*[:=]\s*)(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

/** Return a fixed, non-sensitive diagnostic bucket; never expose provider bodies or credentials. */
export function classifySocialCopyFallbackFailure(error, phase = 'request') {
  if (phase === 'validation') return 'response-invalid';
  if (phase === 'output') return 'response-write-failed';

  const message = String(error?.message || error || '').slice(0, 1000).toLowerCase();
  const status = statusFromError(error);
  if (status === 401 || /api key not set|missing api key|invalid api key|unauthorized/.test(message)) {
    return 'provider-auth-failed';
  }
  if (status === 403) return 'provider-access-denied';
  if (status === 402 || status === 429) {
    return 'provider-quota-or-rate-limit';
  }
  if (status === 404) {
    return 'model-unavailable';
  }
  if (status !== null && (status === 408 || status >= 500)) {
    return 'provider-temporary-failure';
  }
  if (status !== null && status >= 400) return 'provider-request-rejected';
  if (/quota|rate.?limit|too many requests|resource exhausted/.test(message)) {
    return 'provider-quota-or-rate-limit';
  }
  if (/model[^\n]{0,60}(not found|unavailable|does not exist)/.test(message)) return 'model-unavailable';
  if (/timeout|timed out|aborted|econnreset|econnrefused|enotfound|eai_again|fetch failed/.test(message)) {
    return 'provider-temporary-failure';
  }
  return 'provider-request-failed';
}

function writeWorkflowOutput(env, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n') + '\n';
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines, { mode: 0o600 });
}

function failureSummary(failures) {
  return failures.length
    ? failures.map(({ provider, phase, category }) => `${provider}:${phase}:${category}`).join(',')
    : 'none';
}

function markNoPack({ env, stdout, reason, attempted = [], failures = [] }) {
  const summary = failureSummary(failures);
  writeWorkflowOutput(env, {
    pack_generated: 'false', provider: 'none', reason,
    attempt_failures: summary,
    editorial_parity: 'not-evaluated',
    editorial_parity_provider: 'none',
  });
  stdout.write(`pack_generated=false\nprovider=none\nreason=${reason}\nattempted=${attempted.join(',')}\nattempt_failures=${summary}\neditorial_parity=not-evaluated\neditorial_parity_provider=none\n`);
  return { packGenerated: false, provider: null, reason, attempted, failures };
}

export async function run({
  env = process.env,
  now = new Date(),
  modelCandidates,
  available = isModelAvailable,
  providerOf = getProvider,
  callModel = callSingleModel,
  db,
  reserve = reserveSocialCopyFreeFallbackInvocation,
  stdout = process.stdout,
  inputPaths = {},
  outputPath = '',
} = {}) {
  assertSocialCopyPackProductionRef(env);
  const paths = { ...commandPaths(), ...inputPaths };
  const responsePath = outputPath || paths.output
    || (env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, 'social-copy-response.json') : '');
  const candidates = selectAvailableFreeModels({ candidates: modelCandidates || FREE_SOCIAL_COPY_MODEL_CANDIDATES, providerOf, available });
  if (!candidates.length) return markNoPack({ env, stdout, reason: 'no-free-provider-available' });
  if (!responsePath) return markNoPack({ env, stdout, reason: 'response-output-path-missing' });
  const currentRaw = readJson(
    paths.previousPack || path.join(ROOT, 'data/social-copy-packs/current.json'),
    'current social-copy pack',
    { optional: true },
  );
  const previousPack = parsePreviousPack(currentRaw, now);
  const ga4 = readJson(paths.ga4, 'GA4 brief', { optional: true });
  const native = readJson(paths.native, 'native brief', { optional: true });
  const scorecard = readJson(paths.scorecard, 'growth scorecard', { optional: true });
  const topics = readJson(paths.topics, 'published-topic inventory', { optional: true });
  const invocationId = socialCopyInvocationId(env);
  let reservation;
  try {
    const firestore = db || await getFirestoreDb();
    reservation = await reserve({ db: firestore, invocationId, now });
  } catch {
    return markNoPack({ env, stdout, reason: 'free-fallback-budget-reservation-failed' });
  }
  if (!reservation.allowed) {
    return markNoPack({ env, stdout, reason: 'free-fallback-weekly-budget-exhausted' });
  }

  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const attempted = [];
  const failures = [];
  for (const candidate of candidates) {
    attempted.push(candidate.provider);
    const messages = buildSocialCopyFallbackMessages({
      context: candidate.context,
      promptFile: paths.prompt,
      viralSkillFile: paths.viralSkill,
      creativeStudyFile: paths.creativeStudy,
      ga4,
      native,
      scorecard,
      topics,
      previousPack,
      now,
    });
    let response;
    try {
      response = await callModel(messages, {
        model: candidate.model,
        temperature: 0.3,
        maxTokens: candidate.context === 'compact' ? 6000 : 7500,
        jsonMode: true,
        timeout: 90_000,
        maxRetriesPerModel: 1,
        backoffMs: 0,
        recordScore: false,
      });
    } catch (error) {
      const category = classifySocialCopyFallbackFailure(error);
      failures.push({ provider: candidate.provider, phase: 'request', category });
      stdout.write(`provider_attempt_failed=${candidate.provider}:${category}\n`);
      continue;
    }

    let parsed;
    let editorialParity;
    try {
      parsed = parsePackResponse(response, { provider: candidate.provider, generatedAt, previousPack });
      editorialParity = fallbackPackEditorialParity(parsed.normalized, previousPack);
    } catch (error) {
      const category = classifySocialCopyFallbackFailure(error, 'validation');
      failures.push({ provider: candidate.provider, phase: 'validation', category });
      stdout.write(`provider_attempt_failed=${candidate.provider}:${category}\n`);
      continue;
    }

    try {
      writeFileSync(responsePath, JSON.stringify(parsed.raw, null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
      const category = classifySocialCopyFallbackFailure(error, 'output');
      failures.push({ provider: candidate.provider, phase: 'output', category });
      return markNoPack({ env, stdout, reason: category, attempted, failures });
    }

    const summary = failureSummary(failures);
    writeWorkflowOutput(env, {
      pack_generated: 'true', provider: candidate.provider, reason: 'generated',
      attempt_failures: summary,
      editorial_parity: editorialParity.status,
      editorial_parity_provider: editorialParity.provider,
    });
    stdout.write(`pack_generated=true\nprovider=${candidate.provider}\nattempt_failures=${summary}\neditorial_parity=${editorialParity.status}\neditorial_parity_provider=${editorialParity.provider}\n`);
    return { packGenerated: true, provider: candidate.provider, attempted, failures, editorialParity };
  }
  return markNoPack({ env, stdout, reason: 'all-free-models-failed', attempted, failures });
}

if (isInvokedDirectly(import.meta.url)) {
  run().then((result) => {
    if (!result.packGenerated) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`Social copy free-model fallback failed: ${String(error?.message || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  });
}
