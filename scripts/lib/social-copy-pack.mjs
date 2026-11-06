import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOCIAL_COPY_PACK_SCHEMA_VERSION = 4;
export const SOCIAL_COPY_PROMPT_VERSION = 'frontaliere-social-copy-v4';
export const SOCIAL_COPY_PACK_MAX_AGE_DAYS = 45;
export const SOCIAL_COPY_EXPERIMENT_PROTOCOL_VERSION = 'social-copy-angle-matched-block-v4';
const LEGACY_SOCIAL_COPY_PACK_SCHEMA_VERSION = 1;
const LEGACY_SOCIAL_COPY_PROMPT_VERSION = 'frontaliere-social-copy-v1';
const SECOND_PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION = 2;
const SECOND_PREVIOUS_SOCIAL_COPY_PROMPT_VERSION = 'frontaliere-social-copy-v2';
const PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION = 3;
const PREVIOUS_SOCIAL_COPY_PROMPT_VERSION = 'frontaliere-social-copy-v3';

export const SOCIAL_COPY_CHANNELS = Object.freeze({
  instagram: Object.freeze(['article', 'job', 'border', 'reel']),
  tiktok: Object.freeze(['article', 'job', 'border', 'video']),
  facebook: Object.freeze(['article', 'job', 'event', 'digest']),
  linkedin: Object.freeze(['article', 'job']),
  telegram: Object.freeze(['job', 'border']),
  reddit: Object.freeze(['article', 'job']),
});
const LEGACY_SOCIAL_COPY_CHANNELS = Object.freeze({
  instagram: SOCIAL_COPY_CHANNELS.instagram,
  tiktok: SOCIAL_COPY_CHANNELS.tiktok,
  facebook: SOCIAL_COPY_CHANNELS.facebook,
  linkedin: SOCIAL_COPY_CHANNELS.linkedin,
  telegram: SOCIAL_COPY_CHANNELS.telegram,
});

const MAX_TEMPLATES_PER_KIND = 3;
const MAX_TEMPLATES_PER_INSTAGRAM_OBJECTIVE = 3;
const EDITORIAL_ANGLE_COUNT_PER_SLOT = 3;
const INSTAGRAM_ENGAGEMENT_OBJECTIVES = Object.freeze(['share', 'save', 'conversation']);
const INSTAGRAM_REEL_GROWTH_OBJECTIVES = Object.freeze(['follow']);
export const SOCIAL_COPY_INSTAGRAM_OBJECTIVES = Object.freeze([
  ...INSTAGRAM_ENGAGEMENT_OBJECTIVES,
  ...INSTAGRAM_REEL_GROWTH_OBJECTIVES,
]);
const SOCIAL_COPY_EDITORIAL_INTENTS = Object.freeze(['searchable', 'shareable', 'both']);
const SOCIAL_COPY_EDITORIAL_EVIDENCE = Object.freeze([
  'qualified-aggregate-performance',
  'publisher-source-inventory',
  'editorial-hypothesis',
]);
const TEMPLATE_COUNT_OVERRIDES = Object.freeze({
  instagram: Object.freeze({ article: 9, job: 9, border: 9, reel: 9 }),
  facebook: Object.freeze({ job: 12 }),
});
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SOCIAL_COPY_BLOCK_SOURCE_CLASSES = new Set(['article', 'job', 'event', 'digest', 'border', 'reel', 'video']);
const URL_OR_CONTACT_RE = /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|@[\w.]+)/i;
const HTML_OR_TEMPLATE_MARKUP_RE = /[<>{}]/;
const NUMERIC_CLAIM_RE = /\d|\b(?:percento|percentuali|chf|eur|euro|franchi|ore|minuti|giorni|settimane|anni)\b/i;
// Recognize imperative actions only; verb stems would also accept descriptive
// forms such as "condividendo" or future-tense claims such as "salveremo".
const INSTAGRAM_OBJECTIVE_ACTION_RE = Object.freeze({
  share: /\bcondividi(?:lo|la|li|le|ne)?\b/iu,
  save: /\b(?:salva|conserva)(?:lo|la|li|le|ne)?\b|\bmetti\s+da\s+parte\b|\baggiungi\s+ai\s+preferiti\b/iu,
  conversation: /\?\s*(?:commenta|scrivi(?:lo|la|li|le|ne|ci)?|racconta(?:lo|la|li|le|ne|ci|celo|cela)?|dicci|rispondi(?:ci)?|lascia\s+un)[^?]*\bcomment(?:i|o)\b/iu,
  follow: /\bsegui(?:ci)?\b/iu,
});
const INSTAGRAM_OBJECTIVE_CTA_PREFIX_RE = Object.freeze({
  share: /^\s*condividi(?:lo|la|li|le|ne)?\b/iu,
  save: /^\s*(?:salva|conserva)(?:lo|la|li|le|ne)?\b|^\s*metti\s+da\s+parte\b|^\s*aggiungi\s+ai\s+preferiti\b/iu,
  follow: /^\s*segui(?:ci)?\b/iu,
});
const INSTAGRAM_NEGATED_ACTION_RE = /\bnon\s+(?:condivid\p{L}*|salv\p{L}*|conserv\p{L}*|metti\s+da\s+parte|aggiungi\s+ai\s+preferiti|comment\p{L}*|scriv\p{L}*|raccont\p{L}*|dicc\p{L}*|rispond\p{L}*|lascia\s+un\s+commento|segu\p{L}*)\b/iu;
const INSTAGRAM_OPEN_QUESTION_RE = /^\s*(?:che\s+cosa|cosa|quale|quali|qual|come|dove|quando|chi|quanto|quanta|quanti|quante|perch[eé]|in\s+che\s+modo)\b[^?]*\?/iu;
const CTA_ACTION_RE = /\b(?:condividi(?:lo|la|li|le|ne)?|salva(?:lo|la|li|le|ne)?|conserva(?:lo|la|li|le|ne)?|metti\s+da\s+parte|aggiungi\s+ai\s+preferiti|commenta|scrivi(?:lo|la|li|le|ne|ci)?|racconta(?:lo|la|li|le|ne|ci|celo|cela)?|dicci|rispondi(?:ci)?|lascia\s+un\s+commento|leggi|approfondisci|apri|consulta|visita|vai|clicca|scopri|guarda|ascolta|candidati|invia(?:lo|la|li|le|ci)?|manda|compila|segui|iscriviti|partecipa|verifica|controlla|esplora|trova|prenota|tagga(?:mi|lo|la|li|le|ci)?|menziona(?:mi|lo|la|li|le|ci)?|invita(?:mi|lo|la|li|le|ci)?|inoltra(?:mi|lo|la|li|le|ci)?)\b/giu;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_SOCIAL_COPY_PACK_PATH = path.join(ROOT, 'data', 'social-copy-packs', 'current.json');

function instagramObjectivesForKind(kind, schemaVersion = SOCIAL_COPY_PACK_SCHEMA_VERSION) {
  if (kind === 'reel' && Number(schemaVersion) >= SOCIAL_COPY_PACK_SCHEMA_VERSION) {
    return INSTAGRAM_REEL_GROWTH_OBJECTIVES;
  }
  return INSTAGRAM_ENGAGEMENT_OBJECTIVES;
}

export function socialCopyTemplateCount(channel, kind, schemaVersion = SOCIAL_COPY_PACK_SCHEMA_VERSION) {
  if (channel === 'instagram' && kind === 'reel') {
    return Number(schemaVersion) >= SOCIAL_COPY_PACK_SCHEMA_VERSION
      ? INSTAGRAM_REEL_GROWTH_OBJECTIVES.length * MAX_TEMPLATES_PER_INSTAGRAM_OBJECTIVE
      : 9;
  }
  return TEMPLATE_COUNT_OVERRIDES[channel]?.[kind] || MAX_TEMPLATES_PER_KIND;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/** Fingerprint angle semantics so recurring copy refreshes keep one treatment. */
export function socialCopyExperimentTreatmentFingerprint(pack, { channel, slot, objective = '' } = {}) {
  const angleDefinitions = pack?.editorialPlan?.angles?.[channel]?.[slot];
  const templates = pack?.channels?.[channel]?.[slot];
  if (!Array.isArray(angleDefinitions) || !Array.isArray(templates)) return '';
  const activeTemplates = templates.filter((template) => channel !== 'instagram' || template?.objective === objective);
  const angleIds = [...new Set(activeTemplates.map((template) => String(template?.angleId || '').trim()))].sort();
  if (angleIds.length < 2 || angleIds.some((id) => !TEMPLATE_ID_RE.test(id))) return '';
  const pillars = new Map((pack.editorialPlan?.pillars || []).map((pillar) => [pillar.id, pillar]));
  const treatments = angleIds.map((id) => {
    const angle = angleDefinitions.find((item) => item.id === id);
    const pillar = pillars.get(angle?.pillarId);
    if (!angle || !pillar) return null;
    return {
      id: angle.id,
      pillar: { id: pillar.id, name: pillar.name, audienceNeed: pillar.audienceNeed },
      audienceNeed: angle.audienceNeed,
      angle: angle.angle,
      intent: angle.intent,
    };
  });
  if (treatments.some((treatment) => treatment === null)) return '';
  return createHash('sha256')
    .update(stableJson({ version: 'social-copy-angle-treatment-v1', channel, slot, objective, treatments }))
    .digest('hex');
}

export function socialCopyExperimentRegistrationId({ experimentId, packId, treatmentFingerprint = '', channel, slot, objective = '' } = {}) {
  const treatment = String(treatmentFingerprint || '').trim();
  const cohort = /^[a-f0-9]{64}$/u.test(treatment)
    ? [experimentId, channel, slot, objective, treatment]
    : [experimentId, packId, channel, slot, objective];
  return createHash('sha256')
    .update(cohort.map((value) => String(value || '')).join('|'))
    .digest('hex');
}

/** Keep the meaning of a reused angle ID fixed across copy-pack refreshes. */
export function assertSocialCopyTreatmentContinuity(previousPack, nextPack) {
  if (!previousPack?.editorialPlan || !nextPack?.editorialPlan) return true;
  for (const [channel, slots] of Object.entries(SOCIAL_COPY_CHANNELS)) {
    for (const slot of slots) {
      const objectives = channel === 'instagram'
        ? [...new Set([
          ...instagramObjectivesForKind(slot, previousPack.schemaVersion),
          ...instagramObjectivesForKind(slot, nextPack.schemaVersion),
        ])]
        : [''];
      for (const objective of objectives) {
        const previousTemplates = previousPack.channels?.[channel]?.[slot] || [];
        const nextTemplates = nextPack.channels?.[channel]?.[slot] || [];
        const previousIds = [...new Set(previousTemplates
          .filter((template) => channel !== 'instagram' || template.objective === objective)
          .map((template) => String(template.angleId || '')))].sort();
        const nextIds = [...new Set(nextTemplates
          .filter((template) => channel !== 'instagram' || template.objective === objective)
          .map((template) => String(template.angleId || '')))].sort();
        if (previousIds.length < 2 || previousIds.join('|') !== nextIds.join('|')) continue;
        const previousFingerprint = socialCopyExperimentTreatmentFingerprint(previousPack, { channel, slot, objective });
        const nextFingerprint = socialCopyExperimentTreatmentFingerprint(nextPack, { channel, slot, objective });
        if (!previousFingerprint || previousFingerprint !== nextFingerprint) {
          throw new Error(`editorial angle treatment changed without new angle IDs in ${channel}.${slot}${objective ? `.${objective}` : ''}`);
        }
      }
    }
  }
  return true;
}

/** Build a coarse, source-derived matching stratum without inspecting copy or titles. */
export function buildSocialCopyBlockContext({ sourceClass, scheduledDate } = {}) {
  const contentClass = String(sourceClass || '').trim();
  const date = String(scheduledDate || '').trim();
  if (!SOCIAL_COPY_BLOCK_SOURCE_CLASSES.has(contentClass) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) return null;
  return Object.freeze({ contentClass, weekday: new Date(parsed).getUTCDay() });
}

function normalizeSocialCopyBlockContext(value) {
  if (!isRecord(value)) return null;
  const contentClass = String(value.contentClass || '').trim();
  const weekday = Number(value.weekday);
  if (!SOCIAL_COPY_BLOCK_SOURCE_CLASSES.has(contentClass)
    || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  return { contentClass, weekday };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactText(value, field, { maxLength = 150 } = {}) {
  if (typeof value !== 'string') throw new Error(field + ' must be a string');
  if (/[\r\n\u0000-\u001f]/.test(value)) throw new Error(field + ' must be a single plain-text line');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(field + ' cannot be empty');
  if (text.length > maxLength) throw new Error(field + ' exceeds ' + maxLength + ' characters');
  if (URL_OR_CONTACT_RE.test(text)) throw new Error(field + ' cannot contain a URL, email, or handle');
  if (text.includes('#')) throw new Error(field + ' cannot contain hashtags');
  if (HTML_OR_TEMPLATE_MARKUP_RE.test(text)) throw new Error(field + ' cannot contain markup or placeholders');
  if (NUMERIC_CLAIM_RE.test(text)) throw new Error(field + ' cannot contain numeric claims');
  return text;
}

function validateInstagramObjectiveCta(cta, objective, field) {
  const matchedObjectives = Object.entries(INSTAGRAM_OBJECTIVE_ACTION_RE)
    .filter(([, pattern]) => pattern.test(cta))
    .map(([name]) => name);
  const hasOneConversationQuestion = objective !== 'conversation'
    || ((cta.match(/\?/gu) || []).length === 1 && INSTAGRAM_OPEN_QUESTION_RE.test(cta));
  const hasRequiredPositivePrefix = objective === 'conversation'
    || INSTAGRAM_OBJECTIVE_CTA_PREFIX_RE[objective]?.test(cta) === true;
  const matchesOnlyDeclaredAction = matchedObjectives.length === 1 && matchedObjectives[0] === objective;
  if (!matchesOnlyDeclaredAction || !hasRequiredPositivePrefix || !hasOneConversationQuestion || INSTAGRAM_NEGATED_ACTION_RE.test(cta)) {
    throw new Error(field + ' does not contain an explicit action for the Instagram ' + objective + ' objective');
  }
}

function validateSingleActionCta(cta, field, { ignoreQuestionLead = false } = {}) {
  const actionText = ignoreQuestionLead && cta.includes('?') ? cta.slice(cta.indexOf('?') + 1) : cta;
  const actions = actionText.match(CTA_ACTION_RE) || [];
  if (actions.length !== 1) {
    throw new Error(field + ' must contain exactly one explicit action');
  }
}

function editorialText(value, field, { maxLength = 140 } = {}) {
  if (typeof value !== 'string') throw new Error(field + ' must be a string');
  if (/[\r\n\u0000-\u001f]/.test(value)) throw new Error(field + ' must be a single plain-text line');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(field + ' cannot be empty');
  if (text.length > maxLength) throw new Error(field + ' exceeds ' + maxLength + ' characters');
  if (URL_OR_CONTACT_RE.test(text) || text.includes('#') || HTML_OR_TEMPLATE_MARKUP_RE.test(text)) {
    throw new Error(field + ' cannot contain URLs, contacts, hashtags, or markup');
  }
  if (NUMERIC_CLAIM_RE.test(text)) throw new Error(field + ' cannot contain numeric claims');
  return text;
}

function packEditorialPlan(raw, channelSchema = SOCIAL_COPY_CHANNELS) {
  if (!isRecord(raw?.editorialPlan)) throw new Error('editorialPlan must be an object');
  const planKeys = Object.keys(raw.editorialPlan).sort();
  if (planKeys.join('|') !== 'angles|pillars') throw new Error('editorialPlan must contain exactly pillars and angles');
  const rawPillars = raw.editorialPlan.pillars;
  if (!Array.isArray(rawPillars) || rawPillars.length < 3 || rawPillars.length > 5) {
    throw new Error('editorialPlan.pillars must contain 3..5 pillars');
  }
  const pillarIds = new Set();
  const pillars = rawPillars.map((pillar, index) => {
    if (!isRecord(pillar)) throw new Error('editorialPlan.pillars[' + index + '] must be an object');
    const id = String(pillar.id || '').trim();
    if (!TEMPLATE_ID_RE.test(id) || pillarIds.has(id)) throw new Error('editorial pillar ids must be unique lowercase kebab-case');
    pillarIds.add(id);
    return {
      id,
      name: editorialText(pillar.name, 'editorialPlan.pillars[' + index + '].name', { maxLength: 70 }),
      audienceNeed: editorialText(pillar.audienceNeed, 'editorialPlan.pillars[' + index + '].audienceNeed', { maxLength: 120 }),
    };
  });
  if (new Set(pillars.map((pillar) => pillar.name.toLowerCase())).size !== pillars.length
    || new Set(pillars.map((pillar) => pillar.audienceNeed.toLowerCase())).size !== pillars.length) {
    throw new Error('editorial pillar names and audience needs must be distinct');
  }

  const rawAngles = raw.editorialPlan.angles;
  if (!isRecord(rawAngles)) throw new Error('editorialPlan.angles must be an object');
  if (Object.keys(rawAngles).sort().join('|') !== Object.keys(channelSchema).sort().join('|')) {
    throw new Error('editorialPlan.angles must match the active channel matrix');
  }
  const angles = {};
  for (const [channel, kinds] of Object.entries(channelSchema)) {
    if (!isRecord(rawAngles[channel]) || Object.keys(rawAngles[channel]).sort().join('|') !== [...kinds].sort().join('|')) {
      throw new Error('editorialPlan.angles.' + channel + ' must match the channel formats');
    }
    angles[channel] = {};
    for (const kind of kinds) {
      const source = rawAngles[channel][kind];
      if (!Array.isArray(source) || source.length !== EDITORIAL_ANGLE_COUNT_PER_SLOT) {
        throw new Error('editorialPlan.angles.' + channel + '.' + kind + ' must contain exactly 3 angles');
      }
      const ids = new Set();
      angles[channel][kind] = source.map((angle, index) => {
        const field = 'editorialPlan.angles.' + channel + '.' + kind + '[' + index + ']';
        if (!isRecord(angle)) throw new Error(field + ' must be an object');
        const id = String(angle.id || '').trim();
        const pillarId = String(angle.pillarId || '').trim();
        if (!TEMPLATE_ID_RE.test(id) || ids.has(id)) throw new Error(field + '.id must be unique lowercase kebab-case');
        if (!pillarIds.has(pillarId)) throw new Error(field + '.pillarId must reference a declared pillar');
        const intent = String(angle.intent || '').trim();
        const evidenceBasis = String(angle.evidenceBasis || '').trim();
        if (!SOCIAL_COPY_EDITORIAL_INTENTS.includes(intent)) throw new Error(field + '.intent must be searchable, shareable, or both');
        if (!SOCIAL_COPY_EDITORIAL_EVIDENCE.includes(evidenceBasis)) throw new Error(field + '.evidenceBasis is unsupported');
        ids.add(id);
        return {
          id,
          pillarId,
          audienceNeed: editorialText(angle.audienceNeed, field + '.audienceNeed', { maxLength: 120 }),
          angle: editorialText(angle.angle, field + '.angle', { maxLength: 140 }),
          intent,
          evidenceBasis,
        };
      });
      if (new Set(angles[channel][kind].map((angle) => angle.angle.toLowerCase())).size !== EDITORIAL_ANGLE_COUNT_PER_SLOT
        || new Set(angles[channel][kind].map((angle) => angle.audienceNeed.toLowerCase())).size !== EDITORIAL_ANGLE_COUNT_PER_SLOT) {
        throw new Error('editorial angles and audience needs must be distinct for ' + channel + '.' + kind);
      }
    }
  }
  return { pillars, angles };
}

function packChannels(raw, channelSchema = SOCIAL_COPY_CHANNELS, {
  editorialPlan = null,
  requireEditorialAngles = false,
  schemaVersion = SOCIAL_COPY_PACK_SCHEMA_VERSION,
} = {}) {
  if (!isRecord(raw?.channels)) throw new Error('channels must be an object');
  const channelNames = Object.keys(channelSchema);
  const actualChannels = Object.keys(raw.channels).sort();
  if (actualChannels.join('|') !== channelNames.slice().sort().join('|')) {
    throw new Error('channels must contain exactly: ' + channelNames.join(', '));
  }

  const channels = {};
  for (const channel of channelNames) {
    const sourceKinds = raw.channels[channel];
    if (!isRecord(sourceKinds)) throw new Error(channel + ' must be an object');
    const requiredKinds = channelSchema[channel];
    const actualKinds = Object.keys(sourceKinds).sort();
    if (actualKinds.join('|') !== requiredKinds.slice().sort().join('|')) {
      throw new Error(channel + ' must contain exactly: ' + requiredKinds.join(', '));
    }
    channels[channel] = {};
    for (const kind of requiredKinds) {
      const templates = sourceKinds[kind];
      const templateCount = socialCopyTemplateCount(channel, kind, schemaVersion);
      if (!Array.isArray(templates) || templates.length !== templateCount) {
        throw new Error(channel + '.' + kind + ' must contain exactly ' + templateCount + ' templates');
      }
      const ids = new Set();
      channels[channel][kind] = templates.map((template, index) => {
        if (!isRecord(template)) throw new Error(channel + '.' + kind + '[' + index + '] must be an object');
        const id = String(template.id || '').trim();
        if (!TEMPLATE_ID_RE.test(id) || ids.has(id)) {
          throw new Error(channel + '.' + kind + '[' + index + '].id must be unique lowercase kebab-case');
        }
        ids.add(id);
        const objective = channel === 'instagram' ? String(template.objective || '').trim() : null;
        const allowedObjectives = instagramObjectivesForKind(kind, schemaVersion);
        if (channel === 'instagram' && !allowedObjectives.includes(objective)) {
          throw new Error(channel + '.' + kind + '[' + index + '].objective must be ' + allowedObjectives.join(' or '));
        }
        const angleId = requireEditorialAngles ? String(template.angleId || '').trim() : '';
        if (requireEditorialAngles) {
          const declaredAngles = editorialPlan?.angles?.[channel]?.[kind] || [];
          if (!TEMPLATE_ID_RE.test(angleId) || !declaredAngles.some((angle) => angle.id === angleId)) {
            throw new Error(channel + '.' + kind + '[' + index + '].angleId must reference an editorial angle in this slot');
          }
        }
        const cta = compactText(template.cta, channel + '.' + kind + '[' + index + '].cta', {
          maxLength: channel === 'instagram' || channel === 'tiktok' ? 80 : 150,
        });
        if (channel === 'instagram') {
          validateInstagramObjectiveCta(cta, objective, channel + '.' + kind + '[' + index + '].cta');
        }
        validateSingleActionCta(cta, channel + '.' + kind + '[' + index + '].cta', {
          ignoreQuestionLead: channel === 'instagram' && objective === 'conversation',
        });
        return {
          id,
          ...(objective ? { objective } : {}),
          ...(requireEditorialAngles ? { angleId } : {}),
          hook: compactText(template.hook, channel + '.' + kind + '[' + index + '].hook', {
            maxLength: channel === 'instagram' || channel === 'tiktok' ? 90 : 150,
          }),
          cta,
        };
      });
      if (new Set(channels[channel][kind].map((item) => item.hook.toLowerCase())).size !== templateCount) {
        throw new Error(channel + '.' + kind + ' hooks must be distinct');
      }
      if (new Set(channels[channel][kind].map((item) => item.cta.toLowerCase())).size !== templateCount) {
        throw new Error(channel + '.' + kind + ' CTAs must be distinct');
      }
      if (channel === 'instagram') {
        const objectives = instagramObjectivesForKind(kind, schemaVersion);
        const objectiveCounts = Object.fromEntries(objectives.map((objective) => [
          objective,
          channels[channel][kind].filter((item) => item.objective === objective).length,
        ]));
        if (Object.values(objectiveCounts).some((count) => count !== MAX_TEMPLATES_PER_INSTAGRAM_OBJECTIVE)) {
          throw new Error(channel + '.' + kind + ' must have exactly 3 templates for each objective');
        }
      }
      if (requireEditorialAngles) {
        const declaredAngles = editorialPlan.angles[channel][kind];
        const expectedPerAngle = templateCount / declaredAngles.length;
        if (!Number.isInteger(expectedPerAngle)) throw new Error(channel + '.' + kind + ' cannot be evenly assigned across editorial angles');
        const angleCounts = Object.fromEntries(declaredAngles.map((angle) => [angle.id, 0]));
        for (const template of channels[channel][kind]) angleCounts[template.angleId] += 1;
        if (Object.values(angleCounts).some((count) => count !== expectedPerAngle)) {
          throw new Error(channel + '.' + kind + ' templates must be evenly distributed across editorial angles');
        }
        if (channel === 'instagram') {
          for (const objective of instagramObjectivesForKind(kind, schemaVersion)) {
            const objectiveTemplates = channels[channel][kind].filter((template) => template.objective === objective);
            if (objectiveTemplates.length !== declaredAngles.length
              || new Set(objectiveTemplates.map((template) => template.angleId)).size !== declaredAngles.length) {
              throw new Error(channel + '.' + kind + ' must cover every editorial angle once per objective');
            }
          }
        }
      }
    }
  }
  return channels;
}

function normalizePack(raw, {
  generatedAt = new Date(),
  schemaVersion = SOCIAL_COPY_PACK_SCHEMA_VERSION,
  promptVersion = SOCIAL_COPY_PROMPT_VERSION,
  channelSchema = SOCIAL_COPY_CHANNELS,
} = {}) {
  const requireEditorialAngles = Number(schemaVersion) >= PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION;
  const editorialPlan = requireEditorialAngles ? packEditorialPlan(raw, channelSchema) : null;
  const channels = packChannels(raw, channelSchema, { editorialPlan, requireEditorialAngles, schemaVersion });
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) throw new Error('generatedAt must be a valid timestamp');
  const canonical = JSON.stringify(requireEditorialAngles ? { editorialPlan, channels } : channels);
  const packId = createHash('sha256')
    .update(promptVersion + '\n' + canonical)
    .digest('hex')
    .slice(0, 16);
  const validUntil = new Date(generated.getTime() + SOCIAL_COPY_PACK_MAX_AGE_DAYS * 86400000);
  return {
    schemaVersion,
    promptVersion,
    packId,
    generatedAt: generated.toISOString(),
    validUntil: validUntil.toISOString(),
    ...(editorialPlan ? { editorialPlan } : {}),
    channels,
  };
}

export function normalizeSocialCopyPack(raw, { generatedAt = new Date() } = {}) {
  return normalizePack(raw, { generatedAt });
}

export function validatePersistedSocialCopyPack(pack, { now = new Date() } = {}) {
  if (!isRecord(pack)) {
    throw new Error('unsupported schemaVersion');
  }
  const legacyPack = Number(pack.schemaVersion) === LEGACY_SOCIAL_COPY_PACK_SCHEMA_VERSION
    && pack.promptVersion === LEGACY_SOCIAL_COPY_PROMPT_VERSION
    && isRecord(pack.channels)
    && !Object.hasOwn(pack.channels, 'reddit');
  const previousPack = Number(pack.schemaVersion) === PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION
    && pack.promptVersion === PREVIOUS_SOCIAL_COPY_PROMPT_VERSION;
  const secondPreviousPack = Number(pack.schemaVersion) === SECOND_PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION
    && pack.promptVersion === SECOND_PREVIOUS_SOCIAL_COPY_PROMPT_VERSION;
  const currentPack = Number(pack.schemaVersion) === SOCIAL_COPY_PACK_SCHEMA_VERSION
    && pack.promptVersion === SOCIAL_COPY_PROMPT_VERSION;
  if (!legacyPack && !secondPreviousPack && !previousPack && !currentPack) throw new Error('unsupported social-copy schema or prompt version');
  const version = legacyPack ? LEGACY_SOCIAL_COPY_PACK_SCHEMA_VERSION
    : secondPreviousPack ? SECOND_PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION
      : previousPack ? PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION : SOCIAL_COPY_PACK_SCHEMA_VERSION;
  const promptVersion = legacyPack ? LEGACY_SOCIAL_COPY_PROMPT_VERSION
    : secondPreviousPack ? SECOND_PREVIOUS_SOCIAL_COPY_PROMPT_VERSION
      : previousPack ? PREVIOUS_SOCIAL_COPY_PROMPT_VERSION : SOCIAL_COPY_PROMPT_VERSION;
  const normalized = normalizePack(
    {
      channels: pack.channels,
      ...(version >= PREVIOUS_SOCIAL_COPY_PACK_SCHEMA_VERSION ? { editorialPlan: pack.editorialPlan } : {}),
    },
    {
      generatedAt: pack.generatedAt,
      schemaVersion: version,
      promptVersion,
      channelSchema: legacyPack ? LEGACY_SOCIAL_COPY_CHANNELS : SOCIAL_COPY_CHANNELS,
    },
  );
  if (pack.packId !== normalized.packId || pack.validUntil !== normalized.validUntil) {
    throw new Error('pack metadata does not match the validated copy');
  }
  const current = now instanceof Date ? now : new Date(now);
  const generated = Date.parse(normalized.generatedAt);
  const expires = Date.parse(normalized.validUntil);
  if (!Number.isFinite(current.getTime()) || generated > current.getTime() + 5 * 60 * 1000) {
    throw new Error('pack is dated in the future');
  }
  if (current.getTime() > expires) throw new Error('pack is stale');
  return normalized;
}

export function loadSocialCopyPack({
  filePath = process.env.SOCIAL_COPY_PACK_PATH || DEFAULT_SOCIAL_COPY_PACK_PATH,
  now = new Date(),
  onWarning = () => {},
} = {}) {
  try {
    if (!existsSync(filePath)) return null;
    return validatePersistedSocialCopyPack(JSON.parse(readFileSync(filePath, 'utf8')), { now });
  } catch (error) {
    onWarning('social copy pack unavailable; using deterministic copy (' + error.message + ')');
    return null;
  }
}

function stableIndex(value, count) {
  const digest = createHash('sha256').update(String(value)).digest();
  return digest.readUInt32BE(0) % count;
}

export function selectSocialCopy({
  pack,
  channel,
  kind,
  format,
  assignmentKey,
  expectedObjective,
} = {}) {
  if (!pack || !SOCIAL_COPY_CHANNELS[channel]) return null;
  const slot = format || kind;
  if (!SOCIAL_COPY_CHANNELS[channel].includes(slot)) return null;
  const templates = pack.channels?.[channel]?.[slot];
  if (!Array.isArray(templates) || templates.length !== socialCopyTemplateCount(channel, slot, pack.schemaVersion)) return null;
  const key = String(assignmentKey || '').trim();
  if (!key) return null;
  const candidateTemplates = channel === 'instagram'
    ? templates.filter((template) => template.objective === expectedObjective)
    : templates;
  if (channel === 'instagram' && candidateTemplates.length !== MAX_TEMPLATES_PER_INSTAGRAM_OBJECTIVE) return null;
  const template = candidateTemplates[stableIndex(channel + ':' + slot + ':' + (expectedObjective || '') + ':' + key, candidateTemplates.length)];
  const angle = pack.editorialPlan?.angles?.[channel]?.[slot]
    ?.find((item) => item.id === template.angleId);
  return {
    ...template,
    copyMode: 'codex',
    copySlot: slot,
    copyPromptVersion: pack.promptVersion,
    copyPackId: pack.packId,
    copyAssignmentMode: 'deterministic',
    ...(angle ? {
      copyAngleId: angle.id,
      copyPillarId: angle.pillarId,
      copyAngleIntent: angle.intent,
    } : {}),
  };
}

function parseSocialCopyExperimentConfig(value) {
  let config = value;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch {
      return null;
    }
  }
  if (!isRecord(config) || Number(config.schemaVersion) !== 4
    || config.enabled !== true
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(config.experimentId || ''))) return null;
  if (config.protocolVersion !== SOCIAL_COPY_EXPERIMENT_PROTOCOL_VERSION
    || !isRecord(config.registrations) || !isRecord(config.registrationDeadlines)
    || !isRecord(config.winners)) return null;
  const registrationIds = Object.keys(config.registrations);
  if (!registrationIds.length
    || Object.keys(config.registrationDeadlines).length !== registrationIds.length
    || registrationIds.some((id) => !/^[a-f0-9]{64}$/u.test(id)
      || !/^[a-f0-9]{64}$/u.test(String(config.registrations[id] || ''))
      || !Number.isFinite(Date.parse(String(config.registrationDeadlines[id] || ''))))) return null;
  return {
    experimentId: String(config.experimentId),
    registrations: config.registrations,
    registrationDeadlines: config.registrationDeadlines,
    winners: config.winners,
  };
}

/**
 * Select a stable copy variant, balanced across concurrent social publishers
 * when the Firebase Remote Config experiment is enabled.
 */
export async function selectSocialCopyForPublish(options = {}) {
  const selected = selectSocialCopy(options);
  if (!selected) return null;
  // A preview must never create Firestore assignments or change the future
  // balance of arms. It intentionally shows the deterministic preview arm.
  if (options.dryRun === true) return selected;
  const config = parseSocialCopyExperimentConfig(
    options.experimentConfig ?? process.env.SOCIAL_COPY_EXPERIMENT_CONFIG,
  );
  if (!config) return selected;
  if (options.allowExperimentExposure === false) return selected;

  const slot = options.format || options.kind;
  const objective = options.channel === 'instagram'
    ? String(options.expectedObjective || '')
    : options.channel === 'linkedin' ? 'overall' : '';
  const blockContext = normalizeSocialCopyBlockContext(options.blockContext);
  const candidates = options.pack.channels[options.channel][slot]
    .filter((template) => options.channel !== 'instagram' || template.objective === objective);
  const treatmentFingerprint = socialCopyExperimentTreatmentFingerprint(options.pack, {
    channel: options.channel,
    slot,
    objective,
  });
  const registrationId = socialCopyExperimentRegistrationId({
    experimentId: config.experimentId,
    packId: options.pack.packId,
    treatmentFingerprint,
    channel: options.channel,
    slot,
    objective,
  });
  const registrationHash = String(config.registrations?.[registrationId] || '').trim();
  if (!/^[a-f0-9]{64}$/.test(registrationHash)) return { ...selected, copyExperimentId: config.experimentId };
  const winner = config.winners?.[registrationId];
  if (isRecord(winner) && winner.registrationHash === registrationHash
    && TEMPLATE_ID_RE.test(String(winner.angleId || ''))) {
    const template = candidates.find((candidate) => candidate.angleId === winner.angleId);
    if (!template) {
      options.onWarning?.('Social copy winner map references an unknown template; using deterministic assignment');
      return { ...selected, copyExperimentId: config.experimentId };
    }
    const winnerAngle = options.pack.editorialPlan?.angles?.[options.channel]?.[slot]
      ?.find((item) => item.id === template.angleId);
    return {
      ...template,
      copyMode: 'codex',
      copySlot: slot,
      copyPromptVersion: options.pack.promptVersion,
      copyPackId: options.pack.packId,
      copyAssignmentMode: 'firebase-winner',
      copyExperimentId: config.experimentId,
      ...(winnerAngle ? {
        copyAngleId: winnerAngle.id,
        copyPillarId: winnerAngle.pillarId,
        copyAngleIntent: winnerAngle.intent,
      } : {}),
    };
  }
  const deadlineAt = Date.parse(String(config.registrationDeadlines?.[registrationId] || ''));
  const asOf = options.asOf instanceof Date
    ? options.asOf.getTime()
    : Number.isFinite(Date.parse(String(options.asOf || '')))
      ? Date.parse(String(options.asOf))
      : Date.now();
  if (!blockContext || !Number.isFinite(deadlineAt) || asOf > deadlineAt) {
    return { ...selected, copyExperimentId: config.experimentId };
  }
  const attemptId = randomUUID();
  try {
    const assign = options.assignBalancedImpl
      || (await import('./firebase-social-copy-assignment.mjs')).assignBalancedSocialCopy;
    const result = await assign({
      experimentId: config.experimentId,
      packId: options.pack.packId,
      channel: options.channel,
      slot,
      objective,
      assignmentKey: options.assignmentKey,
      attemptId,
      blockContext,
      registrationHash,
      templateIds: candidates.map((template) => template.id),
      armIds: candidates.map((template) => template.angleId),
    });
    const template = candidates.find((candidate) => candidate.angleId === (result?.armId || result?.templateId));
    if (!template) throw new Error('Firebase returned an unknown copy template');
    const assignedAngle = options.pack.editorialPlan?.angles?.[options.channel]?.[slot]
      ?.find((item) => item.id === template.angleId);
    return {
      ...template,
      copyMode: 'codex',
      copySlot: slot,
      copyPromptVersion: options.pack.promptVersion,
      copyPackId: options.pack.packId,
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: config.experimentId,
      copyRegistrationHash: registrationHash,
      ...(result?.blockId ? { copyBlockId: result.blockId } : {}),
      ...(Number.isSafeInteger(result?.blockCycle) ? { copyBlockCycle: result.blockCycle } : {}),
      ...(assignedAngle ? {
        copyAngleId: assignedAngle.id,
        copyPillarId: assignedAngle.pillarId,
        copyAngleIntent: assignedAngle.intent,
      } : {}),
      copyAssignment: {
        experimentId: config.experimentId,
        packId: options.pack.packId,
        channel: options.channel,
        slot,
        objective,
        assignmentKey: options.assignmentKey,
        attemptId: result?.attemptId || attemptId,
        registrationHash,
        ...(blockContext ? { blockContext } : {}),
        ...(result?.blockId ? { blockId: result.blockId } : {}),
        ...(Number.isSafeInteger(result?.blockCycle) ? { blockCycle: result.blockCycle } : {}),
      },
    };
  } catch {
    options.onWarning?.('Firebase social copy balancing unavailable; keeping stable deterministic assignment');
    return {
      ...selected,
      copyAssignmentMode: 'deterministic-fallback',
      copyExperimentId: config.experimentId,
    };
  }
}

export async function releaseSocialCopyAssignment(copy, { releaseBalancedImpl } = {}) {
  if (copy?.copyAssignmentMode !== 'firebase-balanced' || !isRecord(copy.copyAssignment)) return false;
  const release = releaseBalancedImpl
    || (await import('./firebase-social-copy-assignment.mjs')).releaseBalancedSocialCopyAssignment;
  return release(copy.copyAssignment);
}

/** Mark only an accepted, exact-ID native publication as a delivered exposure. */
export async function markSocialCopyAssignmentPublished(copy, {
  postId,
  publishedAt = new Date(),
  markPublishedImpl,
} = {}) {
  if (copy?.copyAssignmentMode !== 'firebase-balanced' || !isRecord(copy.copyAssignment)) return true;
  const markPublished = markPublishedImpl
    || (await import('./firebase-social-copy-assignment.mjs')).markBalancedSocialCopyAssignmentPublished;
  return markPublished({ ...copy.copyAssignment, postId, publishedAt });
}

/** Release one Firebase-balanced reservation after a certain pre-delivery skip. */
export async function releaseUnpublishedSocialCopyAssignment(copy, {
  releaseBalancedImpl,
  reason = 'delivery was skipped before acceptance',
} = {}) {
  if (copy?.copyAssignmentMode !== 'firebase-balanced' || !isRecord(copy.copyAssignment)) return false;
  const released = await releaseSocialCopyAssignment(copy, { releaseBalancedImpl });
  if (!released) throw new Error('Social copy assignment could not be released: ' + reason);
  return true;
}

/**
 * Best-effort release for publishers that process multiple independent posts.
 * A failed release is reported to the caller but does not abort the remaining
 * posts; callers must provide an error handler so a stranded reservation stays
 * observable. Use `releaseUnpublishedSocialCopyAssignment` when failure should
 * still reject the current operation.
 */
export async function releaseUnpublishedSocialCopyAssignmentBestEffort(copy, {
  releaseBalancedImpl,
  reason = 'delivery was skipped before acceptance',
  onFailure,
} = {}) {
  if (copy?.copyAssignmentMode !== 'firebase-balanced' || !isRecord(copy.copyAssignment)) return true;
  if (typeof onFailure !== 'function') throw new Error('onFailure is required for best-effort social copy release');
  try {
    await releaseUnpublishedSocialCopyAssignment(copy, { releaseBalancedImpl, reason });
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
}

export function socialCopyLedgerFields(copy, {
  fallbackHook = '',
  fallbackCta = '',
} = {}) {
  if (copy?.copyMode === 'codex') {
    return {
      copyMode: 'codex',
      copySlot: copy.copySlot,
      copyPromptVersion: copy.copyPromptVersion,
      copyPackId: copy.copyPackId,
      copyTemplateId: copy.id,
      copyAssignmentMode: copy.copyAssignmentMode || 'deterministic',
      ...(copy.copyExperimentId ? { copyExperimentId: copy.copyExperimentId } : {}),
      ...(copy.copyRegistrationHash ? { copyRegistrationHash: copy.copyRegistrationHash } : {}),
      ...(copy.copyBlockId ? { copyBlockId: copy.copyBlockId } : {}),
      ...(Number.isSafeInteger(copy.copyBlockCycle) ? { copyBlockCycle: copy.copyBlockCycle } : {}),
      ...(copy.objective ? { copyObjective: copy.objective } : {}),
      ...(copy.copyAngleId ? { copyAngleId: copy.copyAngleId } : {}),
      ...(copy.copyPillarId ? { copyPillarId: copy.copyPillarId } : {}),
      ...(copy.copyAngleIntent ? { copyAngleIntent: copy.copyAngleIntent } : {}),
      copyHook: copy.hook,
      copyCta: copy.cta,
    };
  }
  return {
    copyMode: 'deterministic',
    copyPromptVersion: 'deterministic-v1',
    copyPackId: 'deterministic',
    copyTemplateId: 'baseline',
    copyAssignmentMode: 'deterministic',
    copyHook: String(fallbackHook || ''),
    copyCta: String(fallbackCta || ''),
  };
}

/**
 * Add a stable copy-variant discriminator to an existing social utm_content.
 * The base content remains intact for existing campaign/creative reports;
 * deterministic legacy copy keeps its established value.
 */
export function socialCopyTrackingContent(content, copy) {
  const base = String(content || '').trim();
  const balancedAssignment = ['firebase-balanced', 'firebase-winner'].includes(copy?.copyAssignmentMode);
  if (!base || (copy?.copyMode !== 'codex' && !balancedAssignment)) return base;
  const packId = String(copy.copyPackId || '').trim();
  const copySlot = String(copy.copySlot || '').trim();
  const templateId = String(copy.id || copy.copyTemplateId || '').trim();
  const angleId = String(copy.copyAngleId || '').trim();
  if (!/^[a-f0-9]{16}$/.test(packId) || !TEMPLATE_ID_RE.test(copySlot) || !TEMPLATE_ID_RE.test(templateId)) return base;
  const assignmentCode = {
    'firebase-balanced': 'b',
    'firebase-winner': 'w',
    deterministic: 'd',
    'deterministic-fallback': 'f',
  }[String(copy.copyAssignmentMode || 'deterministic')];
  if (!assignmentCode) return base;
  const experimentId = String(copy.copyExperimentId || '').trim();
  if (experimentId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(experimentId)) return base;
  const experimentHash = experimentId
    ? createHash('sha256').update(experimentId).digest('hex').slice(0, 8)
    : '';
  return `${base}--cp${packId}-${copySlot}.${templateId}${TEMPLATE_ID_RE.test(angleId) ? '.a' + angleId : ''}.${assignmentCode}${experimentHash ? '.' + experimentHash : ''}`;
}
