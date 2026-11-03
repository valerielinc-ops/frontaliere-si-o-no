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
    attentionMechanic: 'specific-question',
    engagementLoop: 'open-question-comment',
    followUpFormat: 'none',
    hook: Object.freeze({
      job: Object.freeze({ kicker: 'UNA DOMANDA', title: 'Stai cercando lavoro in Svizzera?' }),
      article: Object.freeze({ kicker: 'UNA DOMANDA', title: 'Questa regola ti crea dubbi?' }),
    }),
    lead: Object.freeze({
      job: 'In 10 secondi partiamo da un dato reale e arriviamo alla prossima domanda utile.',
      article: 'In 10 secondi partiamo da un dato reale e arriviamo alla domanda che conta.',
    }),
    cta: Object.freeze({
      job: 'Quale settore stai cercando? Raccontalo nei commenti.',
      article: 'Quale tema vuoi vedere spiegato? Raccontalo nei commenti.',
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
    id: 'reel-follow',
    label: 'Aggiornamento da seguire',
    objective: 'follow',
    primaryMetric: 'follows',
    hookType: 'useful-update',
    attentionMechanic: 'verified-update',
    engagementLoop: 'follow-for-reliable-updates',
    followUpFormat: 'none',
    hook: Object.freeze({
      job: Object.freeze({ kicker: 'LAVORO IN TICINO', title: 'Un aggiornamento utile per orientare la ricerca' }),
      article: Object.freeze({ kicker: 'ITALIA E SVIZZERA', title: 'Un aggiornamento da seguire con fonti alla mano' }),
    }),
    lead: Object.freeze({
      job: 'Una posizione aggiornata e il riferimento verificato per valutare il prossimo passo.',
      article: 'Un fatto verificato, con il contesto utile per seguirne gli sviluppi.',
    }),
    cta: Object.freeze({
      job: 'Segui il profilo per aggiornamenti verificati sul lavoro in Ticino.',
      article: 'Segui il profilo per aggiornamenti verificati tra Italia e Svizzera.',
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
/** Optimize Reels for post-attributed follows when Meta returns that exact metric. */
export function chooseInstagramReelCreative({ kind } = {}) {
  const safeKind = kind === 'job' ? 'job' : 'article';
  const variant = VARIANT_BY_ID.get('reel-follow');
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

function boundedText(value, maxLength) {
  const text = safeText(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function sourceIdText(value) {
  const sourceId = String(value ?? '').trim();
  return sourceId.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(sourceId) ? sourceId || null : null;
}

function validViews(item) {
  const raw = item?.views;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const views = Number(typeof raw === 'string' ? raw.trim() : raw);
  return Number.isFinite(views) && views >= 0 ? views : null;
}

function shortStat(item) {
  const views = validViews(item);
  if (views !== null) return `${views} visualizzazioni ieri`;
  return 'dati disponibili sul sito';
}

function narratedSentence(value) {
  const text = safeText(value);
  if (!text) return '';
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

/**
 * Return the three vertical cards and the caption for one ranked item.
 * The renderer only consumes plain text, which keeps this contract testable.
 */
export function buildInstagramReelContent({ kind, dayLabel, item, creative, socialCopy } = {}) {
  const selected = creative && creative.hook && creative.kind
    ? creative
    : chooseInstagramReelCreative({ kind });
  const title = safeText(item?.title)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const stat = shortStat(item);
  const displayTitle = boundedText(title, 90);
  const views = validViews(item);
  const hasViews = views !== null;
  const hasSourceTitle = typeof item?.title === 'string' && Boolean(title);
  const sourceId = sourceIdText(item?.slug);
  const generatedCopy = socialCopy?.copyMode === 'codex' && socialCopy.objective === selected.objective
    ? socialCopy
    : null;
  const actionEmoji = generatedCopy ? '' : selected.primaryMetric === 'comments'
    ? '💬'
    : selected.primaryMetric === 'saves' ? '💾' : selected.primaryMetric === 'follows' ? '➕' : '📤';
  const closingTitle = {
    conversation: 'La prossima idea parte da te',
    save: 'Tieni questo aggiornamento a portata di mano',
    share: 'Un passaparola utile',
    follow: 'Aggiornamenti verificati, senza perderli',
  }[selected.objective];
  const caption = [
    generatedCopy?.hook || selected.lead,
    '',
    `📌 ${displayTitle} — ${stat}.`,
    '',
    `${actionEmoji} ${generatedCopy?.cta || selected.cta}`.trim(),
    selected.objective === 'follow'
      ? 'Fonte e dettagli sono nel link in bio.'
      : generatedCopy && /link in bio/i.test(generatedCopy.cta) ? '' : '👉 Per dettagli e fonti: link in bio.',
    'Voce sintetica; la narrazione ripete il testo verificato mostrato nel video.',
    '',
    '#frontalieri #ticino #svizzera #italia #lavoro',
  ].join('\n');

  const slides = [
    {
      type: 'hook',
      kicker: boundedText(selected.hook.kicker, 60),
      title: boundedText(generatedCopy?.hook || selected.hook.title, 90),
      body: boundedText(selected.lead, 190),
    },
    {
      type: 'proof',
      kicker: 'UN DATO REALE',
      title: displayTitle,
      body: boundedText(stat, 190),
    },
    {
      type: 'cta',
      kicker: 'TOCCA A TE',
      title: boundedText(generatedCopy ? closingTitle : selected.cta, 130),
      body: boundedText(generatedCopy ? '' : 'Una risposta breve ci aiuta a scegliere il prossimo contenuto.', 190),
      cta: boundedText(generatedCopy?.cta || (selected.primaryMetric === 'comments'
        ? 'Rispondi nei commenti'
        : selected.primaryMetric === 'saves'
        ? 'Salva il Reel'
        : selected.primaryMetric === 'follows' ? 'Segui il profilo' : 'Condividi il Reel'), 80),
    },
  ];
  const storyboard = slides.map((slide, index) => ({
    position: index + 1,
    beat: slide.type === 'proof' ? 'verified-source-fact' : slide.type,
    ...(slide.type === 'proof' ? { sourceId } : {}),
    kicker: boundedText(slide.kicker, 60),
    title: boundedText(slide.title, slide.type === 'cta' ? 130 : 90),
    body: boundedText(slide.body, 190),
    cta: boundedText(slide.cta, 80),
  }));
  const sourceTitle = title;
  const sourceFacts = [{
    sourceId,
    title: sourceTitle,
    metricLabel: hasViews ? 'Visualizzazioni sul sito' : '',
    metricValue: hasViews ? String(views) : '',
    context: hasViews ? 'Ieri' : '',
  }];
  const subtitleSegments = slides.map((slide) => [slide.title, slide.body, slide.cta]
    .filter(Boolean)
    .map(narratedSentence)
    .join(' '));
  const voiceScript = subtitleSegments.join(' ');
  const productionKit = {
    schemaVersion: 2,
    valid: Boolean(sourceId && hasSourceTitle && title.length <= 90 && hasViews),
    invalidReason: sourceId && hasSourceTitle && title.length <= 90 && hasViews
      ? null
      : 'verified-source-fact-exceeds-renderer-contract-or-is-missing',
    channel: 'instagram',
    format: 'reel',
    kind: selected.kind,
    sourceFacts,
    script: subtitleSegments,
    voiceScript,
    storyboard,
    subtitles: subtitleSegments,
    subtitleMode: 'exact-card-transcript',
    coverGuidance: {
      treatment: boundedText(selected.id, 40),
      canvas: 'vertical-1080x1920',
      focus: 'hook-before-source-proof',
    },
    caption: caption.slice(0, 2200),
    renderInput: { slides },
  };

  return {
    caption: productionKit.caption,
    slides: productionKit.renderInput.slides,
    productionKit,
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
    engagementMechanic: creative?.id === 'reel-question'
      ? 'open-question-comment'
      : instagramEngagementMechanic(primaryMetric),
    hookType: creative?.hookType || 'unknown',
    attentionMechanic: creative?.attentionMechanic || 'unknown',
    engagementLoop: creative?.engagementLoop || 'none',
    followUpFormat: creative?.followUpFormat || 'none',
    creativeFormat: 'reel',
  };
}
