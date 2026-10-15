/**
 * Short-form creative treatments for the controlled Instagram Reel test.
 *
 * Reels use one ranked item instead of a five-item carousel. The source stays
 * the same GA4-ranked content, while the first two seconds, the promise and
 * the requested action change. Keeping the treatment metadata next to the
 * generated caption makes a Reel comparable to the carousel ledger without
 * pretending the two formats are one experiment.
 */

import { instagramEngagementMechanic } from './instagram-engagement.mjs';

export const INSTAGRAM_REEL_VARIANTS = Object.freeze([
  Object.freeze({
    id: 'reel-question',
    label: 'Domanda immediata',
    objective: 'conversation',
    primaryMetric: 'comments',
    hookType: 'question',
    attentionMechanic: 'specific-keyword',
    engagementLoop: 'keyword-comment-reply',
    followUpFormat: 'comment-reply-reel',
    hook: Object.freeze({
      job: Object.freeze({ kicker: 'UNA DOMANDA', title: 'Stai cercando lavoro in Svizzera?' }),
      article: Object.freeze({ kicker: 'UNA DOMANDA', title: 'Questa regola ti crea dubbi?' }),
    }),
    lead: Object.freeze({
      job: 'In 10 secondi partiamo da un dato reale e arriviamo alla prossima domanda utile.',
      article: 'In 10 secondi partiamo da un dato reale e arriviamo alla domanda che conta.',
    }),
    cta: Object.freeze({
      job: 'Scrivi “LAVORO” e indica il settore che stai cercando.',
      article: 'Scrivi “GUIDA” e indica il tema che vuoi vedere spiegato.',
    }),
  }),
  Object.freeze({
    id: 'reel-number',
    label: 'Numero in primo piano',
    objective: 'share',
    primaryMetric: 'shares',
    hookType: 'single-number',
    attentionMechanic: 'single-number-proof',
    engagementLoop: 'share-to-help',
    followUpFormat: 'story-result',
    hook: Object.freeze({
      job: Object.freeze({ kicker: 'DATO DI IERI', title: 'Un ruolo ha attirato più attenzione degli altri' }),
      article: Object.freeze({ kicker: 'DATO DI IERI', title: 'Un tema ha attirato più letture degli altri' }),
    }),
    lead: Object.freeze({
      job: 'Non è una previsione: è il comportamento reale di chi ha consultato il sito.',
      article: 'Non è una sensazione: è il comportamento reale di chi ha consultato il sito.',
    }),
    cta: Object.freeze({
      job: 'Mandalo a chi sta valutando il prossimo passo professionale.',
      article: 'Mandalo a chi vuole restare aggiornato tra Italia e Svizzera.',
    }),
  }),
  Object.freeze({
    id: 'reel-save',
    label: 'Promemoria pratico',
    objective: 'save',
    primaryMetric: 'saves',
    hookType: 'problem-solution',
    attentionMechanic: 'one-problem-one-reference',
    engagementLoop: 'save-then-return',
    followUpFormat: 'carousel-checklist',
    hook: Object.freeze({
      job: Object.freeze({ kicker: 'TI SERVIRÀ', title: 'Prima di candidarti, guarda questo' }),
      article: Object.freeze({ kicker: 'TI SERVIRÀ', title: 'Prima di decidere, guarda questo' }),
    }),
    lead: Object.freeze({
      job: 'Un solo riferimento da tenere a portata di mano quando riapri la ricerca.',
      article: 'Un solo riferimento da tenere a portata di mano quando torna il dubbio.',
    }),
    cta: Object.freeze({
      job: 'Salva il Reel per quando riaprirai la ricerca.',
      article: 'Salva il Reel per quando dovrai ricostruire la risposta.',
    }),
  }),
]);

const VARIANT_BY_ID = new Map(INSTAGRAM_REEL_VARIANTS.map((variant) => [variant.id, variant]));
const KIND_OFFSETS = Object.freeze({ article: 0, job: 1 });
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayIndex(day) {
  const match = ISO_DAY_RE.exec(String(day || ''));
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  if (
    !Number.isFinite(timestamp)
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) return null;
  return Math.floor((timestamp - Date.UTC(2020, 0, 1)) / 86400000);
}

function fallbackVariant(kind) {
  return VARIANT_BY_ID.get(kind === 'job' ? 'reel-number' : 'reel-question');
}

/** Pick a reproducible Reel treatment; no random assignment is used. */
export function chooseInstagramReelCreative({ kind, day } = {}) {
  const safeKind = KIND_OFFSETS[kind] === undefined ? 'article' : kind;
  const index = dayIndex(day);
  const variant = index === null || index < 0
    ? fallbackVariant(safeKind)
    : INSTAGRAM_REEL_VARIANTS[(index + KIND_OFFSETS[safeKind]) % INSTAGRAM_REEL_VARIANTS.length];
  return {
    id: variant.id,
    label: variant.label,
    objective: variant.objective,
    primaryMetric: variant.primaryMetric,
    hookType: variant.hookType,
    attentionMechanic: variant.attentionMechanic,
    engagementLoop: variant.engagementLoop,
    followUpFormat: variant.followUpFormat,
    kind: safeKind,
    hook: variant.hook[safeKind],
    lead: variant.lead[safeKind],
    cta: variant.cta[safeKind],
  };
}

function safeText(value, fallback = '') {
  return String(value ?? fallback).replace(/\s+/g, ' ').trim();
}

function shortStat(item) {
  const views = Number(item?.views);
  if (Number.isFinite(views) && views >= 0) return `${views} visualizzazioni ieri`;
  return 'dati disponibili sul sito';
}

/**
 * Return the three vertical cards and the caption for one ranked item.
 * The renderer only consumes plain text, which keeps this contract testable.
 */
export function buildInstagramReelContent({ kind, dayLabel, item, creative } = {}) {
  const selected = creative && creative.hook && creative.kind
    ? creative
    : chooseInstagramReelCreative({ kind, day: dayLabel });
  const title = safeText(item?.title, 'Un aggiornamento per frontalieri');
  const stat = shortStat(item);
  const actionEmoji = selected.primaryMetric === 'comments' ? '💬' : selected.primaryMetric === 'saves' ? '💾' : '📤';
  const caption = [
    selected.lead,
    '',
    `📌 ${title} — ${stat}.`,
    '',
    `${actionEmoji} ${selected.cta}`,
    '👉 Approfondisci dal link in bio.',
    '',
    '#frontalieri #ticino #svizzera #italia #lavoro',
  ].join('\n');

  return {
    caption,
    slides: [
      {
        type: 'hook',
        kicker: selected.hook.kicker,
        title: selected.hook.title,
        body: selected.lead,
      },
      {
        type: 'proof',
        kicker: 'UN DATO REALE',
        title,
        body: stat,
      },
      {
        type: 'cta',
        kicker: 'TOCCA A TE',
        title: selected.cta,
        body: 'Una risposta breve ci aiuta a scegliere il prossimo contenuto.',
        cta: selected.primaryMetric === 'comments'
          ? 'Rispondi nei commenti'
          : selected.primaryMetric === 'saves'
          ? 'Salva il Reel'
          : 'Condividi il Reel',
      },
    ],
  };
}

export function instagramReelLedgerFields(creative) {
  const primaryMetric = creative?.primaryMetric || 'comments';
  return {
    creativeId: creative?.id || 'reel-question',
    creativeBaseId: 'reel',
    creativeVariant: creative?.id || 'reel-question',
    creativeLabel: creative?.label || 'Domanda immediata',
    creativeObjective: creative?.objective || 'conversation',
    primaryMetric,
    engagementMechanic: instagramEngagementMechanic(primaryMetric),
    hookType: creative?.hookType || 'unknown',
    attentionMechanic: creative?.attentionMechanic || 'unknown',
    engagementLoop: creative?.engagementLoop || 'none',
    followUpFormat: creative?.followUpFormat || 'none',
    creativeFormat: 'reel',
  };
}
