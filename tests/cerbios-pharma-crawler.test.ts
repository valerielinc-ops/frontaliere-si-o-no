/**
 * Cerbios-Pharma SA crawler parser tests
 *
 * Tests parseListingPage(), parseDetailPage(), buildJob(),
 * stripHtml(), normalizeSpace() using HTML fixtures from e-lavoro.ch.
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  buildJob,
  stripHtml,
  normalizeSpace,
} from '@/scripts/lib/cerbios-pharma-job-parser.mjs';

// ─── Fixture: e-lavoro.ch listing with jobs ────────────────
const LISTING_WITH_JOBS = `
<html>
<body>
<main>
  <h1>I nostri annunci</h1>
  <div class="view-content">
    <div class="views-row views-row-1">
      <h3><a href="/node/1234">Operatore di produzione farmaceutica</a></h3>
      <div class="field-body">
        <p>Cerbios-Pharma SA cerca un operatore di produzione per il reparto API.
           Requisiti: diploma tecnico, esperienza in ambiente GMP, conoscenza delle norme FDA/EMA.
           Offriamo formazione continua e ambiente di lavoro all'avanguardia.</p>
      </div>
    </div>
    <div class="views-row views-row-2">
      <h3><a href="/node/1235">Quality Control Analyst</a></h3>
      <div class="field-body">
        <p>Cerbios-Pharma SA is looking for a QC Analyst to join our analytical laboratory
           in Barbengo. You will perform routine testing of APIs and intermediates using
           HPLC, GC, and other analytical techniques.</p>
      </div>
    </div>
    <div class="views-row views-row-3">
      <h3><a href="/node/1236">Chimico/a di processo</a></h3>
      <div class="field-body">
        <p>Cerchiamo un chimico di processo per ottimizzare i processi di sintesi chimica
           nel nostro stabilimento di Barbengo. Laurea in chimica richiesta.</p>
      </div>
    </div>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: e-lavoro.ch listing with NO jobs ─────────────
const LISTING_NO_JOBS = `
<html>
<body>
<main>
  <h1>I nostri annunci</h1>
  <div class="view-content">
    <p>Purtroppo non ci sono offerte di lavoro, torna a trovarci!</p>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: Detail page ──────────────────────────────────
const DETAIL_HTML = `
<html>
<body>
<main>
  <article class="node-full">
    <h1>Operatore di produzione farmaceutica</h1>
    <div class="field-items">
      <p>Cerbios-Pharma SA, azienda leader nel settore farmaceutico CDMO con sede a Barbengo (Lugano),
         cerca un operatore di produzione per il reparto API (Active Pharmaceutical Ingredients).
         L'azienda è specializzata nello sviluppo e nella produzione conto terzi di principi attivi
         farmaceutici e coniugati anticorpo-farmaco (ADC).</p>
      <h2>Mansioni principali</h2>
      <ul>
        <li>Conduzione di reattori chimici e impianti di produzione secondo le GMP</li>
        <li>Documentazione accurata di tutte le attività di produzione</li>
        <li>Manutenzione ordinaria delle attrezzature di produzione</li>
        <li>Collaborazione con il team di Quality Assurance</li>
      </ul>
      <h2>Requisiti</h2>
      <ul>
        <li>Diploma tecnico in chimica o equivalente</li>
        <li>Esperienza minima di 2 anni in ambiente GMP farmaceutico</li>
        <li>Conoscenza delle normative FDA/EMA</li>
        <li>Buona padronanza della lingua italiana</li>
      </ul>
      <h2>Offriamo</h2>
      <ul>
        <li>Ambiente di lavoro dinamico e internazionale</li>
        <li>Formazione continua e sviluppo professionale</li>
        <li>Retribuzione competitiva e benefit aziendali</li>
      </ul>
    </div>
  </article>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage', () => {
  it('extracts jobs from e-lavoro.ch Drupal views', () => {
    const jobs = parseListingPage(LISTING_WITH_JOBS);
    expect(jobs.length).toBe(3);
  });

  it('extracts job titles from headings', () => {
    const jobs = parseListingPage(LISTING_WITH_JOBS);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles[0]).toBe('Operatore di produzione farmaceutica');
    expect(titles[1]).toBe('Quality Control Analyst');
  });

  it('generates valid e-lavoro.ch URLs', () => {
    const jobs = parseListingPage(LISTING_WITH_JOBS);
    expect((jobs[0] as { url: string }).url).toContain('e-lavoro.ch');
  });

  it('sets location to Barbengo for all jobs', () => {
    const jobs = parseListingPage(LISTING_WITH_JOBS);
    for (const job of jobs) {
      expect((job as { location: string }).location).toBe('Barbengo');
    }
  });

  it('returns empty array when no jobs available', () => {
    const jobs = parseListingPage(LISTING_NO_JOBS);
    expect(jobs).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
    expect(parseListingPage(null as unknown as string)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseDetailPage', () => {
  it('extracts title from h1', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Operatore di produzione farmaceutica');
  });

  it('extracts description with pharma content', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.description).toContain('CDMO');
    expect(result!.description).toContain('principi attivi');
  });

  it('extracts requirements', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.requirements.length).toBeGreaterThanOrEqual(3);
    expect(result!.requirements[0]).toContain('Diploma tecnico');
  });

  it('sets location to Barbengo', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.location).toBe('Barbengo');
    expect(result!.canton).toBe('TI');
  });

  it('returns null for empty input', () => {
    expect(parseDetailPage('')).toBeNull();
    expect(parseDetailPage(null as unknown as string)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// buildJob
// ═══════════════════════════════════════════════════════════════

describe('buildJob', () => {
  it('builds complete job object', () => {
    const job = buildJob({
      title: 'Operatore di produzione',
      url: 'https://www.e-lavoro.ch/node/1234',
    });
    expect(job).not.toBeNull();
    expect(job!.company).toBe('Cerbios-Pharma SA');
    expect(job!.companyKey).toBe('cerbios-pharma');
    expect(job!.location).toBe('Barbengo');
    expect(job!.canton).toBe('TI');
  });

  it('generates slug with company name', () => {
    const job = buildJob({ title: 'Quality Control Analyst' });
    expect(job!.slug).toContain('cerbios-pharma');
  });

  it('sets default pharma description', () => {
    const job = buildJob({ title: 'Chimico di processo' });
    expect(job!.description).toContain('CDMO');
    expect(job!.description).toContain('Barbengo');
  });

  it('returns null for empty title', () => {
    expect(buildJob({ title: '' })).toBeNull();
    expect(buildJob(null as any)).toBeNull();
  });

  it('sets default URL to e-lavoro.ch', () => {
    const job = buildJob({ title: 'Test Position' });
    expect(job!.url).toContain('e-lavoro.ch');
  });
});

// ═══════════════════════════════════════════════════════════════
// stripHtml / normalizeSpace
// ═══════════════════════════════════════════════════════════════

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp;')).toBe('&');
  });

  it('returns empty for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('normalizeSpace', () => {
  it('collapses whitespace', () => {
    expect(normalizeSpace('hello    world')).toBe('hello world');
  });
});
