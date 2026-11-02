import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOCIAL_COPY_PACK_SCHEMA_VERSION = 2;
export const SOCIAL_COPY_PROMPT_VERSION = 'frontaliere-social-copy-v2';
export const SOCIAL_COPY_PACK_MAX_AGE_DAYS = 45;
const LEGACY_SOCIAL_COPY_PACK_SCHEMA_VERSION = 1;
const LEGACY_SOCIAL_COPY_PROMPT_VERSION = 'frontaliere-social-copy-v1';

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
export const SOCIAL_COPY_INSTAGRAM_OBJECTIVES = Object.freeze(['share', 'save', 'conversation']);
const TEMPLATE_COUNT_OVERRIDES = Object.freeze({
  instagram: Object.freeze({ article: 9, job: 9, border: 9, reel: 9 }),
  facebook: Object.freeze({ job: 12 }),
});
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const URL_OR_CONTACT_RE = /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|@[\w.]+)/i;
const HTML_OR_TEMPLATE_MARKUP_RE = /[<>{}]/;
const NUMERIC_CLAIM_RE = /\d|\b(?:percento|percentuali|chf|eur|euro|franchi|ore|minuti|giorni|settimane|anni)\b/i;
// Recognize imperative actions only; verb stems would also accept descriptive
// forms such as "condividendo" or future-tense claims such as "salveremo".
const INSTAGRAM_OBJECTIVE_ACTION_RE = Object.freeze({
  share: /\bcondividi(?:lo|la|li|le|ne)?\b/iu,
  save: /\b(?:salva|conserva)(?:lo|la|li|le|ne)?\b|\bmetti\s+da\s+parte\b|\baggiungi\s+ai\s+preferiti\b/iu,
  conversation: /\?\s*(?:commenta|scrivi(?:lo|la|li|le|ne|ci)?|racconta(?:lo|la|li|le|ne|ci|celo|cela)?|dicci|rispondi(?:ci)?|lascia\s+un)[^?]*\bcomment(?:i|o)\b/iu,
});
const INSTAGRAM_OBJECTIVE_CTA_PREFIX_RE = Object.freeze({
  share: /^\s*condividi(?:lo|la|li|le|ne)?\b/iu,
  save: /^\s*(?:salva|conserva)(?:lo|la|li|le|ne)?\b|^\s*metti\s+da\s+parte\b|^\s*aggiungi\s+ai\s+preferiti\b/iu,
});
const INSTAGRAM_NEGATED_ACTION_RE = /\bnon\s+(?:condivid\p{L}*|salv\p{L}*|conserv\p{L}*|metti\s+da\s+parte|aggiungi\s+ai\s+preferiti|comment\p{L}*|scriv\p{L}*|raccont\p{L}*|dicc\p{L}*|rispond\p{L}*|lascia\s+un\s+commento)\b/iu;
const INSTAGRAM_OPEN_QUESTION_RE = /^\s*(?:che\s+cosa|cosa|quale|quali|qual|come|dove|quando|chi|quanto|quanta|quanti|quante|perch[eé]|in\s+che\s+modo)\b[^?]*\?/iu;
const CTA_ACTION_RE = /\b(?:condividi(?:lo|la|li|le|ne)?|salva(?:lo|la|li|le|ne)?|conserva(?:lo|la|li|le|ne)?|metti\s+da\s+parte|aggiungi\s+ai\s+preferiti|commenta|scrivi(?:lo|la|li|le|ne|ci)?|racconta(?:lo|la|li|le|ne|ci|celo|cela)?|dicci|rispondi(?:ci)?|lascia\s+un\s+commento|leggi|approfondisci|apri|consulta|visita|vai|clicca|scopri|guarda|ascolta|candidati|invia(?:lo|la|li|le|ci)?|manda|compila|segui|iscriviti|partecipa|verifica|controlla|esplora|trova|prenota|tagga(?:mi|lo|la|li|le|ci)?|menziona(?:mi|lo|la|li|le|ci)?|invita(?:mi|lo|la|li|le|ci)?|inoltra(?:mi|lo|la|li|le|ci)?)\b/giu;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_SOCIAL_COPY_PACK_PATH = path.join(ROOT, 'data', 'social-copy-packs', 'current.json');

export function socialCopyTemplateCount(channel, kind) {
  return TEMPLATE_COUNT_OVERRIDES[channel]?.[kind] || MAX_TEMPLATES_PER_KIND;
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

function packChannels(raw, channelSchema = SOCIAL_COPY_CHANNELS) {
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
      const templateCount = socialCopyTemplateCount(channel, kind);
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
        if (channel === 'instagram' && !SOCIAL_COPY_INSTAGRAM_OBJECTIVES.includes(objective)) {
          throw new Error(channel + '.' + kind + '[' + index + '].objective must be share, save, or conversation');
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
        const objectiveCounts = Object.fromEntries(SOCIAL_COPY_INSTAGRAM_OBJECTIVES.map((objective) => [
          objective,
          channels[channel][kind].filter((item) => item.objective === objective).length,
        ]));
        if (Object.values(objectiveCounts).some((count) => count !== MAX_TEMPLATES_PER_INSTAGRAM_OBJECTIVE)) {
          throw new Error(channel + '.' + kind + ' must have exactly 3 templates for each objective');
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
  const channels = packChannels(raw, channelSchema);
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) throw new Error('generatedAt must be a valid timestamp');
  const canonical = JSON.stringify(channels);
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
  const currentPack = Number(pack.schemaVersion) === SOCIAL_COPY_PACK_SCHEMA_VERSION
    && pack.promptVersion === SOCIAL_COPY_PROMPT_VERSION;
  if (!legacyPack && !currentPack) throw new Error('unsupported social-copy schema or prompt version');
  const normalized = normalizePack(
    { channels: pack.channels },
    {
      generatedAt: pack.generatedAt,
      schemaVersion: legacyPack ? LEGACY_SOCIAL_COPY_PACK_SCHEMA_VERSION : SOCIAL_COPY_PACK_SCHEMA_VERSION,
      promptVersion: legacyPack ? LEGACY_SOCIAL_COPY_PROMPT_VERSION : SOCIAL_COPY_PROMPT_VERSION,
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
  if (!Array.isArray(templates) || templates.length !== socialCopyTemplateCount(channel, slot)) return null;
  const key = String(assignmentKey || '').trim();
  if (!key) return null;
  const candidateTemplates = channel === 'instagram'
    ? templates.filter((template) => template.objective === expectedObjective)
    : templates;
  if (channel === 'instagram' && candidateTemplates.length !== MAX_TEMPLATES_PER_INSTAGRAM_OBJECTIVE) return null;
  const template = candidateTemplates[stableIndex(channel + ':' + slot + ':' + (expectedObjective || '') + ':' + key, candidateTemplates.length)];
  return {
    ...template,
    copyMode: 'codex',
    copySlot: slot,
    copyPromptVersion: pack.promptVersion,
    copyPackId: pack.packId,
    copyAssignmentMode: 'deterministic',
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
  if (
    !isRecord(config)
    || Number(config.schemaVersion) !== 1
    || config.enabled !== true
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(config.experimentId || ''))
  ) return null;
  return { experimentId: String(config.experimentId) };
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

  const slot = options.format || options.kind;
  const objective = options.channel === 'instagram' ? String(options.expectedObjective || '') : '';
  const candidates = options.pack.channels[options.channel][slot]
    .filter((template) => options.channel !== 'instagram' || template.objective === objective);
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
      templateIds: candidates.map((template) => template.id),
    });
    const template = candidates.find((candidate) => candidate.id === result?.templateId);
    if (!template) throw new Error('Firebase returned an unknown copy template');
    return {
      ...template,
      copyMode: 'codex',
      copySlot: slot,
      copyPromptVersion: options.pack.promptVersion,
      copyPackId: options.pack.packId,
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: config.experimentId,
      copyAssignment: {
        experimentId: config.experimentId,
        packId: options.pack.packId,
        channel: options.channel,
        slot,
        objective,
        assignmentKey: options.assignmentKey,
        attemptId: result?.attemptId || attemptId,
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
      ...(copy.objective ? { copyObjective: copy.objective } : {}),
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
  const balancedAssignment = copy?.copyAssignmentMode === 'firebase-balanced';
  if (!base || (copy?.copyMode !== 'codex' && !balancedAssignment)) return base;
  const packId = String(copy.copyPackId || '').trim();
  const copySlot = String(copy.copySlot || '').trim();
  const templateId = String(copy.id || copy.copyTemplateId || '').trim();
  if (!/^[a-f0-9]{16}$/.test(packId) || !TEMPLATE_ID_RE.test(copySlot) || !TEMPLATE_ID_RE.test(templateId)) return base;
  const assignmentCode = {
    'firebase-balanced': 'b',
    deterministic: 'd',
    'deterministic-fallback': 'f',
  }[String(copy.copyAssignmentMode || 'deterministic')];
  if (!assignmentCode) return base;
  const experimentId = String(copy.copyExperimentId || '').trim();
  if (experimentId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(experimentId)) return base;
  const experimentHash = experimentId
    ? createHash('sha256').update(experimentId).digest('hex').slice(0, 8)
    : '';
  return `${base}--cp${packId}-${copySlot}.${templateId}.${assignmentCode}${experimentHash ? '.' + experimentHash : ''}`;
}
