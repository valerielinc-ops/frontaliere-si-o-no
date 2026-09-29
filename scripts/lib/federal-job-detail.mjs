/**
 * Role sections of a jobs.admin.ch vacancy page (Stellenportal Bund,
 * Prospective medium 1000624) that neither the Prospective API nor the
 * page's JSON-LD `description` carry.
 *
 * The API/JSON-LD give tasks, requirements, benefits and the unit profile.
 * The page adds, in the posting's own language:
 *   - `section#whatElse` — "Auf den Punkt gebracht" / "En bref" / "In breve":
 *     the role summary, often the longest per-vacancy paragraph (up to ~1000
 *     characters);
 *   - `section.information` — start date, contract type, reference, workplace;
 *   - `section#additionalAbout` — "Zusätzliche Informationen" (start date
 *     notes, home-office rules, required security checks);
 *   - bare `<section><p>` notes after it (the under-representation note that
 *     invites applications from women).
 * Published descriptions without them were 23-35 % of the detail page for
 * the Confederation feed and 35-44 % for the armed forces (audit run
 * 36528331656).
 *
 * The page renders several blocks twice (desktop/print/mobile); every
 * selector below picks the screen copy once.
 */
import { JSDOM } from 'jsdom';
import { decodeHtmlEntities } from './decode-html-entities.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

// Paragraph text with `<br>` kept as line breaks.
function blockText(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
  return String(clone.textContent || '')
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .join('\n');
}

function sectionBody(section) {
  if (!section) return '';
  return [...section.querySelectorAll('p')]
    .map((p) => blockText(p))
    .filter(Boolean)
    .join('\n\n');
}

function sectionHeading(section) {
  return normalizeSpace(section?.querySelector('h2')?.textContent || '');
}

/**
 * Prospective rich text (API `sza_*` fields, JSON-LD `description`) → the
 * pipeline's markdown. The JSON-LD wraps each block as
 * `<p><div>Heading</div><br><ul>…</ul></p>`; the `<div>` line is the block's
 * heading on the page ("Diesen Beitrag können Sie leisten", "Das bieten wir").
 * Benefit items lead with a bold title that becomes "Title: text". Links
 * ("Alle Benefits") are navigation, not content.
 */
export function federalRichTextToMarkdown(html = '') {
  const text = String(html || '')
    .replace(/\s+/g, ' ')
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, (_, heading) => {
      const clean = normalizeSpace(heading.replace(/<[^>]+>/g, ''));
      return clean ? `\n\n## ${clean}\n\n` : '\n\n';
    })
    .replace(/<li[^>]*>\s*<(b|strong)>([\s\S]*?)<\/\1>\s*/gi, (_, _tag, lead) => `\n- ${normalizeSpace(lead.replace(/<[^>]+>/g, ''))}: `)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(text)
    .split('\n')
    .map((line) => normalizeSpace(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The vacancy text the Prospective API carries when the detail page (and its
 * JSON-LD headings) is unavailable: tasks, requirements, benefits and the
 * administrative unit's profile, in page order.
 */
export function federalApiDescription(szas = {}) {
  return ['sza_tasks', 'sza_requirements', 'sza_benefits', 'sza_company_profil']
    .map((field) => federalRichTextToMarkdown(szas?.[field] || ''))
    .filter(Boolean)
    .join('\n\n');
}

function readJsonLdDescription(document) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      const posting = nodes.find((node) => node?.['@type'] === 'JobPosting');
      if (posting?.description) return String(posting.description);
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return '';
}

/**
 * @param {string} html detail page
 * @returns {{
 *   roleText: string,
 *   summaryHeading: string, summary: string,
 *   facts: Array<{ label: string, value: string }>,
 *   additionalHeading: string, additional: string,
 *   notes: string[],
 * }}
 */
export function parseFederalJobDetailExtras(html = '') {
  const document = new JSDOM(String(html || '')).window.document;
  const main = document.querySelector('main#home') || document.body;

  const summarySection = [...main.querySelectorAll('section#whatElse')]
    .find((node) => !node.classList.contains('printOnly'));
  const infoSection = main.querySelector('section.information.desktopOnly')
    || main.querySelector('section.information');
  const facts = infoSection
    ? [...infoSection.querySelectorAll('.item')]
      .map((item) => ({
        label: normalizeSpace(item.querySelector('label')?.textContent || '').replace(/:$/, ''),
        value: normalizeSpace(item.querySelector('span')?.textContent || ''),
      }))
      .filter((fact) => fact.label && fact.value)
    : [];
  const additionalSection = main.querySelector('section#additionalAbout');
  // Bare sections (no id, no class) holding only paragraphs: the vacancy
  // notes. The title block is a bare section too, but it carries the h1.
  const notes = [...main.querySelectorAll('section:not([id]):not([class])')]
    .filter((node) => !node.querySelector('h1, h2, h3, ul, ol, form, a[href]'))
    .map((node) => sectionBody(node))
    .filter(Boolean);

  return {
    // Tasks, requirements, benefits and unit profile with the page's own
    // headings — the same content as the API fields, in the page language.
    roleText: federalRichTextToMarkdown(readJsonLdDescription(document)),
    summaryHeading: sectionHeading(summarySection),
    summary: sectionBody(summarySection),
    facts,
    additionalHeading: sectionHeading(additionalSection),
    additional: sectionBody(additionalSection),
    notes: [...new Set(notes)],
  };
}

function containsText(haystack, needle) {
  const norm = (value) => normalizeSpace(value).toLowerCase();
  return Boolean(needle) && norm(haystack).includes(norm(needle));
}

/**
 * `base` (API or JSON-LD role text) plus the page-only sections: the summary
 * first — it is the posting's own pitch and tells otherwise identical task
 * lists apart — then the key facts the page shows under the title (start
 * date, contract, reference, workplace), base, additional information and
 * notes. A section whose text `base` already contains is not added again, so
 * the function is idempotent on its own output.
 */
export function composeFederalJobDescription(base = '', extras = null) {
  const body = String(base || '').trim();
  if (!extras) return body;
  const parts = [];
  if (extras.summary && !containsText(body, extras.summary)) {
    parts.push(extras.summaryHeading ? `## ${extras.summaryHeading}\n\n${extras.summary}` : extras.summary);
  }
  const facts = (extras.facts || [])
    .filter((fact) => !containsText(body, `${fact.label}: ${fact.value}`))
    .map((fact) => `- ${fact.label}: ${fact.value}`);
  if (facts.length) parts.push(facts.join('\n'));
  if (body) parts.push(body);
  if (extras.additional && !containsText(body, extras.additional)) {
    parts.push(extras.additionalHeading ? `## ${extras.additionalHeading}\n\n${extras.additional}` : extras.additional);
  }
  for (const note of extras.notes || []) {
    if (!containsText(body, note)) parts.push(note);
  }
  return parts.join('\n\n');
}
