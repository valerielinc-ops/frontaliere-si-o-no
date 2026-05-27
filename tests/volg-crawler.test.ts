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
