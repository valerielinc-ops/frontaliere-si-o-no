/**
 * Pure builders for the personal-profile LinkedIn daily post.
 *
 * Rank/GA4/ledger I/O stays in scripts/post-to-linkedin-member.mjs. This module
 * owns what the member actually publishes: rotating Italian commentary, company
 * mention syntax, and the article-card payload (title / description / optional
 * thumbnail URN). Tests import these functions with fixtures — no LinkedIn
 * network, no GA4.
 *
 * LinkedIn Posts API does not scrape OG. A text-only `content.article` is why
 * a live post showed a card without an image; the thumbnail URN is assembled
 * here when the caller already uploaded one.
 */

import {
  CANTON_NAME_BY_CODE,
  stripDiacritics,
  stripHtml,
  stripLeadingSectionLabel,
  truncateBody,
} from './social-post-utils.mjs';

/** LinkedIn hard-rejects commentary over 3000 chars; stay under it. */
export const COMMENTARY_MAX = 2900;

/** Article-card description is a preview, not the post body. */
export const ARTICLE_DESCRIPTION_MAX = 256;

const ORG_URN_PREFIX = 'urn:li:organization:';
const ORG_URN_RE = /^urn:li:organization:\d+$/;
const IMAGE_URN_RE = /^urn:li:image:\S+$/;

// «Social proof» e' un CONTEGGIO di visualizzazioni, non la parola.
//
// L'alternativa nuda `\bvisualizzazion[ie]?\b` toglieva la parola ovunque
// comparisse: un excerpt legittimo — «una feature di visualizzazione dati»,
// «la visualizzazione mobile della pagina» — usciva mutilato in silenzio, e
// il fail-soft del poster non aveva modo di accorgersene (follow-up #6450
// item 2). Le alternative qui sotto chiedono tutte un contesto di conteggio:
// una cifra prima, una cifra dopo, o il marcatore 📊 che questo sito emette
// solo davanti alle proprie metriche.
const VIEWS_SOCIAL_PROOF_RE = new RegExp(
  [
    // «30 visualizzazioni», «1.234 visualizzazioni il 3/4/2026»
    "\\d[\\d.'\\u00a0\\s]*\\s*visualizzazion[ie]?(?:\\s+il\\s+\\d{1,2}/\\d{1,2}/\\d{2,4})?\\.?",
    // «Visualizzazioni: 1.234», «visualizzazioni 30»
    "visualizzazion[ie]?\\s*[:=]?\\s*\\d[\\d.'\\u00a0]*",
    // Il marcatore, con o senza la parola attaccata.
    '📊\\s*(?:visualizzazion[ie]?)?',
  ].join('|'),
  'gi',
);

const ARTICLE_ANGLES = 7;
const JOB_ANGLES = 7;

/**
 * Calendar-day → template index. Consecutive YYYY-MM-DD values map to
 * consecutive indices, so two mornings never share a hook. The slug is not
 * part of the key: the same article/job posted on two days still rotates.
 *
 * @param {string} day YYYY-MM-DD
 * @param {number} modulus
 * @returns {number}
 */
export function editorialIndex(day, modulus) {
  const n = Math.max(1, Number(modulus) || 1);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return 0;
  const utcDays = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  return ((utcDays % n) + n) % n;
}

/**
 * LinkedIn mention when an organization URN is already on the record.
 * Without a URN the company stays searchable plaintext — member tokens with
 * only w_member_social cannot look companies up. Never throws.
 *
 * @param {string} name
 * @param {string} [orgUrn]
 * @returns {string}
 */
export function formatCompanyMention(name, orgUrn) {
  const n = String(name || '').trim();
  if (!n) return '';
  const urn = normalizeOrganizationUrn(orgUrn);
  return urn ? `@[${sanitizeMentionLabel(n)}](${urn})` : n;
}

/**
 * Rende un nome azienda sicuro dentro l'etichetta di `@[…](urn)`.
 *
 * L'etichetta e' delimitata da parentesi QUADRE, quindi sono `[` e `]` — non
 * le tonde — a poterla chiudere in anticipo e a rompere la mention: un nome
 * come "ACME [CH] AG" produrrebbe `@[ACME [CH](urn)` e il resto finirebbe
 * come testo. Le tonde di "ABC (Schweiz) AG", frequentissime sulle filiali
 * svizzere, stanno DENTRO l'etichetta e non la terminano: restano intatte,
 * perche' mutilare il nome legale di un datore per una paura non misurata
 * sarebbe un danno peggiore del rischio (follow-up #6450 item 1).
 *
 * Anche un a capo rompe la sintassi — il parser di LinkedIn non attraversa la
 * riga — quindi ogni spazio bianco collassa in uno solo.
 *
 * Il fail-soft del poster assorbe il 400 e salta il post del giorno: senza
 * questa normalizzazione un datore col nome sbagliato costerebbe una
 * pubblicazione senza lasciare traccia.
 *
 * @param {string} label
 * @returns {string}
 */
export function sanitizeMentionLabel(label) {
  return String(label || '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} raw
 * @returns {string} canonical organization URN or ''
 */
export function normalizeOrganizationUrn(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (ORG_URN_RE.test(s)) return s;
  if (/^\d+$/.test(s)) return `${ORG_URN_PREFIX}${s}`;
  return '';
}

/**
 * Drop site-traffic social proof ("30 visualizzazioni", the word itself).
 * Used on commentary inputs and on the article-card description so a polluted
 * excerpt cannot put pageviews on LinkedIn.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripViewCounts(text) {
  return String(text || '')
    .replace(VIEWS_SOCIAL_PROOF_RE, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Pull og:image / og:description (and name=description fallback) from HTML.
 * Attribute order is not assumed: some emitters write content= before property=.
 *
 * @param {string} html
 * @returns {{ ogImage: string, ogDescription: string }}
 */
export function extractOgFromHtml(html) {
  const src = String(html || '');
  const ogDescription =
    metaContent(src, 'og:description') || metaContent(src, 'description');
  return {
    ogImage: decodeEntities(metaContent(src, 'og:image')),
    ogDescription: decodeEntities(ogDescription),
  };
}

/**
 * Resolve a possibly-relative og:image against the page URL.
 *
 * @param {string} maybe
 * @param {string} base
 * @returns {string}
 */
export function resolveMaybeAbsoluteUrl(maybe, base) {
  const raw = String(maybe || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

export function resolveJobCompany(job) {
  if (!job || typeof job !== 'object') return '';
  return String(job.hiringOrganization?.name || job.company || '').trim();
}

export function resolveOrganizationUrn(job) {
  if (!job || typeof job !== 'object') return '';
  return normalizeOrganizationUrn(
    job.linkedinOrgUrn || job.organizationUrn || job.hiringOrganization?.linkedinUrn,
  );
}

export function resolveJobLocation(job) {
  if (!job || typeof job !== 'object') return '';
  const city = String(
    job.jobLocation?.address?.addressLocality || job.location || '',
  ).trim();
  const cantonCode = String(
    job.canton || job.jobLocation?.address?.addressRegion || '',
  ).trim();
  const cantonName = CANTON_NAME_BY_CODE[cantonCode] || '';
  if (city && cantonName && !city.toLowerCase().includes(cantonName.toLowerCase())) {
    return `${city}, Canton ${cantonName}`;
  }
  if (city) return city;
  if (cantonName) return `Canton ${cantonName}`;
  return '';
}

export function resolveJobDescription(job) {
  if (!job || typeof job !== 'object') return '';
  const raw = job.descriptionByLocale?.it || job.description || '';
  return truncateBody(stripLeadingSectionLabel(stripHtml(String(raw))), 420);
}

/**
 * Article geo: explicit location wins, else a canton named in title/path,
 * else Ticino (the site's home canton — never blocks the post).
 *
 * @param {{ title?: string, path?: string, location?: string }} pick
 * @returns {string}
 */
export function inferArticleLocation(pick = {}) {
  const explicit = String(pick.location || '').trim();
  if (explicit) return explicit;
  const hay = `${pick.title || ''} ${pick.path || ''}`.toLowerCase();
  for (const name of Object.values(CANTON_NAME_BY_CODE)) {
    if (name && hay.includes(String(name).toLowerCase())) return name;
  }
  return 'Ticino';
}

/**
 * Article-card `content.article` object. Thumbnail only when a real image URN
 * is supplied — omitting it is fail-soft (title+description still go out).
 *
 * @param {{ source: string, title?: string, description?: string, thumbnail?: string }} opts
 * @returns {{ source: string, title: string, description?: string, thumbnail?: string }}
 */
export function buildArticleContent({ source, title, description, thumbnail } = {}) {
  const article = {
    source: String(source || ''),
    title: truncateBody(stripViewCounts(String(title || '')), 180),
  };
  const desc = stripViewCounts(String(description || ''));
  if (desc) article.description = truncateBody(desc, ARTICLE_DESCRIPTION_MAX);
  const thumb = String(thumbnail || '').trim();
  if (IMAGE_URN_RE.test(thumb)) article.thumbnail = thumb;
  return article;
}

/**
 * Full Posts API payload for a member article share.
 *
 * @param {{ author: string, commentary: string, article: object }} opts
 */
export function buildMemberPostPayload({ author, commentary, article } = {}) {
  return {
    author,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: { article },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

/**
 * Multi-paragraph Italian commentary. `views` is accepted and discarded so a
 * caller that still has the GA4 number cannot leak it into the post.
 *
 * @param {object} opts
 * @returns {string}
 */
export function buildMemberCommentary(opts = {}) {
  const kind = opts.kind === 'job' ? 'job' : 'article';
  const title = stripViewCounts(String(opts.title || '').trim());
  const url = String(opts.url || '').trim();
  const day = String(opts.day || '');
  const location = String(opts.location || '').trim();
  const canton = String(opts.canton || '').trim();
  const company = String(opts.company || '').trim();
  const companyMention = formatCompanyMention(company, opts.organizationUrn);
  const excerpt = stripViewCounts(
    String(opts.excerpt || '').trim() || fallbackExcerpt(kind, { location, title }),
  );

  const hashtags = buildMemberHashtags({
    kind,
    title,
    location,
    canton,
    company,
  });

  const ctx = { title, excerpt, location, url, company, companyMention };
  const body =
    kind === 'job'
      ? JOB_TEMPLATES[editorialIndex(day, JOB_ANGLES)](ctx)
      : ARTICLE_TEMPLATES[editorialIndex(day, ARTICLE_ANGLES)](ctx);

  return withHashtags(body, hashtags);
}

/**
 * @param {{ kind: string, title?: string, location?: string, canton?: string, company?: string }} opts
 * @returns {string}
 */
export function buildMemberHashtags({ kind, title, location, canton, company } = {}) {
  const tags = [];
  const push = (t) => {
    if (t && !tags.includes(t) && tags.length < 8) tags.push(t);
  };

  push('#frontalieri');
  push('#lavoroinSvizzera');
  if (kind === 'job') push('#offertedilavoro');

  const cantonName = CANTON_NAME_BY_CODE[canton] || '';
  if (cantonName) push(hashtagToken(cantonName));
  const city = firstLocationWord(location);
  if (city && city.toLowerCase() !== String(cantonName).toLowerCase()) {
    push(hashtagToken(city));
  }
  if (!cantonName && !city) push('#Ticino');

  push('#Svizzera');
  push('#Italia');

  const hay = `${title || ''} ${company || ''}`;
  if (/\bimposta\b|\bfonte\b/i.test(hay)) push('#impostaallasfonte');
  if (/\birpef\b/i.test(hay)) push('#IRPEF');
  if (/\binfermier/i.test(hay)) push('#infermiere');
  if (/\btass/i.test(hay)) push('#tasse');

  return tags.join(' ');
}

// ── templates ────────────────────────────────────────────────

const ARTICLE_TEMPLATES = [
  ({ title, excerpt, location, url }) =>
    joinBlocks([
      'Lavori in Svizzera e ti chiedi come si combina la busta paga con le regole italiane?',
      title,
      excerpt,
      `È il dubbio classico dei frontalieri: lavoro in Svizzera, dichiarazione in Italia, quadro utile per ${placePhrase(location)}. Niente traffico del sito, solo il contenuto.`,
      `👉 Leggi la guida: ${url}`,
    ]),
  ({ title, excerpt, location, url }) =>
    joinBlocks([
      'Chi cerca «frontalieri» o «lavoro in Svizzera» sta leggendo questo.',
      title,
      excerpt,
      `Guida pratica per chi vive in Italia e lavora in ${placePhrase(location)}: regole, tasse, cosa cambia sul serio.`,
      `👉 Approfondisci: ${url}`,
    ]),
  ({ title, excerpt, location, url }) =>
    joinBlocks([
      'Tre cose da sapere se sei un frontaliere e cerchi risposte sul lavoro in Svizzera.',
      title,
      excerpt,
      `Niente allarmismo: il quadro utile per ${placePhrase(location)}, scritto in italiano per chi fa il transfrontaliero ogni giorno.`,
      `👉 La guida completa: ${url}`,
    ]),
  ({ title, excerpt, location, url }) =>
    joinBlocks([
      'Aggiornamento per i frontalieri: lavoro in Svizzera, regole italiane.',
      title,
      excerpt,
      `Se lavori in ${placePhrase(location)} — o lo stai valutando — vale la pena leggerlo prima della prossima scadenza.`,
      `👉 ${url}`,
    ]),
  ({ title, excerpt, location, url }) =>
    joinBlocks([
      'Se vivi in Italia e ti occupi di lavoro in Svizzera, questo ti riguarda.',
      title,
      excerpt,
      `Scritto per i frontalieri: linguaggio chiaro, casi concreti, ${placePhrase(location)} incluso.`,
      `👉 Leggi ora: ${url}`,
    ]),
  ({ title, excerpt, location, url }) =>
    joinBlocks([
      "C'è un malinteso ricorrente su questo tema, soprattutto tra chi fa il frontaliere.",
      title,
      excerpt,
      `Lo chiarisco per chi cerca lavoro in Svizzera e vive il quotidiano tra Italia e ${placePhrase(location)}.`,
      `👉 Leggi: ${url}`,
    ]),
  ({ title, excerpt, location, url }) =>
    joinBlocks([
      'Salvalo: è il tipo di articolo che i frontalieri si inoltrano quando arriva la dichiarazione.',
      title,
      excerpt,
      `Lavoro in Svizzera, regole italiane, pratica di ${placePhrase(location)}. Tutto in un posto solo.`,
      `👉 ${url}`,
    ]),
];

const JOB_TEMPLATES = [
  ({ title, excerpt, location, url, companyMention }) =>
    joinBlocks([
      companyMention
        ? `${companyMention} assume: ${title}`
        : `Nuova offerta: ${title}`,
      location ? `📍 ${location}` : '',
      excerpt,
      'Offerta pensata anche per i frontalieri che cercano lavoro in Svizzera. Candidati dalla scheda: requisiti, sede, contratto.',
      `👉 ${url}`,
    ]),
  ({ title, excerpt, location, url, companyMention }) =>
    joinBlocks([
      location
        ? `${location}: c'è una posizione aperta per chi fa il frontaliere.`
        : "C'è una posizione aperta per chi fa il frontaliere.",
      companyMention ? `${title} presso ${companyMention}` : title,
      excerpt,
      `Lavoro in Svizzera${location ? `, in ${location}` : ''}. Guarda l'annuncio completo e candidati.`,
      `👉 ${url}`,
    ]),
  ({ title, excerpt, location, url, companyMention }) =>
    joinBlocks([
      `Cerchi lavoro in Svizzera come ${title}?`,
      [companyMention, location].filter(Boolean).join(' · '),
      excerpt,
      'Annuncio per frontalieri e chi valuta il passo. Dettagli e candidatura nella scheda.',
      `👉 ${url}`,
    ]),
  ({ title, excerpt, location, url, companyMention }) =>
    joinBlocks([
      'Nuova offerta di lavoro in Svizzera.',
      title,
      companyMention ? `Azienda: ${companyMention}` : '',
      location ? `Sede: ${location}` : '',
      excerpt,
      "Se sei un frontaliere, apri la scheda: è il testo dell'annuncio, non un riassunto.",
      `👉 ${url}`,
    ]),
  ({ title, excerpt, location, url, companyMention }) =>
    joinBlocks([
      location
        ? `Candidatura aperta: ${title} a ${location}.`
        : `Candidatura aperta: ${title}.`,
      companyMention
        ? `${companyMention} cerca profili per questa sede. Per i frontalieri che già fanno (o vogliono fare) il lavoro in Svizzera.`
        : 'Per i frontalieri che già fanno (o vogliono fare) il lavoro in Svizzera.',
      excerpt,
      `👉 Invia la candidatura: ${url}`,
    ]),
  ({ title, excerpt, location, url, companyMention }) =>
    joinBlocks([
      `${title} — lavoro in Svizzera per frontalieri.`,
      location ? `Sede: ${location}` : '',
      companyMention ? `Azienda: ${companyMention}` : '',
      excerpt,
      'Requisiti e come candidarsi sono nella scheda.',
      `👉 ${url}`,
    ]),
  ({ title, excerpt, location, url, companyMention }) =>
    joinBlocks([
      location
        ? `Qualcuno nella tua rete sta cercando questo ruolo in ${location}?`
        : 'Qualcuno nella tua rete sta cercando questo ruolo in Svizzera?',
      companyMention ? `${title} da ${companyMention}` : title,
      excerpt,
      'Condividi con chi fa il frontaliere o valuta il lavoro in Svizzera.',
      `👉 Annuncio: ${url}`,
    ]),
];

// ── internals ────────────────────────────────────────────────

function fallbackExcerpt(kind, { location, title }) {
  if (kind === 'job') {
    return location
      ? `Annuncio di lavoro in Svizzera (${location}) per frontalieri. Dettagli, sede e candidatura nella scheda.`
      : 'Annuncio di lavoro in Svizzera per frontalieri. Dettagli e candidatura nella scheda.';
  }
  const topic = title ? ` Tema: ${title}.` : '';
  return location
    ? `Guida pratica per i frontalieri che vivono il lavoro in Svizzera, con il quadro utile per ${placePhrase(location)}.${topic}`
    : `Guida pratica per i frontalieri che vivono il lavoro in Svizzera tra Italia e Canton Ticino.${topic}`;
}

function placePhrase(location) {
  const loc = String(location || '').trim();
  if (!loc) return 'il Canton Ticino';
  if (/^canton\b/i.test(loc)) return loc;
  return loc;
}

function joinBlocks(lines) {
  return lines
    .filter((line) => line !== null && line !== undefined && String(line).trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function withHashtags(body, hashtags) {
  const tags = String(hashtags || '').trim();
  const room = COMMENTARY_MAX - (tags ? tags.length + 2 : 0);
  const trimmed = truncateBody(String(body || '').trim(), Math.max(80, room));
  return tags ? `${trimmed}\n\n${tags}` : trimmed;
}

function hashtagToken(word) {
  const s = stripDiacritics(String(word || '')).replace(/[^a-zA-Z0-9]/g, '');
  return s ? `#${s}` : '';
}

function firstLocationWord(location) {
  const raw = String(location || '').trim();
  if (!raw) return '';
  return raw.split(/[\s,]+/).find((w) => w && !/^canton$/i.test(w)) || '';
}

function metaContent(html, name) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[0]);
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (key === String(name).toLowerCase()) return String(attrs.content || '').trim();
  }
  return '';
}

function parseAttrs(tag) {
  const attrs = {};
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let a;
  while ((a = attrRe.exec(tag))) {
    attrs[String(a[1] || '').toLowerCase()] = a[2] || a[3] || '';
  }
  return attrs;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}
