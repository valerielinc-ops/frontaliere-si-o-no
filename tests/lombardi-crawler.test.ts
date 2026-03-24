/**
 * Lombardi Group crawler parser tests
 *
 * Tests parseLombardiDetailHtml(), buildLombardiLocalizedContent(),
 * and titleOverlap() using real HTML fixtures from lombardi.group.
 */
import { describe, it, expect } from 'vitest';

import { parseLombardiDetailHtml, buildLombardiLocalizedContent, titleOverlap } from '@/scripts/lib/lombardi-job-parser.mjs';

// ─── Fixture: Progettista / Tecnico RVCS (id=108934) ───
const RVCS_HTML = `
<main>
  <div class="intro push-top push-bottom">
    <div class="container">
      <div class="row push-bottom">
        <div class="col-12 col-lg-8 offset-lg-1">
          <span class="intro__category">Careers</span>
          <h1 class="intro__title">Job</h1>
          <h2 class="h1 intro__subtitle">
            Progettista / Tecnico RVCS (M/F/X)
          </h2>
          <h3 class="push-top-xs push-bottom-xs">
            80%–100% | Giubiasco
          </h3>
          <div class="intro__rich-text">
            <p>Come progettista RVCS, guiderai la realizzazione di impianti innovativi, dalla progettazione alla consegna, assicurando qualità, precisione e il coordinamento di tutte le fasi per garantire il successo dei nostri progetti.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="container push-bottom">
    <div class="row">
      <div class="col-12 col-lg-5 offset-lg-1">
        <div class="push-bottom-xs">
          <h3>Job Description</h3>
          <ul class="list">
            <li v-for="offer in offers">Progettazione e dimensionamento di impianti RVCS per edifici industriali e civili</li>
            <li v-for="offer in offers">Disegno 2D con AutoCAD, modellazione BIM con software Revit</li>
            <li v-for="offer in offers">Controllo dei costi, dei termini e della qualità delle opere dal progetto all'esecuzione</li>
            <li v-for="offer in offers">Allestimento schemi di principio</li>
            <li v-for="offer in offers">Stestura di capitolati con Messerli CPN</li>
          </ul>
        </div>
        <div>
          <h3>Requirements</h3>
          <ul class="list">
            <li v-for="experience in experiences">Disegnatore/Tecnico progettista RVCS, con apprendistato tecnico o diploma SSS/ST e almeno 5 anni di esperienza nel settore</li>
            <li v-for="experience in experiences">Capacità di organizzazione autonoma e gestione dei progetti</li>
            <li v-for="experience in experiences">Conoscenza norme SIA-EN</li>
            <li v-for="experience in experiences">Buona conoscenza dei programmi CAD e Office 365. Revit costituisce titolo preferenziale</li>
            <li v-for="experience in experiences">Ottima conoscenza della lingua italiana e tedesca</li>
          </ul>
        </div>
      </div>
      <div class="col-12 col-lg-4 offset-lg-1">
        <h3>Contact</h3>
        <p>HR Department</p>
        <h3>Apply now</h3>
        <p>Apply through our portal</p>
      </div>
    </div>
  </div>
</main>`;

// ─── Fixture: Apprendista IT (id=109274) ───
const APPRENTICE_HTML = `
<main>
  <div class="intro push-top push-bottom">
    <div class="container">
      <div class="row push-bottom">
        <div class="col-12 col-lg-8 offset-lg-1">
          <span class="intro__category">Careers</span>
          <h1 class="intro__title">Job</h1>
          <h2 class="h1 intro__subtitle">
            Apprendista IT &ndash; Tecnico Sistemistico
          </h2>
          <h3 class="push-top-xs push-bottom-xs">
            100%–100% | Giubiasco
          </h3>
          <div class="intro__rich-text">
            <p>Inizia la tua carriera con il nostro programma di apprendistato e acquisisci esperienza pratica in un ambiente dinamico, collaborativo e di supporto.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="container push-bottom">
    <div class="row">
      <div class="col-12 col-lg-5 offset-lg-1">
        <div class="push-bottom-xs">
          <h3>Job Description</h3>
          <ul class="list">
            <li v-for="offer in offers">Imparerai a installare e configurare postazioni di lavoro, software e dispositivi IT lavorando con tecnologie moderne.</li>
            <li v-for="offer in offers">Supporterai i collaboratori attraverso attività di helpdesk, affiancato/a da un team esperto e disponibile.</li>
            <li v-for="offer in offers">Parteciperai alla gestione e manutenzione di server, reti e infrastrutture aziendali in un ambiente professionale strutturato.</li>
            <li v-for="offer in offers">Collaborerai in progetti IT interni, acquisendo competenze concrete in ambito sistemistico e sicurezza informatica.</li>
            <li v-for="offer in offers">Seguirai un percorso di formazione completo di crescita al termine dell'apprendistato.</li>
          </ul>
        </div>
        <div>
          <h3>Requirements</h3>
          <ul class="list">
            <li v-for="experience in experiences">Hai concluso la scuola dell'obbligo o stai per terminarla con buoni risultati, in particolare nelle materie tecniche e matematiche.</li>
            <li v-for="experience in experiences">Nutri un forte interesse per l&apos;informatica, i sistemi, le reti e le nuove tecnologie.</li>
            <li v-for="experience in experiences">Sei curioso/a, motivato/a e desideroso/a di imparare in un contesto professionale strutturato.</li>
            <li v-for="experience in experiences">Ti piace risolvere problemi tecnici e aiutare gli altri.</li>
            <li v-for="experience in experiences">Sei una persona affidabile, precisa e predisposta al lavoro in team.</li>
          </ul>
        </div>
      </div>
      <div class="col-12 col-lg-4 offset-lg-1">
        <h3>Contact</h3>
        <p>HR Department Lombardi Group</p>
      </div>
    </div>
  </div>
</main>`;

// ─── Fixture: Italian locale version (section headings in Italian) ───
const ITALIAN_LOCALE_HTML = `
<main>
  <div class="intro push-top push-bottom">
    <div class="container">
      <div class="row push-bottom">
        <div class="col-12 col-lg-8 offset-lg-1">
          <h1 class="intro__title">Offerta</h1>
          <h2 class="h1 intro__subtitle">Ingegnere di progetto (M/F/X)</h2>
          <h3 class="push-top-xs push-bottom-xs">100%–100% | Giubiasco</h3>
          <div class="intro__rich-text">
            <p>Cerchiamo un ingegnere di progetto per il nostro team di progettazione.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="container push-bottom">
    <div class="row">
      <div class="col-12 col-lg-5 offset-lg-1">
        <div class="push-bottom-xs">
          <h3>Descrizione dell&#039;offerta di lavoro</h3>
          <ul class="list">
            <li>Progettazione di strutture complesse</li>
            <li>Coordinamento con i team multidisciplinari</li>
            <li>Gestione tecnica dei progetti assegnati</li>
          </ul>
        </div>
        <div>
          <h3>Requisiti</h3>
          <ul class="list">
            <li>Laurea in ingegneria civile o equivalente</li>
            <li>Almeno 3 anni di esperienza nel settore</li>
          </ul>
        </div>
      </div>
      <div class="col-12 col-lg-4 offset-lg-1">
        <h3>Contatti</h3>
        <p>HR</p>
        <h3>Candidati ora</h3>
      </div>
    </div>
  </div>
</main>`;

// ═══════════════════════════════════════════════════════════════
// parseLombardiDetailHtml
// ═══════════════════════════════════════════════════════════════

describe('parseLombardiDetailHtml', () => {
  describe('RVCS job (id=108934)', () => {
    const result = parseLombardiDetailHtml(RVCS_HTML)!;

    it('extracts title from intro__subtitle', () => {
      expect(result.detailTitle).toBe('Progettista / Tecnico RVCS (M/F/X)');
    });

    it('extracts city and occupancy', () => {
      expect(result.city).toBe('Giubiasco');
      expect(result.occupancy).toBe('80%–100%');
    });

    it('extracts intro text', () => {
      expect(result.introText).toContain('progettista RVCS');
      expect(result.introText).toContain('qualità');
    });

    it('extracts both content sections', () => {
      expect(result.sectionCount).toBe(2);
    });

    it('extracts Job Description items', () => {
      const mansioni = result.sections.find((s: { heading: string }) => s.heading === 'Mansioni');
      expect(mansioni).toBeDefined();
      expect(mansioni.items.length).toBe(5);
      expect(mansioni.items[0]).toContain('impianti RVCS');
    });

    it('extracts Requirements items', () => {
      const requisiti = result.sections.find((s: { heading: string }) => s.heading === 'Requisiti');
      expect(requisiti).toBeDefined();
      expect(requisiti.items.length).toBe(5);
      expect(requisiti.items[0]).toContain('Disegnatore/Tecnico progettista');
    });

    it('produces markdown >= 500 chars', () => {
      expect(result.markdown.length).toBeGreaterThanOrEqual(500);
    });

    it('markdown contains structured sections', () => {
      expect(result.markdown).toContain('## Mansioni');
      expect(result.markdown).toContain('## Requisiti');
      expect(result.markdown).toContain('- Progettazione');
    });

    it('does NOT include Contact content', () => {
      expect(result.markdown).not.toContain('HR Department');
      expect(result.markdown).not.toContain('Apply');
    });
  });

  describe('Apprentice IT job (id=109274)', () => {
    const result = parseLombardiDetailHtml(APPRENTICE_HTML)!;

    it('extracts title with HTML entity decode', () => {
      expect(result.detailTitle).toBe('Apprendista IT – Tecnico Sistemistico');
    });

    it('extracts 2 content sections', () => {
      expect(result.sectionCount).toBe(2);
    });

    it('intro text mentions apprendistato', () => {
      expect(result.introText).toContain('apprendistato');
    });

    it('Job Description has 5 items', () => {
      const mansioni = result.sections.find((s: { heading: string }) => s.heading === 'Mansioni');
      expect(mansioni).toBeDefined();
      expect(mansioni.items.length).toBe(5);
    });

    it('Requirements has 5 items', () => {
      const requisiti = result.sections.find((s: { heading: string }) => s.heading === 'Requisiti');
      expect(requisiti).toBeDefined();
      expect(requisiti.items.length).toBe(5);
    });

    it('markdown >= 500 chars', () => {
      expect(result.markdown.length).toBeGreaterThanOrEqual(500);
    });
  });

  describe('Italian locale version', () => {
    const result = parseLombardiDetailHtml(ITALIAN_LOCALE_HTML)!;

    it('maps Italian headings to standard labels', () => {
      const headings = result.sections.map((s: { heading: string }) => s.heading);
      expect(headings).toContain('Mansioni');
      expect(headings).toContain('Requisiti');
    });

    it('skips Contatti and Candidati ora', () => {
      expect(result.markdown).not.toContain('Contatti');
      expect(result.markdown).not.toContain('Candidati');
    });

    it('extracts title', () => {
      expect(result.detailTitle).toBe('Ingegnere di progetto (M/F/X)');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty input', () => {
      expect(parseLombardiDetailHtml('')).toBeNull();
      expect(parseLombardiDetailHtml(null as unknown as string)).toBeNull();
    });

    it('handles page with no sections gracefully', () => {
      const html = '<main><h2 class="h1 intro__subtitle">Some Title</h2></main>';
      const result = parseLombardiDetailHtml(html)!;
      expect(result.detailTitle).toBe('Some Title');
      expect(result.sectionCount).toBe(0);
      expect(result.markdown).toBe('');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// buildLombardiLocalizedContent
// ═══════════════════════════════════════════════════════════════

describe('buildLombardiLocalizedContent', () => {
  it('stores detail markdown as EN description and IT as boilerplate', () => {
    const longMarkdown = 'Lombardi Group cerca un profilo qualificato per il team.\n\n## Mansioni\n- Task 1 progettazione completa\n- Task 2 coordinamento multidisciplinare\n- Task 3 gestione dei costi e qualità\n\n## Requisiti\n- Req 1 laurea ingegneria\n- Req 2 almeno 5 anni esperienza';
    const result = buildLombardiLocalizedContent({
      title: 'Progettista RVCS',
      city: 'Giubiasco',
      occupancy: '80%–100%',
      detailMarkdown: longMarkdown,
    });
    expect(result.descriptionByLocale.it).toContain('## Mansioni');
    expect(result.descriptionByLocale.it).toContain('- Task 1');
  });

  it('falls back to boilerplate when markdown is short', () => {
    const result = buildLombardiLocalizedContent({
      title: 'Progettista RVCS',
      city: 'Giubiasco',
      occupancy: '80%–100%',
      detailMarkdown: 'Too short',
    });
    expect(result.descriptionByLocale.it).toContain('Lombardi Group');
    expect(result.descriptionByLocale.it).toContain('Giubiasco');
  });

  it('generates IT boilerplate and no EN when detail markdown is empty', () => {
    const result = buildLombardiLocalizedContent({
      title: 'Test',
      city: 'Giubiasco',
      detailMarkdown: '',
    });
    expect(result.descriptionByLocale.it).toBeTruthy();
    expect(result.descriptionByLocale.it).toContain('Lombardi Group');
    expect(result.descriptionByLocale.en).toBeUndefined();
  });

  it('stores English detail markdown under EN locale', () => {
    const result = buildLombardiLocalizedContent({
      title: 'Civil Engineer',
      city: 'Giubiasco',
      detailMarkdown: 'As an apprentice, you will learn the basics of technical drawing, support project teams, collaborate with colleagues, and develop your engineering skills in a structured environment.\n\n## Responsibilities\n- Coordinate projects',
    });
    expect(result.descriptionByLocale.en).toContain('As an apprentice');
    expect(result.descriptionByLocale.it).toContain('Lombardi Group');
  });
});

// ═══════════════════════════════════════════════════════════════
// titleOverlap
// ═══════════════════════════════════════════════════════════════

describe('titleOverlap', () => {
  it('returns 1.0 for identical titles', () => {
    expect(titleOverlap('Progettista RVCS', 'Progettista RVCS')).toBe(1);
  });

  it('returns high overlap for similar titles', () => {
    const overlap = titleOverlap(
      'Progettista / Tecnico RVCS (M/F/X)',
      'Progettista / Tecnico RVCS (M/F/X)',
    );
    expect(overlap).toBeGreaterThanOrEqual(0.8);
  });

  it('returns low overlap for different titles', () => {
    const overlap = titleOverlap('Progettista RVCS', 'Apprendista IT Sistemistico');
    expect(overlap).toBeLessThan(0.3);
  });

  it('handles accented characters', () => {
    const overlap = titleOverlap('Ingénieur Projet', 'Ingenieur Projet');
    expect(overlap).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(titleOverlap('', 'Test')).toBe(0);
    expect(titleOverlap('Test', '')).toBe(0);
  });
});
