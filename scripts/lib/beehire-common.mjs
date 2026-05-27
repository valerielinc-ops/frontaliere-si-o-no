#!/usr/bin/env node
/**
 * Shared helpers for Beehire-hosted careers pages.
 *
 * Beehire (https://beehire.com) is a Belgian ATS used by several Swiss
 * healthcare employers, including Hôpital de Lavaux (Cully VD).
 *
 * Public JSON endpoint:
 *   https://app.beehire.com/users/getPublicCampaigns/<slug>
 *
 * Response shape:
 *   {
 *     "campaigns": [
 *       {
 *         "_id": "6a0c4191324dedaba67d5a74",
 *         "title": { "1": "Cuisinier·ère à 100%" },   // language→text map (1=fr)
 *         "description": { "1": "<p>...HTML...</p>" },
 *         "language": 1,
 *         "inviteLink": "https://app.beehire.com/invite/5iqaw5F9q",
 *         "location": {
 *           "name": "Cully, Bourg-en-Lavaux, Suisse",
 *           "city": "Bourg-en-Lavaux",
 *           "state": "VD",
 *           "country": "Suisse"
 *         },
 *         "details": {
 *           "contract": {
 *             "duration": "contractDuration_fullTime",
 *             "type": "contractType_permanent" | "contractType_fixedTerm" | ...,
 *             "remote": "remoteWork_none"
 *           },
 *           "vacanciesNumber": 1
 *         },
 *         "jobCategories": []
 *       },
 *       ...
 *     ],
 *     "user": { "_id": ..., "companyDescription": {...}, "address": {...} }
 *   }
 */
import {
  htmlToText,
  normalizeSpace,
} from './hospital-custom-html-helpers.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

export async function fetchBeehireCampaigns(slug) {
  const url = `https://app.beehire.com/users/getPublicCampaigns/${encodeURIComponent(slug)}`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const data = await res.json();
    return Array.isArray(data?.campaigns) ? data.campaigns : [];
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/** Pick a translation by language priority (Beehire stores them in numeric keys). */
export function pickBeehireTranslation(field = {}, preferredLangIds = [1, 0, 2, 3, 4, 5, 6]) {
  if (!field || typeof field !== 'object') return '';
  for (const id of preferredLangIds) {
    const v = field[id] ?? field[String(id)];
    if (v && String(v).trim()) return String(v);
  }
  // Fallback: first non-empty value
  for (const k of Object.keys(field)) {
    const v = field[k];
    if (v && String(v).trim()) return String(v);
  }
  return '';
}

export function beehireDescriptionToText(htmlOrField) {
  const html = typeof htmlOrField === 'string' ? htmlOrField : pickBeehireTranslation(htmlOrField);
  if (!html) return '';
  return htmlToText(html).trim();
}

/** Map Beehire contract type tokens to our 'full-time'|'temporary' strings. */
export function mapBeehireContract(token = '') {
  const t = String(token || '').toLowerCase();
  if (t.includes('fixedterm') || t.includes('temporary') || t.includes('cdd') || t.includes('interim')) {
    return 'temporary';
  }
  return 'full-time';
}

/** Map Beehire duration token ('contractDuration_fullTime'|'_partTime') to FULL_TIME/PART_TIME. */
export function mapBeehireEmploymentType(token = '') {
  const t = String(token || '').toLowerCase();
  if (t.includes('parttime') || t.includes('partial')) return 'PART_TIME';
  if (t.includes('fulltime')) return 'FULL_TIME';
  return 'OTHER';
}

export function beehireTitle(campaign, preferredLangIds) {
  return normalizeSpace(pickBeehireTranslation(campaign?.title || {}, preferredLangIds));
}

export function beehireLocationCity(campaign) {
  const loc = campaign?.location || {};
  return normalizeSpace(loc.city || loc.name || '');
}
