/**
 * Tests for the Città di Mendrisio crawler title/description logic.
 *
 * The crawler extracts titles from <h3> tags in HTML and descriptions
 * from PDF text. Title normalization strips announcement prefixes
 * ("1 ", "Cercansi", "Un o una") and capitalizes the role name.
 */
import { describe, it, expect } from 'vitest';

/* ── Inline the functions we're testing (they're not exported from ESM) ── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&agrave;/gi, 'à')
    .replace(/&egrave;/gi, 'è')
    .replace(/&igrave;/gi, 'ì')
    .replace(/&ograve;/gi, 'ò')
    .replace(/&ugrave;/gi, 'ù')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeJobTitle(rawTitle = '') {
  let t = normalizeSpace(rawTitle);
  if (!t) return t;
  t = t.replace(/^\d+\s+/, '');
  t = t.replace(/^cercansi\s+/i, '');
  t = t.replace(/^un\s+o\s+un[ao]?\s+/i, '');
  if (t.length > 0) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t;
}

function isTitleTooGeneric(title = '') {
  const t = title.trim().toLowerCase();
  if (/^concorso$/i.test(t)) return true;
  if (/^apprendistato$/i.test(t)) return true;
  if (/^concorso per l.assunzione/i.test(t) && t.length < 50) return true;
  if (/^bando$/i.test(t)) return true;
  if (t.length < 5) return true;
  return false;
}

function titleOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const clean = (s: string) =>
    String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean);
  const wordsA = new Set(clean(a));
  const wordsB = new Set(clean(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.min(wordsA.size, wordsB.size);
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 90);
}

/* ── HTML fixtures ── */

const AJAX_HTML_FIXTURE = `
<article class="document">
  <time datetime="2026-03-01"></time>
  <div class="content">
    <h3>1 apprendista AFC elettricista per reti di distribuzione</h3>
    <span class="note">In scadenza il: <time datetime="2026-04-30">30 aprile 2026</time></span>
    <ul class="download-list">
      <li><a href="/downloadConcorsiPdf?uuid=406d1993-b1ab-4edb-aa94-ef296eb1e54e">Bando (PDF)</a></li>
    </ul>
    <p>Concorso pubblico per apprendistato presso l'amministrazione comunale.</p>
    <p><a href="https://cittamen.pi-asp.de/bewerber-web/?companyId=1&amp;id=1000&amp;pId=1000">Candidatura online</a></p>
  </div>
</article>
<article class="document">
  <time datetime="2026-03-01"></time>
  <div class="content">
    <h3>1 apprendista CFP giardiniere/a paesaggista</h3>
    <span class="note">In scadenza il: <time datetime="2026-04-30">30 aprile 2026</time></span>
    <ul class="download-list">
      <li><a href="/downloadConcorsiPdf?uuid=7b18ea7e-9966-4aaf-ae1a-2e90c5ba26ec">Bando (PDF)</a></li>
    </ul>
    <p>Concorso per apprendistato.</p>
  </div>
</article>
<article class="document">
  <time datetime="2026-02-15"></time>
  <div class="content">
    <h3>Cercansi bagnini presso la piscina S. Martino di Mendrisio e il Lido di Capolago per la stagione balneare 2026</h3>
    <span class="note">In scadenza il: <time datetime="2026-05-31">31 maggio 2026</time></span>
    <ul class="download-list">
      <li><a href="/dam/jcr:7ff10aff-dd61-44bf-adf7-8d174eb3f575/Avviso.pdf">Bando (PDF)</a></li>
    </ul>
    <p>Posizione stagionale.</p>
  </div>
</article>
<article class="document">
  <time datetime="2026-03-10"></time>
  <div class="content">
    <h3>Un o una educatore/trice al 70% a tempo indeterminato</h3>
    <span class="note">In scadenza il: <time datetime="2026-04-15">15 aprile 2026</time></span>
    <ul class="download-list">
      <li><a href="/downloadConcorsiPdf?uuid=f21b8d83-a08b-4703-bb89-547460177e38">Bando (PDF)</a></li>
    </ul>
    <p>Nido dell'infanzia comunale.</p>
    <p><a href="https://cittamen.pi-asp.de/bewerber-web/?companyId=1&amp;id=2000&amp;pId=2000">Candidatura online</a></p>
  </div>
</article>
<article class="document">
  <time datetime="2026-03-05"></time>
  <div class="content">
    <h3>3 apprendisti/e impiegati/e di commercio AFC</h3>
    <span class="note">In scadenza il: <time datetime="2026-04-30">30 aprile 2026</time></span>
    <ul class="download-list">
      <li><a href="/downloadConcorsiPdf?uuid=2044df68-24c7-430b-96dc-42a6917cd4e0">Bando (PDF)</a></li>
    </ul>
    <p>Concorso per apprendistato commerciale.</p>
  </div>
</article>
`;

const PDF_TEXT_FIXTURE_ELECTRICIAN = `
CITTÀ DI MENDRISIO

Concorso per l'assunzione di apprendisti o apprendiste presso l'Amministrazione
comunale della Città di Mendrisio per l'anno scolastico 2026/2027

L'Amministrazione comunale di Mendrisio offre la possibilità a giovani motivati
e residenti nel distretto di Mendrisio di svolgere un apprendistato nelle seguenti
professioni:

• 1 apprendista AFC elettricista per reti di distribuzione
• 1 apprendista AFC giardiniere/a paesaggista
• 1 apprendista CFP giardiniere/a paesaggista
• 3 apprendisti/e impiegati/e di commercio AFC

Requisiti:
- Assolvimento della scuola dell'obbligo
- Buone conoscenze della lingua italiana
- Motivazione e interesse per la professione scelta
- Residenza nel distretto di Mendrisio

Candidatura:
Le candidature devono essere inviate entro il 30 aprile 2026 tramite il portale online.
Allegare: lettera di motivazione, curriculum vitae, pagelle degli ultimi due anni,
risultati test attitudinali (se disponibili).

Informazioni:
Per ulteriori informazioni rivolgersi all'Ufficio risorse umane,
tel. 058 688 31 11.
`;

/* ── AJAX parser extracted inline for testing ── */
function parseAjaxJobs(html: string) {
  const jobs: any[] = [];
  const articleRe = /<article\s+class="document">([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRe.exec(html)) !== null) {
    const block = match[1];
    const dateMatch = block.match(/<time\s+datetime="(\d{4}-\d{2}-\d{2})">/);
    const datePosted = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
    const deadlineMatch = block.match(/In scadenza il:\s*<time\s+datetime="([^"]+)">/);
    const deadline = deadlineMatch ? deadlineMatch[1].split(' ')[0] : null;

    const titleMatch = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;
    const rawTitle = normalizeSpace(decodeHtmlEntities(stripHtml(titleMatch[1])));
    if (!rawTitle || rawTitle.length < 3) continue;
    const title = normalizeJobTitle(rawTitle);
    if (isTitleTooGeneric(title)) continue;

    const pdfMatch = block.match(/\/downloadConcorsiPdf\?uuid=([a-f0-9-]+)/i);
    const uuid = pdfMatch ? pdfMatch[1] : null;
    const pdfUrl = uuid ? `https://mendrisio.ch/downloadConcorsiPdf?uuid=${uuid}` : null;
    const applyMatch = block.match(/href="(https:\/\/cittamen\.pi-asp\.de\/bewerber-web[^"]+)"/i);
    const applyUrl = applyMatch ? decodeHtmlEntities(applyMatch[1]) : null;

    jobs.push({ title, datePosted, deadline, uuid, pdfUrl, applyUrl, source: 'ajax' });
  }
  return jobs;
}

/* ── Tests ── */

describe('Mendrisio crawler — title normalization', () => {
  it('strips leading quantity "1 "', () => {
    expect(normalizeJobTitle('1 apprendista AFC elettricista per reti di distribuzione'))
      .toBe('Apprendista AFC elettricista per reti di distribuzione');
  });

  it('strips leading quantity "3 "', () => {
    expect(normalizeJobTitle('3 apprendisti/e impiegati/e di commercio AFC'))
      .toBe('Apprendisti/e impiegati/e di commercio AFC');
  });

  it('strips "Cercansi " prefix', () => {
    expect(normalizeJobTitle('Cercansi bagnini presso la piscina S. Martino'))
      .toBe('Bagnini presso la piscina S. Martino');
  });

  it('strips "Un o una " prefix', () => {
    expect(normalizeJobTitle('Un o una educatore/trice al 70% a tempo indeterminato'))
      .toBe('Educatore/trice al 70% a tempo indeterminato');
  });

  it('strips "Un o un " prefix (masculine)', () => {
    expect(normalizeJobTitle('Un o un impiegato al 100%'))
      .toBe('Impiegato al 100%');
  });

  it('capitalizes first letter after stripping', () => {
    expect(normalizeJobTitle('1 operaio specializzato')).toBe('Operaio specializzato');
  });

  it('leaves normal titles unchanged', () => {
    expect(normalizeJobTitle('Responsabile risorse umane')).toBe('Responsabile risorse umane');
  });

  it('handles empty/whitespace input', () => {
    expect(normalizeJobTitle('')).toBe('');
    expect(normalizeJobTitle('   ')).toBe('');
  });
});

describe('Mendrisio crawler — generic title guard', () => {
  it('rejects bare "Concorso"', () => {
    expect(isTitleTooGeneric('Concorso')).toBe(true);
  });

  it('rejects bare "Apprendistato"', () => {
    expect(isTitleTooGeneric('Apprendistato')).toBe(true);
  });

  it('rejects bare "Bando"', () => {
    expect(isTitleTooGeneric('Bando')).toBe(true);
  });

  it('rejects short generic "Concorso per l\'assunzione"', () => {
    expect(isTitleTooGeneric("Concorso per l'assunzione")).toBe(true);
  });

  it('rejects very short titles (< 5 chars)', () => {
    expect(isTitleTooGeneric('Job')).toBe(true);
  });

  it('accepts specific titles with role', () => {
    expect(isTitleTooGeneric('Apprendista AFC elettricista per reti di distribuzione')).toBe(false);
  });

  it('accepts long concorso titles with details', () => {
    expect(isTitleTooGeneric(
      "Concorso per l'assunzione di 1 apprendista AFC elettricista per reti di distribuzione"
    )).toBe(false);
  });

  it('accepts educator title', () => {
    expect(isTitleTooGeneric('Educatore/trice al 70% a tempo indeterminato')).toBe(false);
  });
});

describe('Mendrisio crawler — titleOverlap', () => {
  it('returns 1.0 for identical strings', () => {
    expect(titleOverlap('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(titleOverlap('hello world', 'foo bar baz')).toBe(0);
  });

  it('returns partial overlap', () => {
    const overlap = titleOverlap(
      'Apprendista AFC elettricista per reti di distribuzione',
      PDF_TEXT_FIXTURE_ELECTRICIAN,
    );
    expect(overlap).toBeGreaterThan(0.3);
  });

  it('returns low overlap for mismatched title vs PDF', () => {
    const overlap = titleOverlap(
      'Responsabile marketing digitale',
      PDF_TEXT_FIXTURE_ELECTRICIAN,
    );
    expect(overlap).toBeLessThan(0.3);
  });

  it('handles empty strings', () => {
    expect(titleOverlap('', 'hello')).toBe(0);
    expect(titleOverlap('hello', '')).toBe(0);
  });
});

describe('Mendrisio crawler — slug generation', () => {
  it('generates correct slug from normalized title', () => {
    const title = normalizeJobTitle('1 apprendista AFC elettricista per reti di distribuzione');
    const slug = slugify(title, 'mendrisio');
    expect(slug).toBe('apprendista-afc-elettricista-per-reti-di-distribuzione-mendrisio');
    expect(slug).not.toMatch(/^1-/); // No leading number
  });

  it('generates correct slug for "Cercansi" title', () => {
    const title = normalizeJobTitle('Cercansi bagnini presso la piscina S. Martino');
    const slug = slugify(title, 'mendrisio');
    expect(slug).toBe('bagnini-presso-la-piscina-s-martino-mendrisio');
    expect(slug).not.toContain('cercansi');
  });

  it('generates correct slug for "Un o una" title', () => {
    const title = normalizeJobTitle('Un o una educatore/trice al 70% a tempo indeterminato');
    const slug = slugify(title, 'mendrisio');
    expect(slug).toBe('educatore-trice-al-70-a-tempo-indeterminato-mendrisio');
    expect(slug).not.toContain('un-o-una');
  });

  it('truncates long slugs to 90 chars', () => {
    const longTitle = 'Bagnini presso la piscina S. Martino di Mendrisio e il Lido di Capolago per la stagione balneare 2026';
    const slug = slugify(longTitle, 'mendrisio');
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

describe('Mendrisio crawler — AJAX HTML parsing', () => {
  it('extracts all 5 jobs from fixture', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    expect(jobs.length).toBe(5);
  });

  it('normalizes electrician title — strips leading "1 "', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const electrician = jobs.find((j) => j.title.includes('elettricista'));
    expect(electrician).toBeDefined();
    expect(electrician!.title).toBe('Apprendista AFC elettricista per reti di distribuzione');
    expect(electrician!.title).not.toMatch(/^\d/);
  });

  it('normalizes gardener title — strips leading "1 "', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const gardener = jobs.find((j) => j.title.includes('giardiniere'));
    expect(gardener).toBeDefined();
    expect(gardener!.title).toBe('Apprendista CFP giardiniere/a paesaggista');
  });

  it('normalizes bagnini title — strips "Cercansi"', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const bagnini = jobs.find((j) => j.title.includes('agnini'));
    expect(bagnini).toBeDefined();
    expect(bagnini!.title).toMatch(/^Bagnini/);
    expect(bagnini!.title).not.toMatch(/^Cercansi/i);
  });

  it('normalizes educator title — strips "Un o una"', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const educator = jobs.find((j) => j.title.includes('ducatore'));
    expect(educator).toBeDefined();
    expect(educator!.title).toMatch(/^Educatore/);
    expect(educator!.title).not.toMatch(/^Un o una/i);
  });

  it('normalizes commerce apprentice title — strips "3 "', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const commerce = jobs.find((j) => j.title.includes('commercio'));
    expect(commerce).toBeDefined();
    expect(commerce!.title).toBe('Apprendisti/e impiegati/e di commercio AFC');
    expect(commerce!.title).not.toMatch(/^3\s/);
  });

  it('extracts PDF UUIDs correctly', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const electrician = jobs.find((j) => j.title.includes('elettricista'));
    expect(electrician!.uuid).toBe('406d1993-b1ab-4edb-aa94-ef296eb1e54e');
    expect(electrician!.pdfUrl).toBe(
      'https://mendrisio.ch/downloadConcorsiPdf?uuid=406d1993-b1ab-4edb-aa94-ef296eb1e54e',
    );
  });

  it('extracts apply URL from pi-ASP link', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const electrician = jobs.find((j) => j.title.includes('elettricista'));
    expect(electrician!.applyUrl).toContain('cittamen.pi-asp.de');
  });

  it('extracts deadline correctly', () => {
    const jobs = parseAjaxJobs(AJAX_HTML_FIXTURE);
    const electrician = jobs.find((j) => j.title.includes('elettricista'));
    expect(electrician!.deadline).toBe('2026-04-30');
  });

  it('skips generic titles that would be too vague', () => {
    const html = `
      <article class="document">
        <time datetime="2026-01-01"></time>
        <div class="content"><h3>Concorso</h3><p>Generico</p></div>
      </article>
      <article class="document">
        <time datetime="2026-01-01"></time>
        <div class="content"><h3>1 apprendista AFC falegname</h3><p>Dettaglio</p></div>
      </article>
    `;
    const jobs = parseAjaxJobs(html);
    expect(jobs.length).toBe(1);
    expect(jobs[0].title).toBe('Apprendista AFC falegname');
  });
});

describe('Mendrisio crawler — PDF text overlap validation', () => {
  it('electrician title has good overlap with shared PDF', () => {
    const title = normalizeJobTitle('1 apprendista AFC elettricista per reti di distribuzione');
    const overlap = titleOverlap(title, PDF_TEXT_FIXTURE_ELECTRICIAN);
    expect(overlap).toBeGreaterThan(0.2);
  });

  it('gardener title has good overlap with shared PDF', () => {
    const title = normalizeJobTitle('1 apprendista CFP giardiniere/a paesaggista');
    const overlap = titleOverlap(title, PDF_TEXT_FIXTURE_ELECTRICIAN);
    expect(overlap).toBeGreaterThan(0.2);
  });

  it('commerce title has good overlap with shared PDF', () => {
    const title = normalizeJobTitle('3 apprendisti/e impiegati/e di commercio AFC');
    const overlap = titleOverlap(title, PDF_TEXT_FIXTURE_ELECTRICIAN);
    expect(overlap).toBeGreaterThan(0.2);
  });

  it('unrelated title has low overlap with apprenticeship PDF', () => {
    const title = 'Direttore finanziario senior multinazionale';
    const overlap = titleOverlap(title, PDF_TEXT_FIXTURE_ELECTRICIAN);
    expect(overlap).toBeLessThan(0.2);
  });
});
