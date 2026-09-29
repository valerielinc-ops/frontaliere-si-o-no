import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropFabricatedDescription } from '../scripts/lib/drop-fabricated-description.mjs';
import {
  buildJob,
  fetchAllJobs,
  isVolgInventedText,
  resolveVolgJobBodies,
  sourceLangFromDetailUrl,
  stripVolgInventedSlots,
  VOLG_INVENTED_TEXT_RX,
} from '../scripts/update-volg-jobs.mjs';

// First sentence of the retired fenaco company paragraph (VOLG_INVENTED_TEXT_MARKERS).
const VOLG_INVENTED_TEXT_MARKERS_FOR_TEST = 'fenaco Genossenschaft ist die grösste Agrargenossenschaft der Schweiz mit über 11.000 Mitarbeitenden.';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Tests for the Volg/fenaco crawler detail page parser.
 *
 * Uses a real HTML fixture from jobs.fenaco.com to verify:
 *  - exact title extraction from <h1>
 *  - itemprop-based section extraction (responsibilities, qualifications, incentives)
 *  - Bewerbungsinformation is NOT included
 *  - description >= 500 chars
 *  - title overlap utility function
 */

// The crawler is ESM (.mjs) — we import only the exported helpers.
// parseDetailPage and titleOverlap are exported from the crawler module.

// Inline the core logic here because Vitest runs in a different module system
// and the crawler uses native Node fetch. We replicate the pure functions.

/* ── Fixture: real HTML from jobs.fenaco.com (Verkäuferin, Verkäufer — Volg, Binn) ── */
const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head><title>Verkäuferin, Verkäufer</title></head>
<body>
<script>var pageType = 'show';</script>
<h1 class="job-title">Verkäuferin, Verkäufer</h1>
<div itemprop="responsibilities">
  <h4 data-type="section-title"><b>Auf diese Aufgaben freuen Sie sich</b></h4>
  <ul>
    <li>Freundliche und zuvorkommende Beratung unserer Kundschaft</li>
    <li>Gewährleistung einer konzepttreuen und ansprechenden Warenpräsentation</li>
    <li>Sicherstellung der Sortimentsbestellungen und Warenverfügbarkeit</li>
    <li>Fachgerechter Umgang mit Frischprodukten (Früchte, Gemüse, etc.)</li>
    <li>Bedienung der Kasse</li>
    <li>Aktive Mitarbeit in der integrierten Postagentur</li>
  </ul>
</div>
<div itemprop="qualifications">
  <h4 data-type="section-title"><b>Auf dieses Profil freuen wir uns</b></h4>
  <ul>
    <li>Freude am aktiven Kundenkontakt</li>
    <li>Abgeschlossene Ausbildung oder Berufserfahrung im Verkauf oder einem ähnlichen Umfeld (vorzugsweise Lebensmitteldetailhandel)</li>
    <li>Bereitschaft für flexible Einsatzzeiten (MO-SA zwischen 07:30-18:30)</li>
    <li>Selbstständige und zuverlässige Arbeitsweise</li>
    <li>Gute Deutschkenntnisse</li>
  </ul>
</div>
<div itemprop="incentives">
  <h4 data-type="section-title"><b>Darauf können Sie sich freuen</b></h4>
  <ul>
    <li>Bis 7 Wochen Ferien. Unsere Ferienregelung garantiert allen Mitarbeitenden mindestens 25 Tage Ferien. Ab dem 50. Lebensjahr erhalten Sie 30 Ferientage und ab dem 60. Lebensjahr sogar 35 Ferientage.</li>
    <li>Flexible Arbeitsmodelle. Von flexiblen Arbeitszeiten über die transparente elektronische Zeiterfassung bis hin zum Arbeiten im Home Office.</li>
    <li>Vergünstigungen und Personalrabatte. Werden Sie Teil unseres Teams und erhalten Sie attraktive Vergünstigungen und Personalrabatte.</li>
    <li>Attraktive Weiterbildungsmöglichkeiten. Profitieren Sie von den vielfältigen internen Aus- und Weiterbildungsangeboten der Volg Academy.</li>
  </ul>
</div>
<h4 data-type="section-title">Bewerbungsinformation</h4>
<ul>
  <li>Bewerben Sie sich via Online-Formular.</li>
  <li>Sie erhalten eine automatische Eingangsbestätigung.</li>
  <li>Willkommen im Team!</li>
</ul>
<div itemprop="contact">
  <h4 data-type="section-title"><b>Ihr Recruiter</b></h4>
  <p>Helena Corpataux</p>
  <p>HR Business Partner</p>
</div>
<h2>Stelleninformation</h2>
<div>Firma: Volg Detailhandels AG, Arbeitsort: 3996 Binn</div>
<h2>Über uns</h2>
<p>Volg ist der Spezialist für Dorfläden und Kleinflächen.</p>
</body>
</html>`;

function renderListingPage(ids: string[], total: number): string {
  const listings = ids.map((id) => `
    <a class="job job-${id}" href="/job/${id}">
      <h3 class="job-title">Verkäuferin ${id}</h3>
      <div class="company-name">VOLG, Binn</div>
      <span class="place-of-work">100%, unbefristet</span>
    </a>
  `).join('');
  return `<span class="total">${total}</span>${listings}`;
}

describe('Volg source pagination', () => {
  it('fails when a repeated page adds no unique stable records', async () => {
    const fetchMock = vi.fn(async (input) => {
      const offset = new URL(String(input)).searchParams.get('offset');
      const ids = offset === '0' ? ['1', '2', '3', '4', '5', '6', '7'] : ['1'];
      return new Response(renderListingPage(ids, 8), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAllJobs()).rejects.toThrow(/did not advance/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Volg listing geography and source language', () => {
  it('takes the city from the last segment of a multi-part employer label', async () => {
    const html = `<span class="total">2</span>
      <a class="job job-1" href="https://jobs.fenaco.com/offene-stellen/werkstattleitung-w-m-d/69eba901-9bba-4dca-9e87-019ce171fd8c">
        <h3 class="job-title">Werkstattleitung (w/m/d)</h3>
        <div class="company-name">Kunz Landtechnik, Serco Retail AG, Reiden</div>
        <span class="place-of-work">80-100%, unbefristet</span>
      </a>
      <a class="job job-2" href="https://jobs.fenaco.com/postes-vacants/vendeuse-vendeur-landi-f-h-d/a5605337-eb60-4611-8e71-12e9572b965f">
        <h3 class="job-title">Vendeuse / Vendeur LANDI (f/h/d)</h3>
        <div class="company-name">LANDI, Châtel-Saint-Denis</div>
        <span class="place-of-work">100%, unbefristet</span>
      </a>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })));

    const jobs = await fetchAllJobs();
    expect(jobs.map((job) => [job.company, job.city])).toEqual([
      ['Kunz Landtechnik', 'Reiden'],
      ['LANDI', 'Châtel-Saint-Denis'],
    ]);
  });

  it('reads the source language from the detail path, not from a short title', () => {
    expect(sourceLangFromDetailUrl('https://jobs.fenaco.com/postes-vacants/vendeuse-vendeur-landi-f-h-d/a5605337-eb60-4611-8e71-12e9572b965f')).toBe('fr');
    expect(sourceLangFromDetailUrl('https://jobs.fenaco.com/offene-stellen/lehrstelle-als-detailhandelsfachmann-frau-efz/1')).toBe('de');
    expect(sourceLangFromDetailUrl('https://jobs.fenaco.com/posti-vacanti/venditrice/1')).toBe('it');
    expect(sourceLangFromDetailUrl('https://example.test/job/1')).toBe('');
  });
});

// Three records of the 2026-09-29 slice that still carried the invented body
// (listing line + company marketing paragraph), contacts redacted.
const staleRecords = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'volg-stale-invented-records.json'), 'utf8'),
).records as Array<{ url: string, title: string, company: string, location: string, canton: string,
  sourceLang: string, description: string, descriptionByLocale: Record<string, string> }>;
const staleByTail = (tail: string) => staleRecords.find((record) => record.url.endsWith(tail))!;

describe('Volg publishes only source text', () => {
  it('builds a listing job without an invented body', () => {
    const job = buildJob({
      url: 'https://jobs.fenaco.com/offene-stellen/verkaeuferin-verkaeufer-m-w-d/9f62c326-d21b-4364-b7b1-33a95efbbde8',
      title: 'Verkäuferin / Verkäufer (m/w/d)', company: 'VOLG', city: 'Krauchthal',
      workload: '20-30%', contractTerms: 'unbefristet', canton: 'BE',
    });
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
    expect(job.sourceLang).toBe('de');
  });

  it('recognises the invented text earlier runs stored', () => {
    expect(isVolgInventedText(staleByTail('33a95efbbde8').description)).toBe(true);
    expect(isVolgInventedText(staleByTail('a903536a7c83').descriptionByLocale.de)).toBe(true);
    expect(isVolgInventedText(staleByTail('82dfafe3b264').descriptionByLocale.en)).toBe(true);
    // Real source bodies — the fenaco "Über uns" included — are not invented.
    expect(isVolgInventedText(staleByTail('33a95efbbde8').descriptionByLocale.de)).toBe(false);
    expect(isVolgInventedText(staleByTail('82dfafe3b264').descriptionByLocale.de)).toBe(false);
  });

  it('carries the previously read source body, or withholds a job that never had one', () => {
    const fresh = staleRecords.map((record) => buildJob({
      url: record.url, title: record.title, company: record.company, city: record.location,
      workload: '', contractTerms: '', canton: record.canton,
    }));
    const withBody = { ...fresh[2], description: 'Source body from this run', descriptionByLocale: { de: 'Source body from this run' } };
    const { jobs, carried, withheld } = resolveVolgJobBodies([fresh[0], fresh[1], withBody], staleRecords);

    expect(carried).toEqual([staleRecords[0].url]);
    expect(withheld).toEqual([staleRecords[1].url]);
    expect(jobs.map((job) => job.url)).toEqual([staleRecords[0].url, staleRecords[2].url]);
    expect(jobs[0].description).toBe(staleRecords[0].descriptionByLocale.de);
    expect(jobs[0].descriptionByLocale).toEqual({ de: staleRecords[0].descriptionByLocale.de });
    expect(jobs[1]).toBe(withBody);
    for (const job of jobs) expect(isVolgInventedText(job.description)).toBe(false);
  });

  it('carries a previous source body only when it meets the shared word floor', () => {
    const fresh = buildJob({
      url: staleRecords[0].url, title: staleRecords[0].title, company: staleRecords[0].company,
      city: staleRecords[0].location, workload: '', contractTerms: '', canton: staleRecords[0].canton,
    });
    // "Aufgaben" + long tokens: 49 words are far past any former character
    // threshold; "##", "-" and a stray "•" are not words.
    const bodyOf = (words: number) => `## Aufgaben\n${Array.from({ length: words - 1 }, (_, index) => `- Verantwortungsbereich${index + 1}`).join('\n')}\n•`;
    const previousWith = (words: number) => ({ ...staleRecords[0], description: bodyOf(words), descriptionByLocale: { de: bodyOf(words) } });

    expect(bodyOf(49).length).toBeGreaterThan(1000);
    expect(resolveVolgJobBodies([fresh], [previousWith(49)]).withheld).toEqual([fresh.url]);
    const carried = resolveVolgJobBodies([fresh], [previousWith(50)]);
    expect(carried.carried).toEqual([fresh.url]);
    expect(carried.jobs[0].description).toBe(bodyOf(50));
  });

  it('drops invented slots and their translations, keeping only a real source slot', () => {
    const stale = staleByTail('82dfafe3b264');
    const cleaned = stripVolgInventedSlots(stale);
    expect(cleaned.descriptionByLocale).toEqual({ de: stale.descriptionByLocale.de });
    expect(cleaned.needsRetranslation).toBe(true);

    // Invented source slot and no real source body anywhere: not published.
    expect(stripVolgInventedSlots(staleByTail('a903536a7c83'))).toBeNull();

    const clean = { ...staleByTail('33a95efbbde8'), description: staleByTail('33a95efbbde8').descriptionByLocale.de };
    expect(stripVolgInventedSlots(clean)).toBe(clean);
  });

  it('a grace-retained record with the invented text and no valid source body is neither published nor kept (review #10333)', () => {
    const marker = VOLG_INVENTED_TEXT_MARKERS_FOR_TEST;
    const retained = {
      url: 'https://jobs.fenaco.com/offene-stellen/verkaeuferin-verkaeufer-volg/00000000-0000-0000-0000-000000000001',
      sourceLang: 'de',
      crawlerMissStreak: 1,
      description: `Verkäufer:in — VOLG, Zuoz (Graubünden). Pensum: 100%.\n\n${marker}`,
      descriptionByLocale: { de: `Verkäufer:in — VOLG, Zuoz (Graubünden).\n\n${marker}` },
    };
    expect(stripVolgInventedSlots({ ...retained })).toBeNull();

    // The stored-record scrub (drop-fabricated-description.mjs) empties the
    // flat description, so nothing retained republishes the marker either.
    const stored = JSON.parse(JSON.stringify(retained));
    expect(dropFabricatedDescription(stored, VOLG_INVENTED_TEXT_RX)).toBe(true);
    expect(stored.description).not.toContain(marker);
    expect(Object.values(stored.descriptionByLocale || {}).join(' ')).not.toContain(marker);
  });

  it('no longer pads thin bodies with the shared company paragraph', () => {
    const runner = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/update-volg-jobs.mjs'), 'utf8');
    expect(runner).not.toContain('ensureMinimumDescriptionWordCount(');
    expect(runner).not.toContain('getCompanyBoilerplate(');
    expect(runner).toContain('return stripVolgInventedSlots(merged);');
    expect(runner).toContain('resolveVolgJobBodies(jobs, previousJobs)');
  });
});

describe('Volg source-detail wiring', () => {
  it('uses the shared Coop-family detail contract with retryable-status listing fallback', () => {
    const runner = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/update-volg-jobs.mjs'), 'utf8');
    expect(runner).toContain('enrichCoopSourceBackedJobs');
    expect(runner).toContain("allowedHosts: ['jobs.fenaco.com']");
    expect(runner).toContain('preserveListingOnTransientFailure: true');
    expect(runner).not.toContain('Promise.allSettled');
  });
});

/* ── Replicate parseDetailPage logic for testing ── */

function decodeEntities(text: string): string {
  return text
    .replace(/&bull;/g, '•')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1), 10)));
}

function extractItems(htmlBlock: string): string[] {
  const ulMatch = htmlBlock.match(/<ul>([\s\S]*?)<\/ul>/i);
  if (ulMatch) {
    const items: string[] = [];
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRegex.exec(ulMatch[1])) !== null) {
      const text = decodeEntities(li[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim();
      if (text) items.push(text);
    }
    if (items.length > 0) return items;
  }
  const pMatches = htmlBlock.match(/<p>([\s\S]*?)<\/p>/gi);
  if (pMatches) {
    const items: string[] = [];
    for (const pm of pMatches) {
      const inner = pm.replace(/<\/?p>/gi, '');
      const content = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const l of lines) {
        const cleaned = l.replace(/^[•\-–]\s*/, '').trim();
        if (cleaned) items.push(cleaned);
      }
    }
    if (items.length > 0) return items;
  }
  const plainText = decodeEntities(htmlBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  if (plainText.length > 20) {
    const lines = plainText.split(/(?:•|–)\s+/).filter((l) => l.trim().length > 3);
    return lines.length > 1 ? lines.map((l) => l.trim()) : [plainText];
  }
  return [];
}

function titleOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().replace(/[^a-zäöüàéè\s]/gi, '').split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-zäöüàéè\s]/gi, '').split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) common++;
  }
  return common / Math.max(wordsA.size, wordsB.size);
}

interface ParseResult {
  text: string;
  title: string;
  sourceBodyLength: number;
  hasSections: boolean;
}

function parseDetailPage(html: string): ParseResult {
  let clean = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  const h1Match = clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const detailTitle = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

  const bodyText = decodeEntities(clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  const sourceBodyLength = bodyText.length;

  const sections: string[] = [];
  const sectionLabels: Record<string, string> = {
    responsibilities: 'Aufgaben',
    qualifications: 'Profil',
    incentives: 'Vorteile',
  };

  let usedItemprop = false;
  for (const [prop, label] of Object.entries(sectionLabels)) {
    const regex = new RegExp(`<div[^>]*itemprop="${prop}"[^>]*>([\\s\\S]*?)</div>`, 'i');
    const m = clean.match(regex);
    if (!m) continue;
    const block = m[1];
    const headingMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
    const heading = headingMatch
      ? headingMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : label;
    const items = extractItems(block);
    if (items.length > 0) {
      sections.push(`## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
      usedItemprop = true;
    }
  }

  if (!usedItemprop) {
    const skipHeadings = /Arbeitsort|Kontakt|Standort|Recruiter|Stelleninformation|Bewerbungsinformation|Job-Ad|teilen|Druckversion|Datenschutz|Über uns|Weitere Stellen/i;
    const sectionHeadingsRe = /Aufgaben|Profil|Vorteile|Anforderungen|Bieten|Erwarten|Leistungen|Kompetenzen|freuen/i;

    const headingContentRegex =
      /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*([\s\S]*?)(?=<h[2-4][^>]*>|<footer|<\/main|$)/gi;
    let match;
    const seenHeadings = new Set<string>();
    while ((match = headingContentRegex.exec(clean)) !== null) {
      const heading = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!heading || skipHeadings.test(heading) || heading.length > 80) continue;
      if (!sectionHeadingsRe.test(heading)) continue;
      if (seenHeadings.has(heading)) continue;
      seenHeadings.add(heading);
      const items = extractItems(match[2]);
      if (items.length > 0) {
        sections.push(`## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
      }
    }
  }

  const text = sections.join('\n\n');
  return { text, title: detailTitle, sourceBodyLength, hasSections: sections.length > 0 };
}

/* ── Tests ── */

describe('Volg/fenaco crawler — parseDetailPage', () => {
  let result: ParseResult;

  beforeAll(() => {
    result = parseDetailPage(FIXTURE_HTML);
  });

  it('extracts exact title from <h1>', () => {
    expect(result.title).toBe('Verkäuferin, Verkäufer');
  });

  it('extracts at least one tasks/Aufgaben section', () => {
    expect(result.text).toContain('Auf diese Aufgaben freuen Sie sich');
    expect(result.text).toContain('Beratung unserer Kundschaft');
  });

  it('extracts at least one requirements/Profil section', () => {
    expect(result.text).toContain('Auf dieses Profil freuen wir uns');
    expect(result.text).toContain('Kundenkontakt');
  });

  it('extracts benefits/Vorteile section', () => {
    expect(result.text).toContain('Darauf können Sie sich freuen');
    expect(result.text).toContain('Ferienregelung');
  });

  it('does NOT include Bewerbungsinformation', () => {
    expect(result.text).not.toContain('Bewerbungsinformation');
    expect(result.text).not.toContain('Bewerben Sie sich via Online-Formular');
  });

  it('does NOT include Recruiter or Stelleninformation', () => {
    expect(result.text).not.toContain('Ihr Recruiter');
    expect(result.text).not.toContain('Helena Corpataux');
    expect(result.text).not.toContain('Stelleninformation');
  });

  it('does NOT include Über uns', () => {
    expect(result.text).not.toContain('Über uns');
  });

  it('produces description >= 500 characters', () => {
    expect(result.text.length).toBeGreaterThanOrEqual(500);
  });

  it('marks hasSections as true', () => {
    expect(result.hasSections).toBe(true);
  });

  it('strips <script> content from body', () => {
    expect(result.text).not.toContain('pageType');
    expect(result.text).not.toContain('var ');
  });
});

describe('Volg/fenaco crawler — fallback heading parser', () => {
  const FALLBACK_HTML = `
<html><body>
<h1>Allrounder (w/m/d)</h1>
<h3>Deine Aufgaben</h3>
<p>&bull; Unterstützung bei der Arealbetreuung<br>&bull; Mithilfe im LANDI Laden<br>&bull; Warenauslieferung mit Lieferwagen</p>
<h3>Dein Profil</h3>
<p>&bull; Technisches Flair<br>&bull; Körperlich fit<br>&bull; Freundliche Arbeitsweise</p>
<h3>Deine Vorteile</h3>
<ul><li>Familiäres Arbeitsklima</li><li>5 Wochen Ferien</li></ul>
<h3>Bewerbungsinformation</h3>
<ul><li>Online bewerben</li></ul>
<h3>Über uns</h3>
<p>LANDI Graubünden AG ist ein Unternehmen.</p>
</body></html>`;

  let result: ParseResult;

  beforeAll(() => {
    result = parseDetailPage(FALLBACK_HTML);
  });

  it('extracts title from h1', () => {
    expect(result.title).toBe('Allrounder (w/m/d)');
  });

  it('extracts Aufgaben section via heading fallback', () => {
    expect(result.text).toContain('Aufgaben');
    expect(result.text).toContain('Arealbetreuung');
  });

  it('extracts Profil section', () => {
    expect(result.text).toContain('Profil');
  });

  it('extracts Vorteile section', () => {
    expect(result.text).toContain('Vorteile');
    expect(result.text).toContain('Familiäres Arbeitsklima');
  });

  it('skips Bewerbungsinformation in fallback too', () => {
    expect(result.text).not.toContain('Bewerbungsinformation');
  });

  it('skips Über uns in fallback too', () => {
    expect(result.text).not.toContain('Über uns');
  });
});

describe('Volg/fenaco crawler — titleOverlap', () => {
  it('returns 1.0 for identical titles', () => {
    expect(titleOverlap('Verkäuferin Verkäufer', 'Verkäuferin Verkäufer')).toBe(1);
  });

  it('returns high overlap for same words different punctuation', () => {
    expect(titleOverlap('Verkäuferin, Verkäufer', 'Verkäuferin / Verkäufer')).toBeGreaterThanOrEqual(0.9);
  });

  it('returns >= 0.6 for partial word overlap', () => {
    expect(titleOverlap('Stellvertretende Ladenleitung (m/w/d)', 'Stellvertretende Ladenleitung')).toBeGreaterThanOrEqual(0.6);
  });

  it('returns < 0.6 for unrelated titles', () => {
    expect(titleOverlap('Verkäuferin Verkäufer', 'Chauffeur Kat C')).toBeLessThan(0.6);
  });

  it('returns 0 for empty input', () => {
    expect(titleOverlap('', 'Verkäuferin')).toBe(0);
    expect(titleOverlap('Verkäuferin', '')).toBe(0);
  });
});

describe('Volg/fenaco crawler — quality guards', () => {
  it('description is >= 25% of source body when structured sections exist', () => {
    const result = parseDetailPage(FIXTURE_HTML);
    if (result.hasSections && result.sourceBodyLength > 0) {
      const ratio = result.text.length / result.sourceBodyLength;
      expect(ratio).toBeGreaterThanOrEqual(0.25);
    }
  });
});
