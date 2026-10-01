import { decode as decodeHTML } from 'html-entities';
import { workloadPercent } from './dedicated-crawler-common.mjs';
import { extractBalancedTagBlock, locateTagByAttribute } from './hospital-custom-html-helpers.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

const CATEGORY_BY_KEY = {
  production: 'engineering',
  engineering: 'engineering',
  'mkt-communication': 'sales',
  'event-travel': 'admin',
  finance: 'finance',
  it: 'tech',
  'r-d': 'engineering',
  operations: 'engineering',
  'quality-assurance': 'engineering',
  regulatory: 'health',
  'medical-affairs': 'health',
  'general-services': 'admin',
  hr: 'admin',
  sales: 'sales',
};

function normalizeText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function decodeHtmlEntities(value = '') {
  return decodeHTML(String(value || ''), { scope: 'strict' }).replaceAll('\u00a0', ' ');
}

export function inferMedactaCategory({ category = '', categoryLabel = '', title = '', jobCategory = '' } = {}) {
  const roleHint = normalizeText(`${title} ${jobCategory}`);

  if (/(web developer|software|sistemista|devops|cloud|robotics|c\+\+|programmat|it )/.test(roleHint)) return 'tech';
  if (/(manutent|mainten|elettro|mechanic|tecnic|fresator|tornitor|operatore|production|quality|operations|r d|research|sviluppo|ingegner|engineer)/.test(roleHint)) return 'engineering';
  if (/(medical|clinical|health|medic|orthopedic|orthopaedic|regulatory|medical affairs)/.test(roleHint)) return 'health';
  if (/(finance|account|audit|treasury|contabil|controll)/.test(roleHint)) return 'finance';
  if (/(sales|marketing|commercial|product manager|business development|communication)/.test(roleHint)) return 'sales';
  if (/(hr|human resources|recruit|talent|admin|amministr|servizi general|event|travel)/.test(roleHint)) return 'admin';

  const key = normalizeKey(category || categoryLabel).replace(/_/g, '-');
  if (CATEGORY_BY_KEY[key]) return CATEGORY_BY_KEY[key];

  return 'other';
}

export function inferMedactaContract({ rawContract = '', title = '', description = '', jobCategory = '' } = {}) {
  const text = `${String(rawContract || '')} ${String(title || '')} ${String(description || '')} ${String(jobCategory || '')}`;
  const norm = normalizeText(text);

  // Same class as #3482: range-aware, source-precedence workload extraction
  // (shared helper) — a marketing percent in the description must never
  // override an explicit workload in rawContract/title.
  let percent = NaN;
  for (const source of [rawContract, title, description, jobCategory]) {
    percent = workloadPercent(String(source || ''));
    if (Number.isFinite(percent)) break;
  }
  if (Number.isFinite(percent) && percent > 0 && percent < 90) return 'part-time';

  if (/\b(thesis|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|internship|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|tirocin|apprendist|praktikum)/.test(norm)) return 'internship';
  if (/(part time|tempo parziale|teilzeit|temps partiel)/.test(norm)) return 'part-time';
  if (/(temp|temporary|determinato|fixed term|befristet)/.test(norm)) return 'temporary';
  if (/(contractor|freelance|consul|progetto|projektvertrag|contract)/.test(norm)) return 'contract';
  if (/(permanent|indeterminato|full time|vollzeit|temps plein|fulltime)/.test(norm)) return 'full-time';

  return 'full-time';
}

/**
 * The role text of an Allibo detail page lives in the schema.org microdata
 * block `<div itemprop="description">` (tasks, profile, offer, EEO note).
 * The crawler used to read only `og:description` — the one-line teaser
 * "Lavora con noi! Medacta International SA sta cercando <title> su Ticino" —
 * and then published a category TEMPLATE (identical maintenance tasks for a
 * Demand Planner and for an electromechanic) instead of the vacancy. Probed
 * 2026-09-29: the page is served to our fetcher without any CAPTCHA.
 *
 * A paragraph that holds only a short bold label (`<p><b>Hard Skills</b></p>`,
 * `<p><strong>What we offer:</strong></p>`) is the source's section title and
 * becomes a markdown heading; list items become `- ` bullets.
 *
 * @param {string} html detail page
 * @returns {string} markdown, '' when the block is absent
 */
export function extractMedactaDetailMarkdown(html = '') {
  const located = locateTagByAttribute(String(html || ''), `itemprop=["']description["']`, { skipVoidTags: true });
  if (!located) return '';
  const inner = extractBalancedTagBlock(located.rest, located.tagName, 80000);
  const text = inner
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(
      /<p[^>]*>(?:\s|&nbsp;|<span[^>]*>|<\/span>)*<(b|strong)[^>]*>([\s\S]{2,80}?)<\/\1>(?:\s|&nbsp;|<span[^>]*>|<\/span>|<br\s*\/?>)*<\/p>/gi,
      (_m, _tag, label) => `\n\n## ${label.replace(/<[^>]+>/g, ' ').replace(/[\s:]+$/, '')}\n\n`,
    )
    .replace(/<h[1-6][^>]*>/gi, '\n\n## ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|ul|ol)[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  const lines = decodeHtmlEntities(text)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '-' && !/^##\s*$/.test(line));
  // One blank line between blocks, none between the items of one list.
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1] || '';
    const next = lines.slice(i + 1).find(Boolean) || '';
    if (!prev || prev === '' || (prev.startsWith('- ') && next.startsWith('- '))) continue;
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Opening headings of the category template earlier runs published when the
// vacancy body was not read (same tasks for every role of a category). The
// generator is gone; the headings stay only to recognise that text in stored
// records, so it is never kept, merged or translated.
const TEMPLATE_OVERVIEW_HEADINGS = [
  '## Panoramica Ruolo',
  '## Role Overview',
  '## Rollenubersicht',
  '## Apercu Du Poste',
];

/**
 * True for a description written by the retired category template. Such text
 * is invented, not the source's: it must never be published or translated.
 */
export function isMedactaTemplateDescription(text = '') {
  const head = String(text || '').trimStart();
  return TEMPLATE_OVERVIEW_HEADINGS.some((heading) => head.startsWith(heading));
}

/** `source` of a job whose description is the vacancy body of the detail page. */
export const MEDACTA_DETAIL_SOURCE = 'Allibo ATS detail page';

/**
 * True when the job carries the real vacancy body read from the detail page
 * (as opposed to the retired category template).
 */
export function isMedactaDetailBacked(job = {}, clean = (text) => text) {
  if (job?.source !== MEDACTA_DETAIL_SOURCE) return false;
  const base = String(clean(String(job?.description || '')) || '').trim();
  return meetsSourceBodyFloor(base) && !isMedactaTemplateDescription(base);
}

/**
 * Locale slots of a detail-backed job: the template text written by earlier
 * runs is dropped (so the translation step regenerates the locale from the
 * real body) and the source-language slot is the body itself.
 */
export function detailBackedMedactaLocales(job = {}, clean = (text) => text) {
  const base = String(clean(String(job?.description || '')) || '').trim();
  const out = {};
  for (const [locale, value] of Object.entries(job?.descriptionByLocale || {})) {
    const text = String(clean(String(value || '')) || '').trim();
    if (text && !isMedactaTemplateDescription(text)) out[locale] = text;
  }
  if (job?.sourceLang) out[job.sourceLang] = base;
  return out;
}

/**
 * What a run does with one Allibo vacancy, given the body read this run
 * (`detailMarkdown`, '' when the page failed) and the stored record, if any:
 *  - 'detail': publish the body just read;
 *  - 'keep':   no body this run, but the stored record carries a body read
 *              from the source on an earlier run — keep it untouched;
 *  - 'drop':   no source text at all — the job is not published this run.
 *              There is no fallback text: publishing one would be invented.
 */
export function resolveMedactaDescriptionAction({ detailMarkdown = '', existing = null, clean = (text) => text } = {}) {
  if (meetsSourceBodyFloor(detailMarkdown)) return 'detail';
  if (existing && isMedactaDetailBacked(existing, clean)) return 'keep';
  return 'drop';
}
