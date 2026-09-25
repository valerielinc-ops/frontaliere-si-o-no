/**
 * Banca Raiffeisen Vedeggio Cassarate crawler parser tests
 *
 * Tests parseRaiffeisenDetailPage() and htmlToText() using HTML fixtures
 * mirroring the actual Prospective.ch career center page structure.
 *
 * Regression case: "consulente-clientela-aziendale-banca-raiffeisen-vedeggio-cassarate-gravesano"
 *   https://jobs.raiffeisen.ch/posti-vacanti/consulente-clientela-aziendale/be9abb00-04dc-4b3c-b852-62917b8e396d
 *   — published description was shorter than the full vacancy body
 *   — fix: extract intro + #tasksAndSkills directly from page HTML
 */
import { describe, it, expect } from 'vitest';

import {
  parseRaiffeisenDetailPage,
  htmlToText,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/raiffeisen-vc-job-parser.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Mirrors the actual HTML structure served by jobs.raiffeisen.ch on 2026-03-18.
// Key structural features:
//   - section#titleAndVisual > h1 (job title + workload %)
//   - section#intro > p.introductionText (intro paragraph)
//   - section#tasksAndSkills > #tasks[itemprop="responsibilities"] + #skills[itemprop="qualifications"]
//   - section#benefits (generic "Perché Raiffeisen?" — must NOT appear in description)
//   - section#contact (generic contact — must NOT appear in description)

const FIXTURE_FULL_PAGE = `<!DOCTYPE html>
<html lang="it">
<head><title>Consulente Clientela Aziendale - Banca Raiffeisen Vedeggio Cassarate</title></head>
<body>
<main>
  <section id="titleAndVisual">
    <div class="jobPreTitleInfos">
      <div class="date">07.01.2026</div>
      <div id="locations"><a href="#">Gravesano</a></div>
    </div>
    <div class="pageTitle">
      <h1>Consulente Clientela Aziendale<br>100%</h1>
    </div>
  </section>

  <section id="intro">
    <div class="contentContainer">
      <div class="content">
        <span class="mainSubTitle t200"><b>Entra a far parte del nostro team!</b></span>
        <p class="introductionText">In un contesto economico in continua evoluzione, le imprese cercano un interlocutore affidabile e competente. La Banca Raiffeisen Vedeggio Cassarate crede nel valore delle relazioni durature, nel radicamento sul territorio e nella consulenza di qualità.<br>Per rafforzare la nostra presenza nel segmento aziendale, siamo alla ricerca di un Consulente alla clientela aziendale.</p>
        <div class="applicationCTA hiddenPrint">
          <a class="primaryButton" href="https://ohws.prospective.ch/public/v1/redirect/be9abb00-04dc-4b3c-b852-62917b8e396d/ats/">candidarsi ora</a>
        </div>
      </div>
    </div>
  </section>

  <section id="tasksAndSkills">
    <div class="contentContainer">
      <div class="content">
        <div id="tasks" itemprop="responsibilities">
          <h2 class="t300" data-type="section-title"><b>Cosa ti aspetta?</b></h2>
          <ul>
            <li>Un portafoglio di clienti aziendali da gestire e sviluppare con autonomia e visione strategica.</li>
            <li>L'opportunità di essere un partner di fiducia per imprenditori.</li>
            <li>Un ambiente di lavoro solido, orientato alla collaborazione e alla crescita professionale.</li>
            <li>Processi decisionali agili e una banca vicina al territorio, dove il tuo contributo conta davvero.</li>
            <li>Un ruolo chiave in una banca cooperativa con valori forti e prospettive di sviluppo.</li>
            <li>Formazione continua, strumenti digitali all'avanguardia e condizioni d'impiego attrattive.</li>
            <li>Una cultura aziendale basata sulla fiducia e sul rispetto.</li>
          </ul>
        </div>
        <div id="skills" itemprop="qualifications">
          <h2 class="t300" data-type="section-title"><b>Cosa offri?</b></h2>
          <ul>
            <li>Un/una professionista con una solida esperienza nella consulenza aziendale bancaria (min. 5 anni).</li>
            <li>Ottime competenze nella gestione di relazioni con le aziende, nella strutturazione di soluzioni di finanziamento, e nella consulenza globale alle imprese.</li>
            <li>Competenze analitiche accresciute e capacità di interpretare dati di bilancio.</li>
            <li>Spiccate competenze sociali e comunicative, fondamentali nella gestione delle relazioni d'affari.</li>
            <li>Spirito imprenditoriale, empatia e forte orientamento al cliente.</li>
            <li>Conoscenza del mercato ticinese e delle sue dinamiche economiche.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- Generic sections — must NOT end up in description -->
  <section id="benefits" class="hiddenPrint">
    <div class="contentContainer">
      <h2>Perché Raiffeisen?</h2>
      <p>I valori cooperativi sono i nostri pilastri. Insieme. Gli uni per gli altri.</p>
    </div>
  </section>

  <section id="contact">
    <div class="contentContainer">
      <h2>Hai domande?</h2>
      <div class="contactsHolder">
        <div>Susanne Lunati<br>Human Resources<br>+41 (91) 936 36 36</div>
      </div>
    </div>
  </section>

  <section id="similarJobs" class="hiddenPrint">
    <h2>Altre posizioni che potrebbero corrispondere</h2>
    <ul>
      <li><a href="/posti-vacanti/other-job/uuid">Other Job</a></li>
    </ul>
  </section>
</main>
</body>
</html>`;

// Fixture: intro only, no tasksAndSkills — description will be short → invalid
const FIXTURE_INTRO_ONLY = `<!DOCTYPE html>
<html><body>
<main>
  <section id="titleAndVisual">
    <div class="pageTitle"><h1>Stagista<br>50%</h1></div>
  </section>
  <section id="intro">
    <div class="contentContainer">
      <div class="content">
        <p class="introductionText">TBD.</p>
      </div>
    </div>
  </section>
  <section id="benefits" class="hiddenPrint">
    <h2>Perché Raiffeisen?</h2>
  </section>
</main>
</body></html>`;

// Fixture: no #tasksAndSkills, fallback to <main> content before generic sections
const FIXTURE_NO_TASKS_SECTION = `<!DOCTYPE html>
<html><body>
<main>
  <section id="titleAndVisual">
    <div class="pageTitle"><h1>Consulente Finanziario<br>80-100%</h1></div>
  </section>
  <section id="intro">
    <div class="contentContainer">
      <div class="content">
        <p class="introductionText">Stiamo cercando un Consulente Finanziario per rafforzare il nostro team di Gravesano. Il candidato ideale possiede una solida esperienza nel settore bancario e una forte capacità di relazione con la clientela privata e aziendale.</p>
      </div>
    </div>
  </section>
  <section id="customContent">
    <div class="contentContainer">
      <h2>Il tuo profilo</h2>
      <ul>
        <li>Diploma o laurea in economia o finanza.</li>
        <li>Almeno 3 anni di esperienza nella consulenza finanziaria.</li>
        <li>Ottime capacità comunicative e orientamento al cliente.</li>
        <li>Conoscenza del mercato ticinese.</li>
      </ul>
    </div>
  </section>
  <!-- Generic section starts here -->
  <section id="benefits" class="hiddenPrint">
    <h2>Perché Raiffeisen?</h2>
    <p>Contenuto generico.</p>
  </section>
</main>
</body></html>`;

// ─── parseRaiffeisenDetailPage — Consulente Clientela Aziendale regression ───

describe('parseRaiffeisenDetailPage — Consulente Clientela Aziendale regression', () => {
  it('returns valid: true for a complete page', () => {
    const result = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(result.valid).toBe(true);
  });

  it('extracts the correct title (workload stripped)', () => {
    const { title } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(title).toBe('Consulente Clientela Aziendale');
  });

  it('extracts the workload percentage', () => {
    const { workload } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(workload).toBe('100%');
  });

  it('extracts the intro text', () => {
    const { introText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(introText).toContain('interlocutore affidabile e competente');
    expect(introText).toContain('Banca Raiffeisen Vedeggio Cassarate');
  });

  it('extracts tasks (Cosa ti aspetta?) from #tasks[itemprop="responsibilities"]', () => {
    const { tasksText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(tasksText).toContain('Cosa ti aspetta?');
    expect(tasksText).toContain('portafoglio di clienti aziendali');
    expect(tasksText).toContain('partner di fiducia per imprenditori');
  });

  it('extracts skills (Cosa offri?) from #skills[itemprop="qualifications"]', () => {
    const { skillsText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(skillsText).toContain('Cosa offri?');
    expect(skillsText).toContain('consulenza aziendale bancaria');
    expect(skillsText).toContain('mercato ticinese');
  });

  it(`descriptionText is >= ${MIN_DESC_LENGTH} characters`, () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(descriptionText.length).toBeGreaterThanOrEqual(MIN_DESC_LENGTH);
  });

  it('descriptionText combines intro + tasks + skills', () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(descriptionText).toContain('interlocutore affidabile');
    expect(descriptionText).toContain('portafoglio di clienti');
    expect(descriptionText).toContain('consulenza aziendale bancaria');
  });

  it('descriptionText does not contain generic "Perché Raiffeisen?" content', () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(descriptionText).not.toContain('Perché Raiffeisen');
    expect(descriptionText).not.toContain('valori cooperativi sono i nostri pilastri');
  });

  it('descriptionText does not contain "Hai domande?" contact section', () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(descriptionText).not.toContain('Hai domande');
    expect(descriptionText).not.toContain('Susanne Lunati');
  });

  it('descriptionText does not contain "Altre posizioni" similar jobs', () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(descriptionText).not.toContain('Altre posizioni');
  });

  it('descriptionText does not contain HTML tags', () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(descriptionText).not.toMatch(/<[a-z]/i);
  });

  it('descriptionText does not contain "candidarsi ora" (application button)', () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(descriptionText).not.toContain('candidarsi ora');
  });

  it('returns no warnings for a well-formed page', () => {
    const { warnings } = parseRaiffeisenDetailPage(FIXTURE_FULL_PAGE);
    expect(warnings).toHaveLength(0);
  });
});

// ─── parseRaiffeisenDetailPage — guards ──────────────────────────────────────

describe('parseRaiffeisenDetailPage — guards', () => {
  it('returns valid: false for empty HTML', () => {
    expect(parseRaiffeisenDetailPage('').valid).toBe(false);
  });

  it('returns valid: false when description is too short', () => {
    const { valid, warnings } = parseRaiffeisenDetailPage(FIXTURE_INTRO_ONLY);
    expect(valid).toBe(false);
    expect(warnings.some(w => w.includes('too short'))).toBe(true);
  });

  it('falls back to <main> content when #tasksAndSkills is absent', () => {
    const { valid, descriptionText, warnings } = parseRaiffeisenDetailPage(FIXTURE_NO_TASKS_SECTION);
    expect(valid).toBe(true);
    expect(descriptionText).toContain('Consulente Finanziario');
    expect(descriptionText).toContain('mercato ticinese');
    // Should emit a warning about fallback
    expect(warnings.some(w => w.includes('fell back'))).toBe(true);
  });

  it('fallback description does not include generic "Perché Raiffeisen?" content', () => {
    const { descriptionText } = parseRaiffeisenDetailPage(FIXTURE_NO_TASKS_SECTION);
    expect(descriptionText).not.toContain('Perché Raiffeisen');
  });

  it('handles workload range "80-100%"', () => {
    const { workload } = parseRaiffeisenDetailPage(FIXTURE_NO_TASKS_SECTION);
    expect(workload).toMatch(/80[-–]100%/);
  });
});

// ─── htmlToText ──────────────────────────────────────────────────────────────

describe('htmlToText', () => {
  it('strips HTML tags', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('preserves text content', () => {
    const r = htmlToText('<p>Hello <b>world</b></p>');
    expect(r).toContain('Hello');
    expect(r).toContain('world');
  });

  it('converts <br> and block elements to newlines', () => {
    const r = htmlToText('<p>First<br>Second</p>');
    expect(r).toContain('\n');
  });

  it('decodes HTML entities', () => {
    expect(htmlToText('AT&amp;T')).toContain('AT&T');
    expect(htmlToText('&lt;tag&gt;')).toContain('<tag>');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null as any)).toBe('');
  });
});
