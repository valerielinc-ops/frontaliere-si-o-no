/**
 * Migros jobs.migros.ch HTML parser.
 *
 * Migros uses a Nuxt.js SSR portal where each job detail page renders
 * five semantic <section> elements:
 *   - overview   — intro paragraph (typo-body1 div) + metadata badges
 *   - tasks      — responsibility grid (text-pretty <p> cards, no <li>)
 *   - skills     — requirement grid (<h4>label</h4><p>detail</p> pairs)
 *   - benefits   — perks grid (<h4>name</h4><p>description</p> pairs)
 *   - recruitment — contact / application info
 *
 * The page also includes a JSON-LD JobPosting but its `description` field
 * contains only the brief overview text. The full structured content lives
 * exclusively in the HTML sections above.
 *
 * This module exports:
 *   extractMigrosStructuredData(html) → MigrosJobData | null
 *   extractMigrosSectionItems(sectionHtml) → string[]
 *   extractMigrosBenefitItems(sectionHtml) → string[]
 *
 * Used by shared-jobs-crawler.mjs to enrich Migros jobs whose JSON-LD
 * description is shorter than the full HTML content.
 */

// ─── Minimal inline utilities ─────────────────────────────────────────────────

function normalizeSpace(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip HTML tags and decode common entities; collapses whitespace.
 */
export function stripHtml(s) {
  return normalizeSpace(
    String(s || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

const MAX_DESC_CHARS = 12000;
const DESCRIPTION_NOISE_PATTERNS = [
  /\bCandidati ora\b.*$/is,
  /\bInvia la tua candidatura\b.*$/is,
  /\bAvvia la candidatura con LinkedIn.*$/is,
  /\bApply now\s*[»>].*$/is,
  /\bJetzt bewerben\s*[»>].*$/is,
  /\bPostuler maintenant\s*[»>].*$/is,
];

function stripDescriptionBoilerplate(text) {
  let t = text;
  for (const re of DESCRIPTION_NOISE_PATTERNS) {
    t = t.replace(re, '');
  }
  return t.trim();
}

/**
 * Convert HTML to a plain-text markdown-ish representation, preserving
 * headings as ## and list items as - bullets.
 */
function htmlToStructuredText(html) {
  if (!html) return '';
  let text = String(html)
    .replace(/<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi, '\n## $1\n')
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return cleanDescription(text);
}

/**
 * Normalize a description: strip HTML, collapse excessive whitespace,
 * remove boilerplate CTA text, and truncate to MAX_DESC_CHARS.
 */
export function cleanDescription(desc) {
  let text = stripHtml(desc);
  text = text
    .replace(/(privacy policy|cookie policy|all rights reserved|accept all cookies|manage preferences)/gi, ' ')
    .replace(/(apply now|candidati ora|learn more|scopri di più)\s*$/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
  text = stripDescriptionBoilerplate(text);
  if (text.length > MAX_DESC_CHARS) text = text.slice(0, MAX_DESC_CHARS).trim();
  return text;
}

// ─── Section item extraction ──────────────────────────────────────────────────

/**
 * Extract text items from a Migros HTML section (tasks or skills).
 *
 * Migros Nuxt renders content as a CSS grid — no <li> tags.
 * Four strategies are tried in order:
 *   1. <h4>label</h4><p>detail</p> pairs  → "label: detail"
 *   2. <p class="text-pretty ...">text</p> → standalone items (tasks)
 *   3. Any remaining <p> not yet captured  → fallback paragraph items
 *   4. Standalone <h4> headings not paired → short label items (e.g. languages)
 *
 * @param {string} sectionHtml - Raw HTML of a single Migros section
 * @returns {string[]} Deduplicated list of item strings
 */
export function extractMigrosSectionItems(sectionHtml) {
  if (!sectionHtml) return [];
  let html = String(sectionHtml);

  // Strip noise before parsing
  html = html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  html = html.replace(/<div[^>]*class="[^"]*tooltip[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  html = html.replace(/<div[^>]*class="[^"]*ad-share-list[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  html = html.replace(/<div[^>]*class="[^"]*flicking[^"]*"[^>]*>[\s\S]*?(?:<\/div>\s*){1,5}/gi, '');
  html = html.replace(/<div[^>]*class="[^"]*rounded-full[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  html = html.replace(/<!--\[?]?-->/g, '');

  const cleanInner = (raw) => stripHtml(raw);
  const items = [];

  // Strategy 1: <h4>label</h4> <p>detail</p> pairs
  const h4pRe = /<h4[^>]*>([\s\S]*?)<\/h4>\s*(?:<!--[^>]*-->)?\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
  let h4m;
  while ((h4m = h4pRe.exec(html)) !== null) {
    const heading = cleanInner(h4m[1]);
    const body = cleanInner(h4m[2]);
    if (heading && body && body.length >= 5) {
      items.push(`${heading}: ${body}`);
    } else if (body && body.length >= 5) {
      items.push(body);
    }
  }

  // Strategy 2: standalone <p class="text-pretty ..."> (tasks section)
  const pPrettyRe = /<p[^>]*class="[^"]*text-pretty[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pPrettyRe.exec(html)) !== null) {
    const text = cleanInner(pm[1]);
    if (text.length >= 10 && !items.includes(text)) {
      items.push(text);
    }
  }

  // Strategy 3: any remaining <p> not already captured
  const pAllRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pa;
  while ((pa = pAllRe.exec(html)) !== null) {
    const text = cleanInner(pa[1]);
    if (text.length >= 10 && !items.some(i => i.includes(text) || text.includes(i))) {
      items.push(text);
    }
  }

  // Strategy 4: standalone <h4> headings not covered by Strategy 1
  const h4Only = /<h4[^>]*>([\s\S]*?)<\/h4>/gi;
  let h4o;
  while ((h4o = h4Only.exec(html)) !== null) {
    const text = cleanInner(h4o[1]);
    if (text.length >= 5 && !items.some(i => i.includes(text))) {
      items.push(text);
    }
  }

  // Filter out generic section headings that are not actual content items
  const headingFilter = /^(mansioni|competenze|mansione principale|compiti principali|compiti|requisiti|cosa offriamo|vantaggi|candidatura e contatto|aufgaben|anforderungen|vorteile|haupt-?aufgabe|main task|tasks|skills|benefits|tâches|exigences)$/i;
  return items.filter(item => !headingFilter.test(item.trim()));
}

/**
 * Extract benefit items as "heading: description" pairs from the benefits section.
 * Benefits use <h4>Title</h4><p>Description</p> card layout.
 *
 * @param {string} sectionHtml - Raw HTML of the benefits section
 * @returns {string[]} List of "BenefitName: description" strings
 */
export function extractMigrosBenefitItems(sectionHtml) {
  if (!sectionHtml) return [];
  let html = String(sectionHtml);
  html = html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  html = html.replace(/<!--\[?]?-->/g, '');

  const items = [];
  const h4pRe = /<h4[^>]*>([\s\S]*?)<\/h4>\s*(?:<!--[^>]*-->)?\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = h4pRe.exec(html)) !== null) {
    const heading = stripHtml(m[1]);
    const body = stripHtml(m[2]);
    if (heading && body && body.length >= 5) {
      items.push(`${heading}: ${body}`);
    } else if (heading && heading.length >= 5) {
      items.push(heading);
    }
  }
  const headingFilter = /^(cosa offriamo|vantaggi|vorteile|benefits|avantages)$/i;
  return items.filter(item => !headingFilter.test(item.trim()));
}

// ─── Main extraction ──────────────────────────────────────────────────────────

/**
 * Extract structured job data from a Migros SSR detail page.
 *
 * Migros job pages have five semantic sections identified by
 * `id="overview|tasks|skills|benefits|recruitment"`. This function
 * parses each section and assembles a full markdown description with
 * structured fields (responsibilities, requirements, benefits).
 *
 * Returns null when the page does not have both a tasks AND a skills
 * section — indicating it is not a Migros job detail page.
 *
 * @param {string} html - Full HTML of the Migros job detail page
 * @returns {MigrosJobData | null}
 *
 * @typedef {Object} MigrosJobData
 * @property {string} description - Full markdown description
 * @property {string} overviewText - Plain text intro paragraph
 * @property {string[]} responsibilities - Task/responsibility items
 * @property {string[]} requirements - Skill/requirement items
 * @property {string[]} benefits - Benefit items
 * @property {string} recruitmentText - Contact/application text
 * @property {string} employmentType - 'permanent' | 'temporary' | ''
 * @property {string} workPercentage - e.g. '80-100%' or ''
 */
export function extractMigrosStructuredData(html) {
  const str = String(html || '');

  const migrosIds = ['overview', 'tasks', 'skills', 'benefits', 'recruitment'];
  const migrosRe = new RegExp(
    '<section\\s+id=["\'](' + migrosIds.join('|') + ')["\'][^>]*>([\\s\\S]*?)</section>',
    'gi'
  );

  const sections = {};
  let m;
  while ((m = migrosRe.exec(str)) !== null) {
    const sid = m[1].toLowerCase();
    let shtml = m[2];
    shtml = shtml.replace(/<svg[\s\S]*?<\/svg>/gi, '');
    shtml = shtml.replace(/<div[^>]*class="[^"]*ad-share-list[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    shtml = shtml.replace(/<div[^>]*class="[^"]*flicking[^"]*"[^>]*>[\s\S]*?(?:<\/div>\s*){1,5}/gi, '');
    sections[sid] = shtml;
  }

  // Need at least tasks OR skills to consider this a Migros detail page
  if (!sections.tasks && !sections.skills) return null;

  // ── Overview ─────────────────────────────────────────────────────────
  let overviewText = '';
  if (sections.overview) {
    const introMatch = sections.overview.match(/<div[^>]*class="[^"]*typo-body1[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    overviewText = htmlToStructuredText(introMatch ? introMatch[1] : sections.overview);
  }

  // ── Responsibilities (tasks section) ─────────────────────────────────
  // Try <li>-based extraction first, then Migros grid-based <p> extraction.
  const tasksText = sections.tasks ? htmlToStructuredText(sections.tasks) : '';
  const responsibilities = [];
  if (tasksText) {
    for (const line of tasksText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        const item = trimmed.slice(2).trim();
        if (item.length >= 10 && !/^(mansione principale|compiti principali|haupt-?aufgabe|main task)$/i.test(item)) {
          responsibilities.push(item);
        }
      }
    }
  }
  if (responsibilities.length === 0 && sections.tasks) {
    for (const item of extractMigrosSectionItems(sections.tasks)) {
      if (item.length >= 10) responsibilities.push(item);
    }
  }
  if (responsibilities.length === 0 && tasksText.length >= 40) {
    for (const p of tasksText.split(/\n{2,}/)) {
      const clean = p.replace(/^##\s*/, '').trim();
      if (clean.length >= 20 && !/^(mansioni|compiti|aufgaben|tasks|tâches)$/i.test(clean)) {
        responsibilities.push(clean);
      }
    }
  }

  // ── Requirements (skills section) ────────────────────────────────────
  const skillsText = sections.skills ? htmlToStructuredText(sections.skills) : '';
  const requirements = [];
  if (skillsText) {
    for (const line of skillsText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        const item = trimmed.slice(2).trim();
        if (item.length >= 5) requirements.push(item);
      }
    }
  }
  if (requirements.length === 0 && sections.skills) {
    for (const item of extractMigrosSectionItems(sections.skills)) {
      if (item.length >= 5) requirements.push(item);
    }
  }
  if (requirements.length === 0 && skillsText.length >= 40) {
    for (const p of skillsText.split(/\n{2,}/)) {
      const clean = p.replace(/^##\s*/, '').trim();
      if (clean.length >= 10 && !/^(competenze|requisiti|anforder|requirements|exigences)$/i.test(clean)) {
        requirements.push(clean);
      }
    }
  }

  // ── Benefits ─────────────────────────────────────────────────────────
  const benefitsText = sections.benefits ? htmlToStructuredText(sections.benefits) : '';
  const benefits = [];
  if (benefitsText) {
    for (const line of benefitsText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        const item = trimmed.slice(2).trim();
        if (item.length >= 5) benefits.push(item);
      }
    }
  }
  if (benefits.length === 0 && sections.benefits) {
    for (const item of extractMigrosBenefitItems(sections.benefits)) {
      if (item.length >= 5) benefits.push(item);
    }
  }
  if (benefits.length === 0 && benefitsText.length >= 40) {
    for (const p of benefitsText.split(/\n{2,}/)) {
      const clean = p.replace(/^##\s*/, '').trim();
      if (clean.length >= 10 && !/^(cosa offriamo|vantaggi|vorteile|benefits)$/i.test(clean)) {
        benefits.push(clean);
      }
    }
  }

  // ── Recruitment / contact ─────────────────────────────────────────────
  const recruitmentText = sections.recruitment ? htmlToStructuredText(sections.recruitment) : '';

  // ── Employment type and work percentage from overview ─────────────────
  const overviewHtml = sections.overview || '';
  let employmentType = '';
  let workPercentage = '';
  const empMatch = overviewHtml.match(/(?:impiego\s+fisso|unbefristet|permanent|emploi fixe|indeterminato)/i);
  const tempMatch = overviewHtml.match(/(?:temporaneo|befristet|temporary|temporaire|determinato)/i);
  if (empMatch) employmentType = 'permanent';
  else if (tempMatch) employmentType = 'temporary';
  const pctMatch = overviewHtml.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  const pctSingle = overviewHtml.match(/(\d{2,3})\s*%/);
  if (pctMatch) workPercentage = `${pctMatch[1]}-${pctMatch[2]}%`;
  else if (pctSingle) workPercentage = `${pctSingle[1]}%`;

  // ── Compose full description ──────────────────────────────────────────
  const parts = [];
  if (overviewText) parts.push(overviewText);
  if (responsibilities.length > 0) {
    parts.push(`## Mansioni\n${responsibilities.map(r => `- ${r}`).join('\n')}`);
  } else if (tasksText) {
    parts.push(`## Mansioni\n${tasksText.replace(/^##\s*Mansioni?\s*/i, '').trim()}`);
  }
  if (requirements.length > 0) {
    parts.push(`## Requisiti\n${requirements.map(r => `- ${r}`).join('\n')}`);
  } else if (skillsText) {
    parts.push(`## Requisiti\n${skillsText.replace(/^##\s*(?:Competenze|Requisiti)\s*/i, '').trim()}`);
  }
  if (benefits.length > 0) {
    parts.push(`## Cosa offriamo\n${benefits.map(b => `- ${b}`).join('\n')}`);
  } else if (benefitsText) {
    parts.push(`## Cosa offriamo\n${benefitsText.replace(/^##\s*Cosa offriamo\s*/i, '').trim()}`);
  }
  if (recruitmentText && recruitmentText.length >= 20) {
    parts.push(`## Contatto\n${recruitmentText.replace(/^##\s*(?:Candidatura|Contatto|Kontakt|Contact)\s*/i, '').trim()}`);
  }
  if (workPercentage) {
    parts.push(`**Grado di occupazione:** ${workPercentage}`);
  }

  const fullDescription = parts.join('\n\n');

  return {
    description: fullDescription,
    overviewText,
    responsibilities,
    requirements,
    benefits,
    recruitmentText,
    employmentType,
    workPercentage,
  };
}
