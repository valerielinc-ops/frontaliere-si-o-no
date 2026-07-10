/**
 * Canton du Valais (État du Valais) OTB job-ad PDF extraction.
 *
 * The vs.ch "stellenborse" portlet only carries title + department line per
 * job — the real ad content (tasks, profile, entry date, contacts) lives
 * exclusively in the per-job PDF served by
 * `https://otb.apps.vs.ch/svc/api/joboffersdocument/{id}?language=fr`.
 * (The iApply SPA's own JSON detail endpoint,
 * `svc/api/joboffersinternet/{job}/publications/{pub}`, returns the SAME
 * one-line department blurb as the portlet — verified live 2026-07-10 —
 * so the PDF is the only rich source. Issue #3836: 13/19 thin stubs.)
 *
 * The shared `pdf-job-content.mjs` helper is NOT reused for text extraction
 * here because unpdf's merged `extractText` flattens the whole ad into one
 * paragraph: these PDFs are generated from a rigid HR template where list
 * items only survive as a small first-line indent (body column x≈99, item
 * starts at x≈107–111). We therefore extract positioned text lines with
 * pdfjs (via unpdf's getDocumentProxy) and rebuild the ad's real structure:
 * known section headings ("Vos tâches", "Ihr Profil", …) become labelled
 * sections and indented line starts become bullet items.
 */

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Line extraction (pdfjs positioned text) ───────────────── */

/**
 * Extract visual text lines (with their starting x offset) from PDF bytes.
 * Items are grouped into lines by y coordinate (±2pt tolerance) per page.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<Array<{ x: number, text: string }>>}
 */
export async function extractOtbPdfLines(bytes) {
  const { getDocumentProxy } = await import('unpdf');
  // Always re-wrap: pdfjs rejects Node Buffers (which ARE Uint8Array
  // subclasses, so an instanceof check would wrongly pass them through).
  const data = new Uint8Array(
    bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const pdf = await getDocumentProxy(data);
  try {
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p += 1) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let current = null;
      for (const item of content.items) {
        const str = String(item?.str || '');
        if (!str && !item?.hasEOL) continue;
        const y = item.transform?.[5];
        const x = item.transform?.[4];
        if (typeof y !== 'number' || typeof x !== 'number') continue;
        if (!current || Math.abs(current.y - y) > 2.5) {
          current = { y, x: Math.round(x), text: '' };
          lines.push(current);
        }
        current.text += str;
      }
    }
    return lines
      .map((l) => ({ x: l.x, text: l.text.replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.text);
  } finally {
    try {
      await pdf.destroy();
    } catch {
      /* noop */
    }
  }
}

/* ── Structure reconstruction ──────────────────────────────── */

/** Known section headings of the État du Valais HR ad template (FR + DE). */
const SECTION_HEADINGS = new Set([
  // French
  'vos tâches',
  'votre mission',
  'vos missions',
  'votre profil',
  'nos offres',
  'notre offre',
  "conditions d'engagement",
  "taux d'activité",
  'lieu de travail',
  'entrée en fonction',
  'informations',
  // German
  'ihre aufgaben',
  'ihre mission',
  'ihr profil',
  'unser angebot',
  'wir bieten',
  'anstellungsbedingungen',
  'arbeitsort',
  'stellenantritt',
  'informationen',
]);

/** Lines that are pure chrome of the letterhead template, dropped verbatim. */
const SIGNATURE_LINES = new Set([
  "département des finances et de l'énergie",
  'service des ressources humaines',
  'departement für finanzen und energie',
  'dienststelle für personalmanagement',
]);

function normalizeHeading(text = '') {
  return text
    .toLowerCase()
    .replace(/[  ]+/g, ' ')
    .replace(/\s*:\s*$/, '')
    .trim();
}

function isNoiseLine(text = '') {
  // Standalone "apply online" pointer (already carried by applyUrl).
  if (/^(postulation en ligne|online-bewerbung)\s*:?\s*(auf\s+)?www\.vs\.ch\/jobs$/i.test(text)) return true;
  // Letter date line ("Sion, le 10 juillet 2026 …" / "Sitten, den 10. Juli 2026 …");
  // the letterhead signature block is often glued onto it.
  if (/^(sion, le|sitten, den)\s+\d{1,2}/i.test(text)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(text)) return true; // page numbers
  return false;
}

/**
 * Rebuild a readable, structured description from positioned PDF lines.
 *
 * - Known template headings become "Heading:" lines.
 * - A line indented past the body column (>=4pt) starts a "• " bullet item
 *   (the only surviving trace of the template's list items).
 * - Consecutive non-indented lines are merged into the running paragraph
 *   or bullet (soft-wrapped continuations).
 *
 * @param {Array<{ x: number, text: string }>} lines
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function formatOtbJobDescription(lines = [], { maxChars = 7000 } = {}) {
  const kept = (lines || []).filter(
    (l) => l && l.text && !isNoiseLine(l.text) && !SIGNATURE_LINES.has(normalizeHeading(l.text)),
  );
  if (kept.length === 0) return '';

  const bodyX = Math.min(...kept.map((l) => l.x));

  /** @type {Array<{ type: 'heading' | 'para' | 'bullet', text: string }>} */
  const blocks = [];
  let current = null;

  const flush = () => {
    if (current && current.text.trim()) blocks.push({ ...current, text: current.text.trim() });
    current = null;
  };

  for (const line of kept) {
    const headingKey = normalizeHeading(line.text);
    if (SECTION_HEADINGS.has(headingKey)) {
      flush();
      blocks.push({ type: 'heading', text: line.text.replace(/\s*:\s*$/, '') });
      continue;
    }
    const indent = line.x - bodyX;
    // Item start: indented past the body column (but far-right letterhead
    // columns are dropped above via SIGNATURE_LINES, and real item indents
    // on this template are ~8–12pt).
    if (indent >= 4 && indent <= 40) {
      flush();
      current = { type: 'bullet', text: line.text };
      continue;
    }
    if (current) {
      // Re-join words hyphenated across a soft line wrap ("Ausbil-" + "dung").
      if (/[a-zäöüéèàç]-$/.test(current.text) && /^[a-zäöüéèàç]/.test(line.text)) {
        current.text = current.text.slice(0, -1) + line.text;
      } else {
        current.text += ` ${line.text}`;
      }
    } else {
      current = { type: 'para', text: line.text };
    }
  }
  flush();

  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.type === 'heading') {
      out.push(`${out.length ? '\n' : ''}${block.text}:`);
    } else if (block.type === 'bullet') {
      out.push(`• ${block.text}`);
    } else {
      out.push(`${block.text}\n`);
    }
  }

  const joined = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/* ── Fetch + format (used by the crawler) ──────────────────── */

/**
 * Fetch a job-ad PDF from otb.apps.vs.ch and return its structured text.
 * Returns '' on any failure (caller falls back to the listing blurb).
 *
 * @param {string} pdfUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function fetchOtbJobPdfDescription(pdfUrl, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  if (!pdfUrl) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(pdfUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/pdf,*/*;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || DEFAULT_USER_AGENT,
      },
    });
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status || 'unknown'} while fetching job PDF`);
    }
    const bytes = await response.arrayBuffer();
    const lines = await extractOtbPdfLines(bytes);
    const text = formatOtbJobDescription(lines);
    // Guard against image-only/scanned PDFs: a handful of chars is not a
    // real ad body — let the caller fall back to the listing blurb instead.
    return text.length >= 100 ? text : '';
  } catch (err) {
    console.warn(`   ⚠️ OTB PDF extraction failed for ${pdfUrl}: ${err?.message || err}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}
