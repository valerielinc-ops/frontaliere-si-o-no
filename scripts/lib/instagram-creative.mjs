/**
 * Creative strategy for the Instagram carousel publisher.
 *
 * The publisher already had a reliable data source (GA4) and a reliable
 * carousel transport. What it did not have was a creative system: every post
 * used the same "top 5 + link in bio" wrapper, so the account could publish
 * often without learning whether its audience wanted proof, a reference to
 * save, or a conversation.
 *
 * This module keeps the underlying ranked data unchanged and rotates only the
 * editorial treatment. It is pure by construction so the rotation, captions,
 * closing slide and measurement metadata can be tested without Instagram,
 * GA4, R2 or credentials.
 */

import { instagramEngagementMechanic } from './instagram-engagement.mjs';

export const INSTAGRAM_CREATIVE_FORMATS = Object.freeze({
  proof: Object.freeze({
    id: 'proof',
    label: 'Dato verificabile',
    objective: 'share',
    primaryMetric: 'shares',
    hookType: 'data-proof',
    attentionMechanic: 'single-source-number',
    engagementLoop: 'share-with-utility',
    followUpFormat: 'story-poll',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'DATI REALI', title: 'Dove stanno cliccando i frontalieri?' }),
      article: Object.freeze({ kicker: 'DATI REALI', title: 'Cosa stanno leggendo i frontalieri?' }),
      border: Object.freeze({ kicker: 'DATI REALI', title: 'Quali dogane sono più veloci?' }),
    }),
    lead: Object.freeze({
      job: 'I numeri del sito raccontano quali opportunità hanno attirato più attenzione ieri.',
      article: 'I numeri del sito raccontano quali temi hanno aiutato più frontalieri ieri.',
      border: 'Una settimana di dati per capire quali valichi fanno perdere meno tempo.',
    }),
    cta: Object.freeze({
      job: '📤 Mandalo a chi sta cercando lavoro in Svizzera.',
      article: '📤 Mandalo a un collega che non vuole perdersi il prossimo aggiornamento.',
      border: '📤 Mandalo a chi attraversa il confine ogni mattina.',
    }),
    question: Object.freeze({ job: '', article: '', border: '' }),
    closing: Object.freeze({
      job: Object.freeze({
        kicker: 'PASSAPAROLA UTILE',
        title: 'Conosci qualcuno che sta cercando lavoro?',
        body: 'Inviagli questa classifica: il prossimo ruolo giusto potrebbe essere qui.',
        cta: 'Condividi il post',
      }),
      article: Object.freeze({
        kicker: 'PASSAPAROLA UTILE',
        title: 'Hai un collega frontaliere?',
        body: 'Condividigli gli aggiornamenti che possono evitargli una sorpresa.',
        cta: 'Condividi il post',
      }),
      border: Object.freeze({
        kicker: 'PASSAPAROLA UTILE',
        title: 'Conosci qualcuno che passa da qui?',
        body: 'Mandagli i dati prima del prossimo viaggio oltre confine.',
        cta: 'Condividi il post',
      }),
    }),
  }),
  save: Object.freeze({
    id: 'save',
    label: 'Guida da salvare',
    objective: 'save',
    primaryMetric: 'saves',
    hookType: 'utility-promise',
    attentionMechanic: 'reference-utility',
    engagementLoop: 'save-for-later',
    followUpFormat: 'story-checklist',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'DA SALVARE', title: '5 lavori da tenere d’occhio' }),
      article: Object.freeze({ kicker: 'DA SALVARE', title: '5 articoli da tenere a portata di mano' }),
      border: Object.freeze({ kicker: 'DA SALVARE', title: '5 dogane da controllare' }),
    }),
    lead: Object.freeze({
      job: 'Non devi decidere oggi: salva questa selezione e riguardala quando cerchi il prossimo passo.',
      article: 'Le regole cambiano: salva questa selezione e torna qui quando ti serve una risposta.',
      border: 'Il tempo perso al confine si organizza prima di partire: salva i dati della settimana.',
    }),
    cta: Object.freeze({
      job: '💾 Salvalo per la prossima ricerca di lavoro.',
      article: '💾 Salvalo per ritrovarlo quando ne avrai bisogno.',
      border: '💾 Salvalo prima del prossimo viaggio oltre confine.',
    }),
    question: Object.freeze({ job: '', article: '', border: '' }),
    closing: Object.freeze({
      job: Object.freeze({
        kicker: 'PROMEMORIA',
        title: 'Torna qui quando riapri la ricerca',
        body: 'Il link di ogni voce è nella bio: usa questa lista come punto di partenza.',
        cta: 'Salva il post',
      }),
      article: Object.freeze({
        kicker: 'PROMEMORIA',
        title: 'Torna qui quando ti serve una risposta',
        body: 'Il link di ogni voce è nella bio: tieni questa lista a portata di mano.',
        cta: 'Salva il post',
      }),
      border: Object.freeze({
        kicker: 'PROMEMORIA',
        title: 'Controlla prima di partire',
        body: 'Il link ai dati aggiornati è nella bio: pianifica il viaggio con un’informazione in più.',
        cta: 'Salva il post',
      }),
    }),
  }),
  question: Object.freeze({
    id: 'question',
    label: 'Domanda alla community',
    objective: 'conversation',
    primaryMetric: 'comments',
    hookType: 'open-question',
    attentionMechanic: 'community-question',
    engagementLoop: 'comment-to-content',
    followUpFormat: 'comment-reply',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'PARLIAMONE', title: 'Che lavoro stai cercando?' }),
      article: Object.freeze({ kicker: 'PARLIAMONE', title: 'Quale dubbio vuoi risolvere?' }),
      border: Object.freeze({ kicker: 'PARLIAMONE', title: 'Quale valico attraversi?' }),
    }),
    lead: Object.freeze({
      job: 'La classifica mostra i clic. La tua esperienza ci aiuta a capire cosa manca.',
      article: 'La classifica mostra gli interessi. La tua domanda può diventare il prossimo articolo.',
      border: 'La classifica mostra le medie. Il tuo tragitto racconta la realtà.',
    }),
    cta: Object.freeze({
      job: '💬 Scrivi nei commenti quale ruolo stai cercando: potremmo cercarlo insieme.',
      article: '💬 Scrivi nei commenti quale dubbio vuoi vedere spiegato.',
      border: '💬 Scrivi nei commenti quale valico attraversi più spesso.',
    }),
    question: Object.freeze({
      job: 'Qual è il settore che ti interessa?',
      article: 'Qual è il tema che ti crea più confusione?',
      border: 'A che ora trovi più traffico?',
    }),
    closing: Object.freeze({
      job: Object.freeze({
        kicker: 'TOCCA A TE',
        title: 'Raccontaci cosa stai cercando',
        body: 'Una parola nei commenti ci dà il prossimo tema da approfondire.',
        cta: 'Rispondi nei commenti',
      }),
      article: Object.freeze({
        kicker: 'TOCCA A TE',
        title: 'Fai la tua domanda',
        body: 'Le domande reali diventano guide più utili per tutta la community.',
        cta: 'Rispondi nei commenti',
      }),
      border: Object.freeze({
        kicker: 'TOCCA A TE',
        title: 'Condividi il tuo tragitto',
        body: 'Scrivi valico e fascia oraria: confrontiamo le esperienze senza indovinare.',
        cta: 'Rispondi nei commenti',
      }),
    }),
  }),
});

/**
 * Second experiment dimension. The objective stays fixed while the promise
 * and hook change, so a `proof` result is not confused with a `save` result.
 * The baseline ids remain stable for backwards-compatible ledger entries.
 */
export const INSTAGRAM_CREATIVE_VARIANTS = Object.freeze([
  Object.freeze({ id: 'proof', baseId: 'proof', variant: 'baseline' }),
  Object.freeze({
    id: 'proof-local', baseId: 'proof', variant: 'local', label: 'Dato locale',
    hookType: 'local-ranking', attentionMechanic: 'local-relevance',
    engagementLoop: 'share-to-local-group', followUpFormat: 'story-poll',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'TICINO, IERI', title: 'Quale lavoro ha attirato il Ticino?' }),
      article: Object.freeze({ kicker: 'TICINO, IERI', title: 'Quale tema ha cercato il Ticino?' }),
      border: Object.freeze({ kicker: 'TICINO, SETTIMANA', title: 'Quale valico ha retto meglio?' }),
    }),
    lead: Object.freeze({
      job: 'Non è una lista generica: questi sono i ruoli che ieri hanno mosso più interesse nel Ticino.',
      article: 'Queste letture raccontano le domande che ieri hanno mosso i frontalieri.',
      border: 'Una classifica locale per scegliere il valico con un dato in più.',
    }),
    cta: Object.freeze({
      job: '📤 Mandalo a chi cerca lavoro proprio in Ticino.',
      article: '📤 Mandalo al collega che vive queste domande ogni giorno.',
      border: '📤 Mandalo a chi passa da questo confine ogni mattina.',
    }),
    closing: Object.freeze({
      job: Object.freeze({ kicker: 'DATI DEL TERRITORIO', title: 'Il prossimo ruolo può essere vicino', body: 'Condividi una selezione nata dai clic reali della community.', cta: 'Condividi il post' }),
      article: Object.freeze({ kicker: 'DATI DEL TERRITORIO', title: 'Una risposta utile parte da qui', body: 'Condividi l’aggiornamento con chi vive tra Italia e Svizzera.', cta: 'Condividi il post' }),
      border: Object.freeze({ kicker: 'DATI DEL TERRITORIO', title: 'Il confine è una scelta quotidiana', body: 'Condividi il dato con chi attraversa questo valico.', cta: 'Condividi il post' }),
    }),
  }),
  Object.freeze({
    id: 'proof-surprise', baseId: 'proof', variant: 'surprise', label: 'Dato sorprendente',
    hookType: 'counterintuitive-data', attentionMechanic: 'surprise-gap',
    engagementLoop: 'share-and-predict', followUpFormat: 'story-poll',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'DATO INATTESO', title: 'Il clic più sorprendente di ieri' }),
      article: Object.freeze({ kicker: 'DATO INATTESO', title: 'La domanda che non ti aspetti' }),
      border: Object.freeze({ kicker: 'DATO INATTESO', title: 'Il valico che ha sorpreso' }),
    }),
    lead: Object.freeze({
      job: 'Non avremmo indovinato questa classifica: i clic reali mostrano dove si è fermata l’attenzione.',
      article: 'Non sempre il tema più rumoroso è quello più utile: ecco cosa ha attirato davvero letture.',
      border: 'La percezione del traffico non basta: questa settimana i dati raccontano una sorpresa.',
    }),
    cta: Object.freeze({
      job: '📤 Condividilo con chi avrebbe fatto un’altra previsione.',
      article: '📤 Mandalo a chi discute sempre di questo tema.',
      border: '📤 Mandalo a chi sceglie il valico “a memoria”.',
    }),
    closing: Object.freeze({
      job: Object.freeze({ kicker: 'NON INDOVINARE', title: 'Guarda cosa hanno scelto gli altri', body: 'Un dato reale vale più di una sensazione: condividilo.', cta: 'Condividi il post' }),
      article: Object.freeze({ kicker: 'NON INDOVINARE', title: 'La prossima domanda può essere la tua', body: 'Condividi questa risposta prima che il tema cambi ancora.', cta: 'Condividi il post' }),
      border: Object.freeze({ kicker: 'NON INDOVINARE', title: 'Controlla prima di partire', body: 'Condividi il dato con il tuo gruppo di pendolari.', cta: 'Condividi il post' }),
    }),
  }),
  Object.freeze({ id: 'save', baseId: 'save', variant: 'baseline' }),
  Object.freeze({
    id: 'save-checklist', baseId: 'save', variant: 'checklist', label: 'Checklist da salvare',
    hookType: 'checklist', attentionMechanic: 'checklist',
    engagementLoop: 'save-and-return', followUpFormat: 'story-quiz',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'CHECKLIST', title: '5 lavori da controllare prima di candidarti' }),
      article: Object.freeze({ kicker: 'CHECKLIST', title: '5 risposte da tenere a portata di mano' }),
      border: Object.freeze({ kicker: 'CHECKLIST', title: '5 dati da controllare prima di partire' }),
    }),
    lead: Object.freeze({
      job: 'Una lista breve da tenere aperta quando confronti le prossime candidature.',
      article: 'Una lista breve da tenere aperta quando devi ricostruire una regola.',
      border: 'Una lista breve da tenere aperta quando prepari il prossimo tragitto.',
    }),
    cta: Object.freeze({
      job: '💾 Salvalo: ti servirà quando riaprirai la ricerca.',
      article: '💾 Salvalo: le regole non si ricordano a memoria.',
      border: '💾 Salvalo: controllalo prima di uscire di casa.',
    }),
    closing: Object.freeze({
      job: Object.freeze({ kicker: 'CHECKLIST PRONTA', title: 'Non ricominciare da zero', body: 'Salva questa lista e riaprila quando trovi un annuncio interessante.', cta: 'Salva il post' }),
      article: Object.freeze({ kicker: 'CHECKLIST PRONTA', title: 'Tieni qui la risposta', body: 'Salva il post per ritrovare i punti essenziali quando ti servono.', cta: 'Salva il post' }),
      border: Object.freeze({ kicker: 'CHECKLIST PRONTA', title: 'Parti con un dato in più', body: 'Salva la classifica e controlla gli aggiornamenti prima del viaggio.', cta: 'Salva il post' }),
    }),
  }),
  Object.freeze({
    id: 'save-moment', baseId: 'save', variant: 'moment', label: 'Promemoria del momento',
    hookType: 'situational-utility', attentionMechanic: 'moment-relevance',
    engagementLoop: 'save-before-moment', followUpFormat: 'story-reminder',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'QUANDO TI SERVE', title: '5 occasioni da non perdere' }),
      article: Object.freeze({ kicker: 'QUANDO TI SERVE', title: '5 risposte da ritrovare' }),
      border: Object.freeze({ kicker: 'QUANDO TI SERVE', title: '5 passaggi da preparare' }),
    }),
    lead: Object.freeze({
      job: 'Non devi candidarti oggi: conserva queste opportunità per il momento giusto.',
      article: 'Non devi risolvere tutto oggi: conserva queste risposte per quando arriverà il dubbio.',
      border: 'Non devi partire adesso: conserva questi dati per il prossimo passaggio.',
    }),
    cta: Object.freeze({
      job: '💾 Salvalo per il prossimo momento di ricerca.',
      article: '💾 Salvalo per quando dovrai prendere una decisione.',
      border: '💾 Salvalo per il prossimo attraversamento.',
    }),
    closing: Object.freeze({
      job: Object.freeze({ kicker: 'PROMEMORIA', title: 'Torna quando sei pronto', body: 'Il link di ogni voce resta nella bio: conserva la selezione.', cta: 'Salva il post' }),
      article: Object.freeze({ kicker: 'PROMEMORIA', title: 'Torna quando ti serve', body: 'Una risposta salvata è una sorpresa in meno domani.', cta: 'Salva il post' }),
      border: Object.freeze({ kicker: 'PROMEMORIA', title: 'Torna prima del viaggio', body: 'I dati cambiano: usa questa lista come punto di partenza.', cta: 'Salva il post' }),
    }),
  }),
  Object.freeze({ id: 'question', baseId: 'question', variant: 'baseline' }),
  Object.freeze({
    id: 'question-choice', baseId: 'question', variant: 'choice', label: 'Scelta guidata',
    hookType: 'forced-choice', attentionMechanic: 'low-friction-choice',
    engagementLoop: 'comment-to-poll', followUpFormat: 'story-result',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'SCEGLI TU', title: 'Quale ruolo ti interessa di più?' }),
      article: Object.freeze({ kicker: 'SCEGLI TU', title: 'Quale dubbio viene prima?' }),
      border: Object.freeze({ kicker: 'SCEGLI TU', title: 'Quale valico scegli?' }),
    }),
    lead: Object.freeze({
      job: 'La classifica è un punto di partenza: aiutaci a scegliere il prossimo settore da seguire.',
      article: 'La classifica è un punto di partenza: aiutaci a scegliere la prossima risposta.',
      border: 'La classifica è un punto di partenza: aiutaci a capire quale tragitto raccontare.',
    }),
    cta: Object.freeze({
      job: '💬 Scrivi solo il settore: 1) sanità 2) ufficio 3) tecnico.',
      article: '💬 Scrivi solo il tema: 1) tasse 2) sanità 3) permessi.',
      border: '💬 Scrivi il valico: 1) Brogeda 2) Chiasso 3) altro.',
    }),
    question: Object.freeze({ job: 'Quale settore scegli: sanità, ufficio o tecnico?', article: 'Quale tema scegli: tasse, sanità o permessi?', border: 'Quale valico scegli più spesso?' }),
    closing: Object.freeze({
      job: Object.freeze({ kicker: 'VOTO RAPIDO', title: 'Scegli il prossimo settore', body: 'Una risposta breve ci aiuta a costruire il prossimo contenuto.', cta: 'Rispondi nei commenti' }),
      article: Object.freeze({ kicker: 'VOTO RAPIDO', title: 'Scegli il prossimo tema', body: 'Una risposta breve ci aiuta a costruire una guida migliore.', cta: 'Rispondi nei commenti' }),
      border: Object.freeze({ kicker: 'VOTO RAPIDO', title: 'Scegli il prossimo confronto', body: 'Una risposta breve ci aiuta a raccontare il tragitto giusto.', cta: 'Rispondi nei commenti' }),
    }),
  }),
  Object.freeze({
    id: 'question-story', baseId: 'question', variant: 'story', label: 'Esperienza personale',
    hookType: 'lived-experience', attentionMechanic: 'identity-story',
    engagementLoop: 'comment-to-story', followUpFormat: 'comment-reply',
    cover: Object.freeze({
      job: Object.freeze({ kicker: 'RACCONTACI', title: 'Come è andata la tua ricerca?' }),
      article: Object.freeze({ kicker: 'RACCONTACI', title: 'Cosa ti è successo davvero?' }),
      border: Object.freeze({ kicker: 'RACCONTACI', title: 'Com’è il tuo tragitto?' }),
    }),
    lead: Object.freeze({
      job: 'I clic dicono cosa interessa; la tua esperienza ci dice cosa manca davvero.',
      article: 'Le letture dicono cosa interessa; la tua esperienza ci dice cosa manca davvero.',
      border: 'Le medie dicono una cosa; il tuo tragitto può raccontarne un’altra.',
    }),
    cta: Object.freeze({
      job: '💬 Racconta in una frase da quale settore parti.',
      article: '💬 Racconta in una frase quale regola ti ha bloccato.',
      border: '💬 Racconta in una frase quando attraversi il confine.',
    }),
    question: Object.freeze({ job: 'Da quale settore parti?', article: 'Quale regola ti ha bloccato?', border: 'Quando attraversi il confine?' }),
    closing: Object.freeze({
      job: Object.freeze({ kicker: 'ESPERIENZE REALI', title: 'La tua storia orienta il prossimo post', body: 'Raccontala senza dati personali: la useremo per fare una domanda migliore.', cta: 'Rispondi nei commenti' }),
      article: Object.freeze({ kicker: 'ESPERIENZE REALI', title: 'La tua domanda può aiutare altri', body: 'Raccontala senza dati personali: la trasformiamo in una risposta verificata.', cta: 'Rispondi nei commenti' }),
      border: Object.freeze({ kicker: 'ESPERIENZE REALI', title: 'Il tragitto non è una media', body: 'Raccontalo senza targhe o dettagli identificativi: confrontiamo le esperienze.', cta: 'Rispondi nei commenti' }),
    }),
  }),
]);

export const INSTAGRAM_CREATIVE_IDS = Object.freeze(INSTAGRAM_CREATIVE_VARIANTS.map((variant) => variant.id));
const CREATIVE_VARIANT_BY_ID = new Map(INSTAGRAM_CREATIVE_VARIANTS.map((variant) => [variant.id, variant]));
export const INSTAGRAM_MAX_CAPTION_LENGTH = 2200;

const KIND_OFFSETS = Object.freeze({ article: 0, job: 1, border: 2 });
const VALID_KINDS = new Set(Object.keys(KIND_OFFSETS));
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function captionText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trim()}…`;
}

function dayIndex(day) {
  const match = ISO_DAY_RE.exec(String(day || ''));
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) return null;
  return Math.floor((timestamp - Date.UTC(2020, 0, 1)) / 86400000);
}

function definitionFor(kind, id) {
  if (!VALID_KINDS.has(kind)) throw new Error(`unknown Instagram creative kind: ${kind}`);
  const variant = CREATIVE_VARIANT_BY_ID.get(id) || CREATIVE_VARIANT_BY_ID.get('proof');
  const definition = INSTAGRAM_CREATIVE_FORMATS[variant.baseId];
  return {
    id: variant.id,
    baseId: variant.baseId,
    variant: variant.variant,
    label: variant.label || definition.label,
    objective: definition.objective,
    primaryMetric: definition.primaryMetric,
    hookType: variant.hookType || definition.hookType || 'unknown',
    attentionMechanic: variant.attentionMechanic || definition.attentionMechanic || 'unknown',
    engagementLoop: variant.engagementLoop || definition.engagementLoop || 'none',
    followUpFormat: variant.followUpFormat || definition.followUpFormat || 'none',
    kind,
    cover: variant.cover?.[kind] || definition.cover[kind],
    lead: variant.lead?.[kind] || definition.lead[kind],
    cta: variant.cta?.[kind] || definition.cta[kind],
    question: variant.question?.[kind] || definition.question[kind],
    closing: variant.closing?.[kind] || definition.closing[kind],
  };
}

/**
 * Pick a deterministic creative for a publishing day and content kind.
 *
 * Daily article and job posts use different treatments on the same day. The
 * weekly border slot advances once per week, so a Monday repost does not
 * accidentally select a new treatment merely because the cron was retried.
 * Invalid input safely falls back to the proof format.
 */
export function chooseInstagramCreative({ kind, day } = {}) {
  if (!VALID_KINDS.has(kind)) return definitionFor('article', 'proof');
  const index = dayIndex(day);
  if (index === null || index < 0) return definitionFor(kind, 'proof');
  const cycle = kind === 'border' ? Math.floor(index / 7) : index;
  const formatId = INSTAGRAM_CREATIVE_IDS[(cycle + KIND_OFFSETS[kind]) % INSTAGRAM_CREATIVE_IDS.length];
  return definitionFor(kind, formatId);
}

/**
 * Build the Instagram-specific caption. Unlike the legacy channel-agnostic
 * helper, this caption has one job: make the intended interaction explicit.
 */
export function buildInstagramCaption({ kind, dayLabel, picks, creative } = {}) {
  const safeKind = VALID_KINDS.has(kind) ? kind : 'article';
  const selected = creative && VALID_KINDS.has(creative.kind)
    ? creative
    : definitionFor(safeKind, 'proof');
  const safePicks = Array.isArray(picks) ? picks.slice(0, 5) : [];
  const lines = safePicks.map((pick, index) => `${index + 1}. ${captionText(pick?.title || 'Voce', 140)} — ${captionText(pick?.statValue || 'dati disponibili', 80)}`);
  const questionLine = selected.question ? `🗣️ ${selected.question}` : '';

  const caption = [
    selected.lead,
    '',
    ...lines,
    '',
    selected.cta,
    questionLine,
    `👉 Approfondisci dal link in bio (${captionText(dayLabel || 'aggiornamento del giorno', 80)}).`,
    '',
    '#frontalieri #ticino #svizzera #italia #lavoro',
  ].filter((line, index, list) => line !== '' || list[index - 1] !== '').join('\n');

  // The production definitions and five ranked items fit comfortably under
  // Instagram's 2,200-character caption limit. Keep the helper fail-safe if
  // a future caller supplies a long custom creative definition.
  return caption.length <= INSTAGRAM_MAX_CAPTION_LENGTH
    ? caption
    : `${caption.slice(0, INSTAGRAM_MAX_CAPTION_LENGTH - 1).trimEnd()}…`;
}

/** Stable UTM content value that identifies both treatment and ranked item. */
export function instagramCreativeContent(creative, itemId) {
  const creativeId = String(creative?.id || 'proof').trim() || 'proof';
  const id = String(itemId || '').trim();
  return id ? `${creativeId}-${id}` : creativeId;
}

/** Fields persisted next to each post so Insights can be joined to the idea. */
export function instagramCreativeLedgerFields(creative) {
  return {
    creativeId: creative?.id || 'proof',
    creativeBaseId: creative?.baseId || String(creative?.id || 'proof').split('-', 1)[0],
    creativeVariant: creative?.variant || 'baseline',
    creativeLabel: creative?.label || 'Dato verificabile',
    creativeObjective: creative?.objective || 'share',
    primaryMetric: creative?.primaryMetric || 'shares',
    engagementMechanic: instagramEngagementMechanic(creative?.primaryMetric || 'shares'),
    hookType: creative?.hookType || 'unknown',
    attentionMechanic: creative?.attentionMechanic || 'unknown',
    engagementLoop: creative?.engagementLoop || 'none',
    followUpFormat: creative?.followUpFormat || 'none',
  };
}

/**
 * Recover the stable metadata for a known carousel treatment from its id.
 * This is intentionally null for unknown/legacy ids: a historical post
 * without a creative id must never be classified from its metrics alone.
 */
export function instagramCreativeLedgerFieldsForId(creativeId) {
  const id = String(creativeId || '').trim();
  const variant = CREATIVE_VARIANT_BY_ID.get(id);
  if (!variant) return null;
  const definition = INSTAGRAM_CREATIVE_FORMATS[variant.baseId];
  return instagramCreativeLedgerFields({
    id: variant.id,
    baseId: variant.baseId,
    variant: variant.variant,
    label: variant.label || definition.label,
    objective: definition.objective,
    primaryMetric: definition.primaryMetric,
    hookType: variant.hookType || definition.hookType,
    attentionMechanic: variant.attentionMechanic || definition.attentionMechanic,
    engagementLoop: variant.engagementLoop || definition.engagementLoop,
    followUpFormat: variant.followUpFormat || definition.followUpFormat,
  });
}

/**
 * Fill only absent metadata on a known carousel ledger row. Explicit values
 * win so this helper cannot overwrite an audited correction or a future
 * treatment. Reels and unknown legacy rows are left untouched.
 */
export function enrichInstagramCreativeLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.kind === 'reel') return entry;
  const inferred = instagramCreativeLedgerFieldsForId(entry.creativeId);
  if (!inferred) return entry;
  const enriched = { ...entry };
  for (const [key, value] of Object.entries(inferred)) {
    if (!String(enriched[key] ?? '').trim()) enriched[key] = value;
  }
  return enriched;
}
