/**
 * SBB (FFS – Ferrovie Federali Svizzere) detail page parser
 *
 * jobs.sbb.ch/v2/offene-stellen/{slug}/{uuid} pages are SSR pages backed by
 * SAP SuccessFactors. They contain both:
 *
 *   1. A schema.org/JobPosting JSON-LD block — description field is a short
 *      teaser (intro paragraph only), not the full vacancy body.
 *   2. Rich structured HTML — the actual vacancy body with named sections
 *      (h2/h3 headings) for "Il tuo compito", "Il tuo profilo", etc.
 *
 * Regression case: "Dirigente Team Controllo Qualità (M/F/D)"
 *   https://jobs.sbb.ch/v2/offene-stellen/dirigente-team-controllo-qualita-m-f-d/f40a8456-69e6-4d3f-ad9a-8b7803d10227
 *   — published description was shorter than the source vacancy because only
 *     the JSON-LD `description` teaser was used; HTML sections were ignored.
 *   — fix: extract structured HTML sections and prefer them when longer.
 */

/** Minimum accepted description length (characters). */
export const MIN_SBB_DESC_LENGTH = 400;

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function decodeHtmlEntities(input = '') {
  const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
    ndash: '-', mdash: '-', hellip: '...', raquo: '»', laquo: '«',
    agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
    auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  };
  return String(input || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code) => {
    const raw = String(code || '').toLowerCase();
    if (raw.startsWith('#x')) {
      const cp = Number.parseInt(raw.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    if (raw.startsWith('#')) {
      const cp = Number.parseInt(raw.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return NAMED[raw] || full;
  });
}

export function stripHtml(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(text).replace(/\r/g, '');
  return decoded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── JSON-LD extraction ────────────────────────────────────────────────────────

/**
 * Extract the schema.org/JobPosting node from inline JSON-LD scripts.
 *
 * @param {string} html
 * @returns {object|null}
 */
export function extractSbbJsonLd(html = '') {
  const scripts = [...String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    const raw = String(match[1] || '').trim();
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const nodes = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((node) => {
      if (!node || typeof node !== 'object') return [];
      if (Array.isArray(node['@graph'])) return node['@graph'];
      return [node];
    });
    for (const node of nodes) {
      const type = node?.['@type'];
      const matchType = Array.isArray(type)
        ? type.some((t) => String(t || '').toLowerCase() === 'jobposting')
        : String(type || '').toLowerCase() === 'jobposting';
      if (matchType) return node;
    }
  }
  return null;
}

/**
 * Build a plain-text description from JSON-LD JobPosting fields.
 * Combines description + responsibilities + qualifications, deduplicates.
 *
 * @param {object|null} jobPosting
 * @returns {string}
 */
export function buildJsonLdDescription(jobPosting) {
  if (!jobPosting) return '';
  const blocks = [
    jobPosting?.description,
    jobPosting?.responsibilities,
    jobPosting?.qualifications,
  ]
    .map((raw) => stripHtml(String(raw || '')).trim())
    .filter((b) => b.length >= 40);

  // Deduplicate: drop block if it's already contained in another
  const deduped = [];
  for (const block of blocks) {
    const normalized = block.toLowerCase();
    const isDupe = deduped.some((existing) => {
      const n = existing.toLowerCase();
      return n === normalized || n.includes(normalized) || normalized.includes(n);
    });
    if (!isDupe) deduped.push(block);
  }

  return deduped.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── HTML section extraction ───────────────────────────────────────────────────

/**
 * Extract structured sections from the jobs.sbb.ch HTML body.
 *
 * The vacancy body on jobs.sbb.ch v2 pages is structured as:
 *   - An intro paragraph (before the first heading)
 *   - Named sections with <h2> or <h3> headings (e.g. "Il tuo compito",
 *     "Il tuo profilo", "Cosa offriamo")
 *
 * Headings that are part of navigation/header/footer (very short, or matching
 * known site-chrome patterns) are skipped.
 *
 * @param {string} html
 * @returns {string} plain-text combined sections
 */
export function extractSbbHtmlSections(html = '') {
  if (!html) return '';

  // Strip scripts and styles first to avoid false matches
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  const sections = [];

  // Split on h2/h3 boundaries to extract heading + body pairs
  // Pattern: find a heading tag, capture its text, then capture everything until
  // the next h2/h3 or end of a known container.
  const sectionPattern = /<(h[23])[^>]*>([\s\S]*?)<\/\1>([\s\S]*?)(?=<h[23][^>]*>|$)/gi;
  let match;
  while ((match = sectionPattern.exec(cleaned)) !== null) {
    const heading = stripHtml(match[2]).trim();
    const bodyHtml = match[3];
    if (!heading || heading.length > 100) continue;

    // Skip navigation-like headings (very short single-word headings, or known site chrome)
    const headingLower = heading.toLowerCase();
    if (/^(menu|home|jobs|career|karriere|offerte|cerca|search|login|iscriviti|contatti?|news|impostazioni?|cookie)$/.test(headingLower)) continue;

    const body = stripHtml(bodyHtml).trim();
    if (!body || body.length < 20) continue;

    sections.push(`## ${heading}\n${body}`);
  }

  return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract the intro text that appears before the first h2/h3 heading.
 * This is typically the teaser/intro paragraph of the vacancy.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractSbbIntroText(html = '') {
  if (!html) return '';
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  // Find the first h2/h3 and take everything before it inside main/article/section
  const beforeFirstHeading = cleaned.match(/^([\s\S]*?)(?=<h[23][^>]*>)/i)?.[1] || '';
  return stripHtml(beforeFirstHeading).trim();
}

// ─── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse a jobs.sbb.ch detail page HTML into a structured job record fragment.
 *
 * Combines JSON-LD (for metadata) with HTML section extraction (for full body).
 * The HTML sections are preferred over JSON-LD description when they yield
 * more content, since the JSON-LD description is typically a short teaser.
 *
 * @param {string} html - Raw HTML of a jobs.sbb.ch detail page
 * @returns {{ title: string, description: string, requirements: string[], location: string, warnings: string[] }}
 */
export function parseSbbDetailPage(html = '') {
  if (!html) return { title: '', description: '', requirements: [], location: '', warnings: [] };

  const jobPosting = extractSbbJsonLd(html);

  // Title: prefer JSON-LD, fall back to <h1>
  const title = (() => {
    const jsonLdTitle = String(jobPosting?.title || '').trim();
    if (jsonLdTitle) return jsonLdTitle;
    return stripHtml(String(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')).trim();
  })();

  // Build JSON-LD description (teaser + qualifications)
  const jsonLdDesc = buildJsonLdDescription(jobPosting);

  // Build HTML section description (full vacancy body)
  const htmlSections = extractSbbHtmlSections(html);
  const htmlIntro = extractSbbIntroText(html);

  // Combine intro + sections, deduplicate against JSON-LD teaser
  const htmlParts = [htmlIntro, htmlSections].map((s) => s.trim()).filter(Boolean);
  const htmlDesc = htmlParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  // Prefer HTML content if it's meaningfully longer than JSON-LD
  // (accounts for the common case where JSON-LD has a teaser and HTML has the full body)
  const description = htmlDesc.length > jsonLdDesc.length + 100
    ? htmlDesc
    : jsonLdDesc || htmlDesc;

  // Requirements from JSON-LD qualifications
  const requirements = (() => {
    const raw = String(jobPosting?.qualifications || '');
    if (!raw) return [];
    return [...String(raw).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => stripHtml(m[1]).trim())
      .filter((item) => item.length >= 6);
  })();

  // Location from JSON-LD
  const location = (() => {
    const locations = Array.isArray(jobPosting?.jobLocation)
      ? jobPosting.jobLocation
      : [jobPosting?.jobLocation];
    for (const place of locations) {
      const locality = String(place?.address?.addressLocality || '').trim();
      if (locality) return locality;
    }
    // Fall back to last comma-part of title (e.g. "Job Title, Bellinzona")
    if (title.includes(',')) {
      const candidate = title.split(',').pop()?.trim() || '';
      if (candidate.length <= 60) return candidate;
    }
    return '';
  })();

  const warnings = [];
  if (description.length < MIN_SBB_DESC_LENGTH) {
    warnings.push(
      `SBB description too short for "${title}" (${description.length} chars < ${MIN_SBB_DESC_LENGTH}) — ` +
      `HTML sections may be missing or vacancy has no body content`
    );
  }

  return {
    title: title.trim(),
    description: description.trim(),
    requirements,
    location: location.trim(),
    warnings,
  };
}
