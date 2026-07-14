import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, validateClerDescription, extractJobMeta, dedupeClerJobsByStableId, clerCareerSectionYear } from '../scripts/lib/cler-job-parser.mjs';
import { extractStableJobId } from '../scripts/lib/job-match-key.mjs';

// ──────────────────────────────────────────────────────────────
// Real HTML fixture: Geschäftsstellenleiterin Schaffhausen
// ──────────────────────────────────────────────────────────────

const FIXTURE_JOB1_HTML = `<!DOCTYPE html>
<html>
<body>
<div id="content" class="container">
  <div class="JobDetail">
    <ul class="JobDetail__list">
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Bereich / Abteilung</span>
        <span class="JobDetail__item-slot">Private Banking und Privatkunden / Vertrieb</span>
      </li>
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Arbeitsort</span>
        <span class="JobDetail__item-slot">Schaffhausen</span>
      </li>
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Pensum</span>
        <span class="JobDetail__item-slot">80-100%</span>
      </li>
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Stellenantritt</span>
        <span class="JobDetail__item-slot">01.01.2026 oder nach Vereinbarung</span>
      </li>
    </ul>
  </div>
  <div class="m-richtext g-row g-layout-10-center">
    <div class="g-col g-col-2">
      <div class="m-richtext__content">
        <h1 class="m-content-header__title">Geschäftsstellenleiterin Schaffhausen (w/m) 80-100%</h1>
        <p>Wir sind ganz schön auf Za(c)k. Als junge Tochter der Basler Kantonalbank haben wir mit «Zak» die erste Schweizer Smartphone-Bank auf den Markt gebracht. Damit sind wir einen Tick schneller, pfiffiger und vielleicht sogar frecher als andere Banken. Auch mit dem Thema Geld gehen wir offen um, generell sprechen wir Themen, die uns wichtig sind, direkt an. Mehr Frauenpower zum Beispiel. Darum freuen wir uns ganz besonders über Bewerbungen von Frauen.</p>
        <p>Das Team in Schaffhausen freut sich auf eine neue Chefin oder einen neuen Chef. Mit anderen Worten: auf dich!</p>
        <h2>Dein neuer Job</h2>
        <ul>
          <li>Gesamtverantwortung für die Geschäftsstelle Schaffhausen mit 5 Mitarbeitenden</li>
          <li>Enge Zusammenarbeit mit den Partnersegmenten Private Banking und Immobilienkunden</li>
          <li>Mit einer proaktiven Marktbearbeitung Neukundinnen und -kunden sowie Marktanteile gewinnen</li>
          <li>Ein eigenes Kundenbuch führen und entwickeln</li>
          <li>Eine ausgeprägt kundenorientierte, kompetente Beratung organisieren und sicherstellen</li>
          <li>Teilnahme an Kundenveranstaltungen und aktive Repräsentation der Bank Cler</li>
        </ul>
        <h2>Davon profitieren wir</h2>
        <ul>
          <li>Du verfügst bereits über Führungserfahrung und bist in der Region Schaffhausen verankert</li>
          <li>Ein gutes Gespür im Umgang mit Menschen und die Fähigkeit, andere zu motivieren und zu begeistern</li>
          <li>Mindestens fünf Jahre Berufserfahrung als Kundenberaterin mit eigenem Kundenbuch</li>
          <li>Sehr gute Kenntnisse im Bereich Finanzieren und Anlegen</li>
          <li>Eine betriebswirtschaftliche oder fachspezifische Aus- oder Weiterbildung</li>
          <li>Geübt in Lösungen zu denken</li>
        </ul>
        <h2>So profitierst du</h2>
        <ul>
          <li>Ein offener Umgang mit dem Thema Geld, auch bezüglich Lohngleichheit – die gibt es bei uns nämlich wirklich</li>
          <li>Arbeiten, wo andere Ferien machen – in einer der schönsten Regionen</li>
          <li>Mindestens 25 Tage Ferien</li>
          <li>Gratis-Konto und Bankkarte</li>
          <li>Attraktive Vergünstigungen bei unseren Partnern</li>
        </ul>
        <h2>Noch Fragen?</h2>
        <br/>
        <br/>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

// ──────────────────────────────────────────────────────────────
// Real HTML fixture: Marktgebietsleiterin Zentral
// ──────────────────────────────────────────────────────────────

const FIXTURE_JOB2_HTML = `<!DOCTYPE html>
<html>
<body>
<div id="content" class="container">
  <div class="JobDetail">
    <ul class="JobDetail__list">
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Bereich / Abteilung</span>
        <span class="JobDetail__item-slot">Private Banking und Privatkunden / Vertrieb</span>
      </li>
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Arbeitsort</span>
        <span class="JobDetail__item-slot">Zürich</span>
      </li>
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Pensum</span>
        <span class="JobDetail__item-slot">80-100%</span>
      </li>
    </ul>
  </div>
  <div class="m-richtext g-row g-layout-10-center">
    <div class="g-col g-col-2">
      <div class="m-richtext__content">
        <h1>Marktgebietsleiterin Zentral (w/m) 80-100%</h1>
        <p>Wir sind ganz schön auf Za(c)k. Als junge Tochter der Basler Kantonalbank haben wir mit «Zak» die erste Schweizer Smartphone-Bank auf den Markt gebracht.</p>
        <p>Stefano, Arafat, Ivo und weitere Kolleginnen und Kollegen freuen sich auf eine neue Marktgebietsleiterin oder einen neuen Marktgebietsleiter.</p>
        <h2>Dein neuer Job</h2>
        <ul>
          <li>Verantwortung über drei Geschäftsstellen (Zürich, Winterthur, Luzern)</li>
          <li>Führung und Entwicklung der Teams</li>
          <li>Strategische und operative Steuerung des Marktgebiets</li>
          <li>Neukundenakquise und Marktanteilsgewinnung</li>
        </ul>
        <h2>Davon profitieren wir</h2>
        <ul>
          <li>Menschen führen und begeistern können</li>
          <li>Mehrjährige Berufserfahrung in einer ähnlichen Rolle</li>
          <li>Sehr gute Kenntnisse im Bereich Anlegen und Finanzieren</li>
        </ul>
        <h2>So profitierst du</h2>
        <ul>
          <li>Mindestens 25 Tage Ferien</li>
          <li>Gratis-Konto und Bankkarte</li>
          <li>Attraktive Vergünstigungen</li>
        </ul>
        <h2>Noch Fragen?</h2>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

// ──────────────────────────────────────────────────────────────
// htmlToMarkdown tests
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// dedupeClerJobsByStableId — #3836 duplicate-listings collapse
//
// Since the 2026-07 relaunch the jobssearch API returns each open position
// twice: once under the legacy `…/jobs-und-karriere/…` path and once under the
// relaunched `…/jobs-und-karriere-2026/…` path — SAME 3-4 digit requisition id,
// two distinct whole URLs. Left un-deduped this emitted 12 records for 6 real
// jobs, tripping the duplicate-listings ratchet (12/12).
// ──────────────────────────────────────────────────────────────

const API_BASE = 'https://www.cler.ch';

// 6 real roles, each returned under BOTH career-section paths (12 listings).
const CLER_ROLES: Array<[string, string]> = [
  ['2673', 'kundenberaterin-basis-zuerich-stv-teamleiterin-w-m'],
  ['2685', 'kundenberaterin-vermoegende-privatkunden-zuerich-w-m'],
  ['2680', 'kundenberaterin-individual-zuerich-w-m'],
  ['2676', 'geschaeftsstellenleiterin-st-gallen-w-m'],
  ['2662', 'kundenberater-privatkunden-individual-thun-w-m'],
  ['2589', 'kundenberaterin-basis-thun-w-m'],
];

function buildClerListingFixture() {
  const listings: Array<{ link: { url: string } }> = [];
  for (const [id, slug] of CLER_ROLES) {
    // Order mirrors the live API: legacy path first, relaunched path second.
    listings.push({ link: { url: `/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/${slug}-${id}` } });
    listings.push({ link: { url: `/de/bank-cler/jobs-und-karriere-2026/suchen-und-bewerben/offene-stellen/${slug}-${id}` } });
  }
  return listings;
}

const getListingUrl = (l: { link?: { url?: string } }) => (l?.link?.url ? `${API_BASE}${l.link.url}` : '');

describe('dedupeClerJobsByStableId — #3836', () => {
  it('collapses 12 duplicate listings into 6 distinct jobs', () => {
    const listings = buildClerListingFixture();
    expect(listings).toHaveLength(12);
    const unique = dedupeClerJobsByStableId(listings, getListingUrl);
    expect(unique).toHaveLength(6);
  });

  it('leaves NO id-duplicated records (each stable id appears exactly once)', () => {
    const unique = dedupeClerJobsByStableId(buildClerListingFixture(), getListingUrl);
    const ids = unique.map((l) => extractStableJobId(getListingUrl(l)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(
      new Set(CLER_ROLES.map(([id]) => `req:cler.ch:${id}`)),
    );
  });

  it('preserves the canonical (newest career-section) URL for each survivor', () => {
    const unique = dedupeClerJobsByStableId(buildClerListingFixture(), getListingUrl);
    for (const l of unique) {
      expect(l.link.url).toContain('jobs-und-karriere-2026');
    }
  });

  it('picks the canonical URL regardless of API ordering', () => {
    // Same posting, relaunched path listed FIRST this time — canonical must
    // still win, not merely "last seen".
    const listings = [
      { link: { url: '/de/bank-cler/jobs-und-karriere-2026/suchen-und-bewerben/offene-stellen/kundenberaterin-basis-thun-w-m-2589' } },
      { link: { url: '/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/kundenberaterin-basis-thun-w-m-2589' } },
    ];
    const unique = dedupeClerJobsByStableId(listings, getListingUrl);
    expect(unique).toHaveLength(1);
    expect(unique[0].link.url).toContain('jobs-und-karriere-2026');
  });

  it('keeps records with no derivable stable id instead of dropping them', () => {
    const listings = [
      { link: { url: '' }, slug: '' },
      { link: { url: '' }, slug: '' },
    ] as Array<{ link: { url: string }; slug: string }>;
    const unique = dedupeClerJobsByStableId(listings, getListingUrl);
    expect(unique).toHaveLength(2);
  });

  // #4205 item 3 — a URL IS present but Rule K's host-gate doesn't apply
  // (the leaf carries no trailing digit run, e.g. a listing/index path with
  // no requisition id). extractStableJobId still falls back to a stable
  // whole-URL key (job-url-key.mjs Rule C never returns '' for a non-empty
  // input) — two identical such listings must collapse into ONE record, not
  // scatter across synthetic `__nokey_N` keys (which would happen only if
  // the URL resolved to '').
  it('collapses duplicate listings whose URL has no extractable requisition id (Rule K inapplicable)', () => {
    const noReqUrl = '/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen';
    const listings = [
      { link: { url: noReqUrl } },
      { link: { url: noReqUrl } },
    ];
    const unique = dedupeClerJobsByStableId(listings, getListingUrl);
    expect(unique).toHaveLength(1);
  });

  it('clerCareerSectionYear extracts the year suffix (0 when absent)', () => {
    expect(clerCareerSectionYear(`${API_BASE}/de/bank-cler/jobs-und-karriere-2026/x-2589`)).toBe(2026);
    expect(clerCareerSectionYear(`${API_BASE}/de/bank-cler/jobs-und-karriere/x-2589`)).toBe(0);
  });
});

describe('htmlToMarkdown — Cler job pages', () => {
  it('extracts full description from Job 1 (Geschäftsstellenleiterin)', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md.length).toBeGreaterThanOrEqual(350);
  });

  it('includes title as H2 heading', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md).toContain('## Geschäftsstellenleiterin Schaffhausen');
  });

  it('includes section headings (Dein neuer Job, Davon profitieren wir)', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md).toContain('### Dein neuer Job');
    expect(md).toContain('### Davon profitieren wir');
    expect(md).toContain('### So profitierst du');
  });

  it('includes list items for responsibilities', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md).toContain('- Gesamtverantwortung');
    expect(md).toContain('- Enge Zusammenarbeit');
  });

  it('includes list items for requirements', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md).toContain('- Du verfügst bereits über Führungserfahrung');
    expect(md).toContain('- Mindestens fünf Jahre Berufserfahrung');
  });

  it('includes metadata footer', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md).toContain('**Arbeitsort:** Schaffhausen');
    expect(md).toContain('**Pensum:** 80-100%');
  });

  it('stops before "Noch Fragen?" section', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md).not.toContain('Noch Fragen');
  });

  it('includes intro paragraphs', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    expect(md).toContain('Zak');
    expect(md).toContain('Smartphone-Bank');
  });

  it('extracts full description from Job 2 (Marktgebietsleiterin)', () => {
    const md = htmlToMarkdown(FIXTURE_JOB2_HTML);
    expect(md.length).toBeGreaterThanOrEqual(350);
    expect(md).toContain('## Marktgebietsleiterin');
    expect(md).toContain('### Dein neuer Job');
    expect(md).toContain('- Verantwortung über drei Geschäftsstellen');
  });

  it('returns empty string for HTML without richtext content', () => {
    const md = htmlToMarkdown('<html><body><p>No job content</p></body></html>');
    expect(md).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────
// validateClerDescription tests
// ──────────────────────────────────────────────────────────────

describe('validateClerDescription', () => {
  it('passes for full Job 1 description', () => {
    const md = htmlToMarkdown(FIXTURE_JOB1_HTML);
    const { ok, warnings } = validateClerDescription(md, 5000);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('passes for full Job 2 description', () => {
    const md = htmlToMarkdown(FIXTURE_JOB2_HTML);
    const { ok, warnings } = validateClerDescription(md, 4000);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('fails for short teaser description', () => {
    const teaser = 'Geschäftsstellenleiterin Schaffhausen (w/m). Private Banking. Pensum: 80-100%';
    const { ok, warnings } = validateClerDescription(teaser, 5000);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('too short'))).toBe(true);
  });

  it('fails when no section headings present', () => {
    const noHeadings = 'A'.repeat(400);
    const { ok, warnings } = validateClerDescription(noHeadings);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('headings'))).toBe(true);
  });

  it('fails when too few list items', () => {
    const noLists = '### Section\n\n' + 'A'.repeat(400);
    const { ok, warnings } = validateClerDescription(noLists);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('list items'))).toBe(true);
  });

  it('warns on low source coverage', () => {
    const short = '### Job\n\n- item 1\n- item 2\n\nSome padding text.';
    const { ok, warnings } = validateClerDescription(short, 10000);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('coverage'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// extractJobMeta tests — guard against the Bellinzona force-stamp bug
// ──────────────────────────────────────────────────────────────

describe('extractJobMeta — JobPosting location source of truth', () => {
  it('extracts Arbeitsort from a Schaffhausen detail page', () => {
    const meta = extractJobMeta(FIXTURE_JOB1_HTML);
    expect(meta.arbeitsort).toBe('Schaffhausen');
    expect(meta.pensum).toBe('80-100%');
    expect(meta.start).toBe('01.01.2026 oder nach Vereinbarung');
    expect(meta.bereich).toContain('Private Banking');
  });

  it('extracts Arbeitsort from a Zürich detail page (no Stellenantritt)', () => {
    const meta = extractJobMeta(FIXTURE_JOB2_HTML);
    expect(meta.arbeitsort).toBe('Zürich');
    expect(meta.pensum).toBe('80-100%');
    expect(meta.start).toBe('');
  });

  it('returns empty fields for missing or empty HTML', () => {
    expect(extractJobMeta('').arbeitsort).toBe('');
    expect(extractJobMeta(undefined as unknown as string).arbeitsort).toBe('');
    expect(extractJobMeta('<html><body></body></html>').arbeitsort).toBe('');
  });

  it('survives an Italian-localized label (luogo di lavoro)', () => {
    const html = `<html><body><div class="JobDetail"><ul>
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Luogo di lavoro</span>
        <span class="JobDetail__item-slot">Lugano</span>
      </li>
      <li class="JobDetail__item">
        <span class="JobDetail__item-slot">Percentuale</span>
        <span class="JobDetail__item-slot">100%</span>
      </li>
    </ul></div></body></html>`;
    const meta = extractJobMeta(html);
    expect(meta.arbeitsort).toBe('Lugano');
    expect(meta.pensum).toBe('100%');
  });
});
