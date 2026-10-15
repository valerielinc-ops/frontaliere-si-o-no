/**
 * Tests for the PEMSA crawler detail page parser.
 *
 * Uses a real JSON-LD description from pemsa.ch to verify:
 *  - Structured markdown extraction (headings + lists)
 *  - Description >= 400 chars with >= 2 distinct sections
 *  - Skip "contatto" sections
 *  - Quality guard: body ratio >= 20%
 */

// Inline the parser logic for testing (the crawler is ESM .mjs).

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

interface ParseResult {
  text: string;
  sectionCount: number;
  sourceTextLength: number;
}

function parseDescriptionToMarkdown(rawDescription: string): ParseResult {
  if (!rawDescription) return { text: '', sectionCount: 0, sourceTextLength: 0 };

  const decoded = decodeHtmlEntities(rawDescription);
  const sourceTextLength = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

  let html = decoded.replace(/<\/br>/gi, '').replace(/<br\s*\/?>/gi, '\n');

  const sections: string[] = [];
  const skipHeadings = /contatto|persona di contatto|contact|Kontakt|votre interlocuteur/i;

  const firstHeadingIdx = html.search(/<h[2-4][^>]*>/i);
  if (firstHeadingIdx > 0) {
    const introHtml = html.slice(0, firstHeadingIdx);
    const intro = introHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (intro.length > 30) sections.push(intro);
  }

  const headingRegex = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*([\s\S]*?)(?=<h[2-4][^>]*>|$)/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const heading = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!heading || skipHeadings.test(heading)) continue;

    const contentBlock = match[2];
    const ulMatch = contentBlock.match(/<ul>([\s\S]*?)<\/ul>/i);
    if (ulMatch) {
      const items: string[] = [];
      const liRegex = /<li>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRegex.exec(ulMatch[1])) !== null) {
        const text = li[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (text) items.push(text);
      }
      if (items.length > 0) {
        sections.push(`## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
        continue;
      }
    }

    const pMatches = contentBlock.match(/<p>([\s\S]*?)<\/p>/gi);
    if (pMatches) {
      const lines = pMatches
        .map((p) => p.replace(/<\/?p>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (lines.length > 0 && lines.join(' ').length > 20) {
        sections.push(`## ${heading}\n${lines.join('\n')}`);
        continue;
      }
    }

    const plain = contentBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length > 20) {
      sections.push(`## ${heading}\n${plain}`);
    }
  }

  const text = sections.join('\n\n');
  const sectionCount = sections.filter((s) => s.startsWith('## ')).length;
  return { text, sectionCount, sourceTextLength };
}

/* ── Fixture: real JSON-LD description from pemsa.ch (Lattoniere) ── */
const FIXTURE_DESCRIPTION = `Vuoi la libertà di un lavoro temporaneo e la sicurezza di uno permanente?

Da 30 anni, assistiamo centinaia di aziende nei settori tecnici dell'edilizia, delle costruzioni e dell'industria in tutta la Svizzera, offrendo loro i migliori talenti. 

Non ti mentiremo, ma siamo esigenti. Quindi, se sei una persona motivata ed entusiasta, si unisciti al clan per la posizione di Lattoniere&lt;/br&gt;&lt;/br&gt;&lt;h2&gt;Missione :&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;Installazione e posa di lamiere con attenzione meticolosa alla qualità e alla precisione tecnica.&lt;/li&gt;
&lt;li&gt;Interpretazione accurata di disegni tecnici per garantire la conformità alle specifiche progettuali.&lt;/li&gt;
&lt;li&gt;Gestione dei materiali edili con competenza approfondita, assicurando un impiego efficiente e corretto.&lt;/li&gt;
&lt;li&gt;Collaboratione nelle operazioni di preparazione dei pezzi, ottimizzando la fase di montaggio e posa.&lt;/li&gt;
&lt;li&gt;Realizzazione di lavori in quota in totale sicurezza e rispetto delle normative vigenti.&lt;/li&gt;
&lt;li&gt;Eventuale utilizzo di materiali specifici quali carta catramata e Sarnafil per rifiniture di qualità.&lt;/li&gt;
&lt;/ul&gt;
&lt;/br&gt;&lt;/br&gt;&lt;h2&gt;Profilo :&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;&lt;strong&gt;Esperienza minima di 4 anni in Svizzera&lt;/strong&gt; nel settore della posa lamiere e lavorazioni edili correlate.&lt;/li&gt;
&lt;li&gt;&lt;strong&gt;Residenza entro un raggio massimo di 30 km da Lugano&lt;/strong&gt; per garantire la presenza e continuità sul cantiere.&lt;/li&gt;
&lt;li&gt;&lt;strong&gt;Padronanza eccellente dei materiali&lt;/strong&gt; utilizzati nella posa lamiere con intuito per la scelta ottimale dei prodotti.&lt;/li&gt;
&lt;li&gt;&lt;strong&gt;Capacità consolidata nella lettura di disegni tecnici&lt;/strong&gt; indispensabile per una corretta esecuzione dei lavori.&lt;/li&gt;
&lt;li&gt;&lt;strong&gt;Esperienza comprovata nella posa e installazione di lamiere&lt;/strong&gt; con attenzione a precisione e durata nel tempo.&lt;/li&gt;
&lt;li&gt;Preferibile esperienza nella preparazione dei pezzi e nell&amp;#8217;esecuzione di lavori in altezza, garantendo sicurezza e precisione.&lt;/li&gt;
&lt;li&gt;Costituiscono un valore aggiunto il possesso di una &lt;em&gt;AFC&lt;/em&gt; nel settore, il patentino IPAF e l'esperienza nell'uso di carta catramata e Sarnafil.&lt;/li&gt;
&lt;/ul&gt;
&lt;/br&gt;&lt;/br&gt;&lt;h2&gt;&lt;strong&gt;La tua persona di contatto:&lt;/strong&gt;&lt;/h2&gt;
&lt;p&gt;Il tuo contatto per questa posizione è Davide. Con oltre 15 anni di esperienza nel campo del reclutamento, sarà in grado di accompagnarti, consigliarti e rispondere a tutte le tue domande sulla posizione. Questo lavoro non è esattamente quello che sta cercando, ma i nostri valori ti piacciono? Non esitare a inviarci la tua candidatura spontanea!&lt;/p&gt;`;

describe('PEMSA crawler — parseDescriptionToMarkdown', () => {
  let result: ParseResult;

  beforeAll(() => {
    result = parseDescriptionToMarkdown(FIXTURE_DESCRIPTION);
  });

  it('produces description >= 400 characters', () => {
    expect(result.text.length).toBeGreaterThanOrEqual(400);
  });

  it('has at least 2 distinct sections (headings)', () => {
    expect(result.sectionCount).toBeGreaterThanOrEqual(2);
  });

  it('extracts Missione section with bullet items', () => {
    expect(result.text).toContain('Missione');
    expect(result.text).toContain('Installazione e posa di lamiere');
    expect(result.text).toContain('disegni tecnici');
  });

  it('extracts Profilo section with bullet items', () => {
    expect(result.text).toContain('Profilo');
    expect(result.text).toContain('Esperienza minima di 4 anni');
    expect(result.text).toContain('Residenza entro un raggio');
  });

  it('preserves intro text before first heading', () => {
    expect(result.text).toContain('libertà di un lavoro temporaneo');
    expect(result.text).toContain('settori tecnici');
  });

  it('skips "persona di contatto" section', () => {
    expect(result.text).not.toContain('persona di contatto');
    expect(result.text).not.toContain('Davide');
  });

  it('preserves sourceTextLength for ratio check', () => {
    expect(result.sourceTextLength).toBeGreaterThan(500);
  });

  it('body ratio >= 20% of source', () => {
    const ratio = result.text.length / result.sourceTextLength;
    expect(ratio).toBeGreaterThanOrEqual(0.20);
  });

  it('does not truncate at 280 characters', () => {
    expect(result.text.length).toBeGreaterThan(280);
  });

  it('decodes HTML entities correctly', () => {
    // &#8217; should become '
    expect(result.text).toContain('\u2019'); // right single quotation mark
    expect(result.text).not.toContain('&#8217;');
    expect(result.text).not.toContain('&lt;');
    expect(result.text).not.toContain('&gt;');
  });
});

describe('PEMSA crawler — edge cases', () => {
  it('handles empty description', () => {
    const result = parseDescriptionToMarkdown('');
    expect(result.text).toBe('');
    expect(result.sectionCount).toBe(0);
  });

  it('handles description without HTML-encoded tags', () => {
    const result = parseDescriptionToMarkdown('Simple text without any HTML tags or structure.');
    expect(result.text).toBe('');
    expect(result.sectionCount).toBe(0);
  });

  it('handles description with only intro (no headings)', () => {
    const desc = 'A long intro text that describes the job position in detail but has no heading structure at all. This text should be long enough to be meaningful and provide some context about the role.';
    const result = parseDescriptionToMarkdown(desc);
    // No headings → no sections → sectionCount = 0
    expect(result.sectionCount).toBe(0);
  });
});
