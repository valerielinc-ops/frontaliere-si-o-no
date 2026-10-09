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

export const INSTAGRAM_CREATIVE_FORMATS = Object.freeze({
  proof: Object.freeze({
    id: 'proof',
    label: 'Dato verificabile',
    objective: 'share',
    primaryMetric: 'shares',
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

export const INSTAGRAM_CREATIVE_IDS = Object.freeze(Object.keys(INSTAGRAM_CREATIVE_FORMATS));
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
  const definition = INSTAGRAM_CREATIVE_FORMATS[id];
  return {
    id: definition.id,
    label: definition.label,
    objective: definition.objective,
    primaryMetric: definition.primaryMetric,
    kind,
    cover: definition.cover[kind],
    lead: definition.lead[kind],
    cta: definition.cta[kind],
    question: definition.question[kind],
    closing: definition.closing[kind],
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
    creativeLabel: creative?.label || 'Dato verificabile',
    creativeObjective: creative?.objective || 'share',
    primaryMetric: creative?.primaryMetric || 'shares',
  };
}
