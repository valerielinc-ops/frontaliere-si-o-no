import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, validateClerDescription } from '../scripts/lib/cler-job-parser.mjs';

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
