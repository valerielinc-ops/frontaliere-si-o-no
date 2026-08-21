/**
 * Generic vacancy extraction — the part that lets a crawler exist before anyone
 * has written a parser for it.
 *
 * A cascade, best evidence first. Every rung yields the same normalised shape,
 * so the caller never branches on which one fired:
 *
 *   1. JSON-LD `JobPosting`        — schema.org, authored by the site itself.
 *   2. Microdata `itemtype=JobPosting` — same contract, older syntax.
 *   3. Path-template clustering    — no structured data at all: infer the
 *      listing from the shape of the links. This is the rung that reads the
 *      long tail, where a micro-employer's ATS emits plain HTML.
 *
 * Rung 3 is the interesting one. On a vacancy index every job link shares a URL
 * template (`/annunci-lavoro/<slug>-<id>.htm`) while navigation links do not, so
 * clustering links by template and taking the largest job-ish cluster recovers
 * the listing without knowing anything about the vendor. It degrades honestly:
 * a page with no repeated template yields nothing rather than yielding noise.
 */
import { normalizeHost } from './registrable.mjs';

/** Tokens that mark a URL path or heading as vacancy-related, all four locales. */
const VACANCY_PATH_RX =
  /(annunci|offerte|posizioni|posti|lavoro|lavora|carrier|job|jobs|stelle|stellen|karriere|vacan|emploi|poste|career|opportunit|apply|bewerb|candidat|recruit|ausschreib|offene)/i;

/** Words that appear on a page listing vacancies but rarely elsewhere. */
const VACANCY_TEXT_RX =
  /(posizioni aperte|offerte di lavoro|annunci di lavoro|lavora con noi|posti vacanti|candidati ora|invia (?:il tuo )?cv|offene stellen|stellenangebote|jetzt bewerben|freie stellen|offres d'emploi|postes vacants|postuler|rejoignez|open positions|current openings|apply now|job openings|we are hiring)/i;

/**
 * Strip tags and collapse whitespace.
 * @param {string} html
 * @returns {string}
 */
export function textOf(html = '') {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * All JSON-LD blocks in a document, flattened through `@graph`.
 * Malformed blocks are skipped — SME sites ship broken JSON-LD routinely and one
 * bad block must not cost the whole page.
 *
 * @param {string} html
 * @returns {any[]}
 */
export function jsonLdBlocks(html = '') {
  const out = [];
  const rx = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim().replace(/^﻿/, '')); } catch { continue; }
    const push = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(push); return; }
      out.push(node);
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(push);
    };
    push(parsed);
  }
  return out;
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isJobPostingNode(node) {
  const t = node?.['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => String(x || '').toLowerCase() === 'jobposting');
}

/** @param {any} v @returns {string} */
function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (v && typeof v === 'object') return firstString(v.name || v['@value'] || v.value || '');
  return '';
}

/**
 * Normalised vacancy record. Field names mirror the ones the site's job
 * pipeline already uses, so a synthesised crawler needs no translation layer.
 *
 * @typedef {Object} Vacancy
 * @property {string} title
 * @property {string} url
 * @property {string} [company]
 * @property {string} [location]
 * @property {string} [description]
 * @property {string} [postedDate]
 * @property {string} [employmentType]
 * @property {'jsonld'|'microdata'|'template'} via
 */

/**
 * @param {string} html
 * @param {string} pageUrl
 * @returns {Vacancy[]}
 */
export function extractJsonLd(html, pageUrl) {
  const out = [];
  for (const node of jsonLdBlocks(html)) {
    if (!isJobPostingNode(node)) continue;
    const loc = node.jobLocation;
    const addr = (Array.isArray(loc) ? loc[0] : loc)?.address;
    out.push({
      title: firstString(node.title) || firstString(node.name),
      url: firstString(node.url) || firstString(node.sameAs) || pageUrl,
      company: firstString(node.hiringOrganization),
      location: [firstString(addr?.addressLocality), firstString(addr?.addressRegion)].filter(Boolean).join(', '),
      description: textOf(firstString(node.description)).slice(0, 8000),
      postedDate: firstString(node.datePosted),
      employmentType: firstString(node.employmentType),
      via: 'jsonld',
    });
  }
  return out.filter((v) => v.title);
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @returns {Vacancy[]}
 */
export function extractMicrodata(html, pageUrl) {
  const out = [];
  const rx = /<([a-z0-9]+)\b[^>]*itemtype\s*=\s*["'][^"']*schema\.org\/JobPosting["'][^>]*>([\s\S]{0,20000}?)<\/\1>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const block = m[2];
    const prop = (name) => {
      const p = new RegExp(`itemprop\\s*=\\s*["']${name}["'][^>]*>([\\s\\S]{0,2000}?)<`, 'i').exec(block);
      const content = new RegExp(`itemprop\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i').exec(block);
      return (content?.[1] || textOf(p?.[1] || '')).trim();
    };
    const title = prop('title') || prop('name');
    if (!title) continue;
    const href = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(block)?.[1];
    let url = pageUrl;
    try { if (href) url = new URL(href, pageUrl).toString(); } catch { /* keep page url */ }
    out.push({
      title,
      url,
      company: prop('hiringOrganization'),
      location: prop('addressLocality') || prop('jobLocation'),
      description: textOf(prop('description')).slice(0, 8000),
      postedDate: prop('datePosted'),
      employmentType: prop('employmentType'),
      via: 'microdata',
    });
  }
  return out;
}

/**
 * Collapse a URL path into a template: digits -> `#`, long slug segments -> `*`.
 * Two vacancy URLs from the same listing collapse to the same template; a
 * vacancy URL and an "About us" URL do not.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function pathTemplate(pathname = '') {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      if (/^\d+$/.test(seg)) return '#';
      // A segment mixing words and a long number is a slug+id — the dominant
      // vacancy-URL shape (`Ocean-Freight-Operations-662670289.htm`).
      if (/\d{4,}/.test(seg)) return '*';
      if (seg.length > 24 || (seg.match(/-/g) || []).length >= 3) return '*';
      return seg.toLowerCase();
    })
    .join('/');
}

/**
 * Infer a vacancy listing from link shape alone.
 *
 * @param {{ url: string, text: string }[]} links
 * @param {string} pageUrl
 * @returns {Vacancy[]}
 */
export function extractByTemplate(links, pageUrl) {
  const host = normalizeHost(new URL(pageUrl).hostname);
  /** @type {Map<string, { url: string, text: string }[]>} */
  const clusters = new Map();
  for (const l of links) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (normalizeHost(u.hostname) !== host) continue;
    const path = decodeURIComponent(u.pathname);
    if (path === '/' || path.length < 4) continue;
    const tpl = pathTemplate(path);
    // A template with no variable part is navigation, not a listing.
    if (!tpl.includes('*') && !tpl.includes('#')) continue;
    if (!clusters.has(tpl)) clusters.set(tpl, []);
    clusters.get(tpl).push(l);
  }
  let best = null;
  for (const [tpl, items] of clusters) {
    if (items.length < 2) continue;
    const jobish = VACANCY_PATH_RX.test(tpl) ? 2 : 0;
    const titled = items.filter((i) => i.text && i.text.length > 8).length / items.length;
    const score = jobish + titled + Math.min(items.length, 30) / 30;
    if (!best || score > best.score) best = { tpl, items, score, jobish };
  }
  // Without a vacancy-ish path token the cluster is just as likely to be a news
  // archive, so refuse it rather than publish a blog as jobs.
  if (!best || !best.jobish) return [];
  return best.items.map((i) => ({
    title: (i.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    url: i.url,
    via: 'template',
  })).filter((v) => v.title.length > 3);
}

/**
 * How strongly does this page read as a vacancy page?
 * Used to verify a third-party host really is where the vacancies live before
 * the registry records it as a platform.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ url: string, text: string }[]} [links]
 * @returns {{ score: number, signals: string[], vacancies: Vacancy[] }}
 */
export function scoreVacancyPage(html, pageUrl, links = []) {
  const signals = [];
  let score = 0;
  const jsonld = extractJsonLd(html, pageUrl);
  if (jsonld.length) { score += 5; signals.push(`jsonld:${jsonld.length}`); }
  const micro = jsonld.length ? [] : extractMicrodata(html, pageUrl);
  if (micro.length) { score += 4; signals.push(`microdata:${micro.length}`); }
  const tpl = jsonld.length || micro.length ? [] : extractByTemplate(links, pageUrl);
  if (tpl.length) { score += 2 + Math.min(tpl.length, 10) / 10; signals.push(`template:${tpl.length}`); }

  const text = textOf(html);
  if (VACANCY_TEXT_RX.test(text)) { score += 2; signals.push('vacancy-copy'); }
  let p = '';
  try { p = decodeURIComponent(new URL(pageUrl).pathname); } catch { /* ignore */ }
  if (VACANCY_PATH_RX.test(p)) { score += 1; signals.push('vacancy-path'); }
  if (/<form\b[^>]*>[\s\S]{0,4000}?(cv|curriculum|bewerbung|candidatur|resume)/i.test(html)) {
    score += 1; signals.push('apply-form');
  }
  return { score, signals, vacancies: jsonld.length ? jsonld : (micro.length ? micro : tpl) };
}

/**
 * Full cascade against a fetched page.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ url: string, text: string }[]} links
 * @returns {{ vacancies: Vacancy[], via: string }}
 */
export function extractVacancies(html, pageUrl, links = []) {
  const jsonld = extractJsonLd(html, pageUrl);
  if (jsonld.length) return { vacancies: jsonld, via: 'jsonld' };
  const micro = extractMicrodata(html, pageUrl);
  if (micro.length) return { vacancies: micro, via: 'microdata' };
  const tpl = extractByTemplate(links, pageUrl);
  return { vacancies: tpl, via: tpl.length ? 'template' : 'none' };
}
