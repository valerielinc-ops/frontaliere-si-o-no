#!/usr/bin/env node
/**
 * Shared helpers for "eRecruit" (lumesse / SAP SuccessFactors-style minimal ATS)
 * sites that publish a public job feed at `/rss.php` and detail pages at
 * `/?page=advertisement_display&id=N`.
 *
 * Confirmed users (May 2026):
 *   - Clinique de La Source, Lausanne (emploi.lasource.ch)
 *   - Hôpital ophtalmique Jules-Gonin / Fondation Asile des aveugles,
 *     Lausanne (emploi.ophtalmique.ch)
 *
 * Feed structure (RSS 2.0):
 *   <item>
 *     <title/>                              ← always empty
 *     <JobID>1789</JobID>
 *     <BasePayMin/>... <Location/>          ← always empty in practice
 *     <link>http://.../?page=advertisement_display&amp;id=1789</link>
 *   </item>
 *
 * Detail page (HTML) structure:
 *   <meta property="og:title" content="Job Title"/>
 *   <div class="title-container"> <h2>Job Title</h2> </div>
 *   <div id="advert"> {body wysiwyg-HTML} </div>
 */
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  USER_AGENT,
} from './hospital-custom-html-helpers.mjs';

// eRecruit hosts (Apache + custom CGI) reset the connection if the Accept
// header advertises "application/rss+xml" with wildcard fallback. Use a
// strict Accept negotiated per call.
async function fetchErecruitText(url, accept) {
  const t = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch the eRecruit RSS feed. Caller passes the absolute /rss.php URL.
 */
export async function fetchErecruitRss(rssUrl) {
  return fetchErecruitText(rssUrl, 'application/rss+xml,application/xml,text/xml');
}

/** Parse RSS feed and extract the list of {id, link} pairs. */
export function parseErecruitRss(xml) {
  const out = [];
  const seen = new Set();
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml))) {
    const body = m[1];
    const idMatch = body.match(/<JobID>([^<]+)<\/JobID>/);
    const linkMatch = body.match(/<link>([^<]+)<\/link>/);
    if (!idMatch || !linkMatch) continue;
    const id = normalizeSpace(idMatch[1]);
    const link = decodeEntities(normalizeSpace(linkMatch[1]));
    if (!id || !link || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, link });
  }
  return out;
}

/**
 * Fetch and parse one advertisement_display detail page.
 *
 * @returns {{title: string, description: string} | null}
 */
export async function fetchErecruitDetail(detailUrl) {
  let html;
  try {
    html = await fetchErecruitText(detailUrl, 'text/html');
  } catch {
    return null;
  }
  // Title resolution order:
  //   1. <h2> inside the page's ".title-container" — always clean.
  //   2. og:title — but some eRecruit instances prefix the site name
  //      ("Site Name | Nos offres - <real title>"). Strip that prefix.
  let title = '';
  const h2Match = html.match(/<div class="title-container">[\s\S]*?<h2>([\s\S]*?)<\/h2>/);
  if (h2Match) title = normalizeSpace(decodeEntities(h2Match[1].replace(/<[^>]+>/g, '')));
  if (!title) {
    const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (ogTitleMatch) {
      let raw = decodeEntities(normalizeSpace(ogTitleMatch[1]));
      // Drop trailing site label patterns like "Site | Nos offres - <real>"
      // or "Site Name - <real>" by keeping the segment after the last
      // " - " separator IFF the prefix part contains "Nos offres" or "|".
      const dashIdx = raw.lastIndexOf(' - ');
      if (dashIdx > -1) {
        const prefix = raw.slice(0, dashIdx);
        if (/\|/.test(prefix) || /nos\s+offres/i.test(prefix) || /career/i.test(prefix)) {
          raw = raw.slice(dashIdx + 3).trim();
        }
      }
      title = raw;
    }
  }
  if (!title) return null;

  // Body: <div id="advert"> ... </div>
  let description = '';
  const advertMatch = html.match(/<div\s+id="advert"[^>]*>([\s\S]*?)(<\/main>|<\/div>\s*<\/div>\s*<\/main>|<aside)/i);
  if (advertMatch) {
    description = htmlToText(advertMatch[1]).trim();
  } else {
    // Fallback: scan all <p>/<li>/<h3> elements outside script/style.
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '');
    description = htmlToText(stripped).trim();
  }
  // Keep only useful prose: strip the leading nav crumbs and trailing apply boilerplate.
  description = description.replace(/\n{3,}/g, '\n\n').trim();
  return { title, description };
}
