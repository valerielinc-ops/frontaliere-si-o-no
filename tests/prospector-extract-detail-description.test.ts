/**
 * The vacancy body `extractDetailFields` reads from a detail page.
 *
 * The parser-quality audit compares every published description with this
 * value, and several crawlers publish it directly, so a body read wrong is
 * either a false mismatch or a wrong description. Each fixture below is a
 * minimised copy of a real page shape (texts rewritten, structure kept):
 *
 * - nested vacancy containers used to be joined once per nesting level, so a
 *   body wrapped in four containers was measured four times over;
 * - SuccessFactors jobs2web splits one vacancy into sibling
 *   `itemprop="description"` spans and only the first one was read;
 * - component captions spelled `…description` (a picture carousel, a
 *   process slide, a definition-list term) were read as the body;
 * - eRecruiter's `jobAdContent` body was not recognised at all;
 * - a JobPosting that splits its body across `responsibilities`, `skills`
 *   and `jobBenefits` was read from `description` alone, and entity-escaped
 *   HTML in JSON-LD was measured as text;
 * - form option lists, hidden blocks and a print template's sample ad were
 *   read as the body;
 * - rendered text unrelated to the structured body won on length alone, and
 *   a listing page with inline postings lent its whole text to every row.
 */
import { describe, expect, it } from 'vitest';
import { extractDetailFields, extractJsonLd, extractMicrodata } from '../scripts/lib/prospector/extract.mjs';

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const TASKS = '<ul><li>Mitarbeit in der Filiale bei Warenbereitstellung, Kasse und Reinigung</li>'
  + '<li>Unterstützung der Filialleitung in der Organisation der Abläufe</li>'
  + '<li>Führung der Filiale in Vertretung der Filialleitung</li></ul>';
const PROFILE = '<ul><li>Berufserfahrung im Verkauf oder einem ähnlichen Umfeld</li>'
  + '<li>Hohe Motivation, Einsatzbereitschaft und Belastbarkeit</li></ul>';

describe('nested vacancy containers are read once', () => {
  it('counts a body wrapped in three matching containers once (retail jobs2web skin)', () => {
    const html = `<html><body>
      <div class="jobdetails_title"><h1>Stellvertretende Filialleitung</h1></div>
      <div class="container jobcontent">
        <div class="col jobcontent_left">
          <div class="description"><p>Aufgaben</p>${TASKS}<p>Profil</p>${PROFILE}</div>
        </div>
        <div class="col col-12 col-md-auto jobcontent_right"><p>Arbeitsort 6203 Sempach Station</p></div>
      </div>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/job/1');
    expect(occurrences(description, 'Mitarbeit in der Filiale')).toBe(1);
    expect(occurrences(description, 'Hohe Motivation')).toBe(1);
    expect(description).toContain('Arbeitsort 6203 Sempach Station');
  });

  it('ignores vacancy markup quoted inside a JSON-LD string (hotel careers skin)', () => {
    const body = '<p>As a service associate you welcome guests and keep the promise of wonderful hospitality.</p>'
      + '<ul><li>Serve food and beverages following brand standards</li><li>Support colleagues during events</li></ul>';
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Service Associate',
      description: `<div class='description'>${body}</div>`,
    });
    const html = `<html><head><script type="application/ld+json">${jsonLd}</script></head><body>
      <div class="job-content"><div class="job-description"><div class="job-description-grid">
        <div class="description">${body}</div>
      </div></div></div>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://careers.example.com/job/P1');
    expect(occurrences(description, 'Serve food and beverages')).toBe(1);
    expect(description.length).toBeLessThan(260);
  });

  it('still joins sibling sections of one vacancy', () => {
    const html = `<html><body>
      <div class="job-tasks"><h2>Ihre Aufgaben</h2>${TASKS}</div>
      <div class="job-profile"><h2>Ihr Profil</h2>${PROFILE}</div>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://example.ch/jobs/1');
    expect(description).toContain('Ihre Aufgaben');
    expect(description).toContain('Ihr Profil');
    expect(description.indexOf('Ihre Aufgaben')).toBeLessThan(description.indexOf('Ihr Profil'));
  });
});

describe('SuccessFactors jobs2web sibling description spans', () => {
  const intro = '<p><strong>Et si votre histoire professionnelle se poursuivait chez nous ?</strong></p>'
    + '<p>Rejoignez une banque universelle solide et ses 2000 collaboratrices et collaborateurs.</p>';
  const body = '<div><h2>Vos missions principales</h2><span><span>Analyser les dossiers de crédit complexes</span></span>'
    + '<ul><li>Décider de l’octroi du crédit dans le cadre des compétences attribuées</li>'
    + '<li>Conseiller les gestionnaires du front</li></ul><h2>Votre profil</h2>'
    + '<ul><li>Formation bancaire supérieure</li><li>Expérience de 5 à 10 ans comme analyste crédits</li></ul></div>';
  const closing = '<p>Si ce poste est fait pour vous, postulez dès maintenant.</p>';
  const token = (inner: string, display = 'displayDTM') => `<div class="joblayouttoken ${display}"><div class="inner">
    <span xml:lang="fr-FR" lang="fr-FR" itemprop="description" class="rtltextaligneligible">${inner}</span></div></div>`;
  const page = (tokens: string, extra = '') => `<html><body>
    <div itemscope itemtype="http://schema.org/JobPosting">
      <div class="joblayouttoken displayDTM"><span itemprop="title" class="rtltextaligneligible">Senior credit officer</span></div>
      ${tokens}
      ${extra}
    </div></body></html>`;

  it('reads every top-level description span in document order', () => {
    const html = page(token(intro) + token(body) + token(closing));
    const detail = extractDetailFields(html, 'https://jobs.example.ch/job/Lausanne-Senior-credit-officer/1440007133/');
    for (const text of ['histoire professionnelle', 'Vos missions principales', 'Analyser les dossiers', 'Expérience de 5 à 10 ans', 'postulez dès maintenant']) {
      expect(detail.description).toContain(text);
    }
    expect(detail.description.indexOf('histoire professionnelle')).toBeLessThan(detail.description.indexOf('Vos missions'));
    expect(detail.description.indexOf('Vos missions')).toBeLessThan(detail.description.indexOf('postulez'));
    const [record] = extractMicrodata(html, 'https://jobs.example.ch/job/1440007133/');
    expect(record.description).toContain('histoire professionnelle');
    expect(record.description).toContain('Expérience de 5 à 10 ans');
    expect(record.description).toContain('postulez dès maintenant');
  });

  it('reads the desktop and mobile copies of one span once', () => {
    const html = page(token(body, 'displayDT') + token(body, 'displayM'));
    const detail = extractDetailFields(html, 'https://jobdetails.example.com/job/Orbe-Ingenieur/1440099833/');
    expect(occurrences(detail.description, 'Conseiller les gestionnaires')).toBe(1);
    const [record] = extractMicrodata(html, 'https://jobdetails.example.com/job/1440099833/');
    expect(occurrences(record.description, 'Conseiller les gestionnaires')).toBe(1);
  });

  it('leaves out the description of an organisation nested in the posting', () => {
    const org = `<div itemprop="hiringOrganization" itemscope itemtype="http://schema.org/Organization">
      <span itemprop="description">Banque cantonale fondée au XIXe siècle</span></div>`;
    const html = page(token(intro) + token(body), org);
    const detail = extractDetailFields(html, 'https://jobs.example.ch/job/1440007133/');
    expect(detail.description).toContain('Vos missions principales');
    expect(detail.description).not.toContain('fondée au XIXe siècle');
  });
});

describe('component captions spelled "description" are chrome', () => {
  it('does not read an application-process picture carousel as the body (DIY retail skin)', () => {
    const steps = [1, 2, 3, 4, 5].map((n) => `<div class="slide"><p>${n}. Schritt im Bewerbungsprozess: `
      + 'Nach der Prüfung Deiner Unterlagen melden wir uns zeitnah per E-Mail, Telefon oder Videokonferenz bei Dir.</p></div>').join('');
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Verkäufer:in Elektro',
      description: `<p><strong>Darauf kannst Du Dich freuen</strong></p><ul><li>39-Stunden-Woche mit flexiblen Pausen</li></ul>
        <p><strong>Es gibt immer was zu tun</strong></p><ul><li>Du berätst unsere Kundschaft bei ihren Projekten.</li></ul>`,
    });
    const html = `<html><head><script type="application/ld+json">${jsonLd}</script></head><body>
      <h1>Verkäufer:in Elektro</h1>
      <div class="picture-description__slider js-text-slider-wrapper">${steps}</div>
      <div class="picture-description__background"></div>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/offer/verkaeuferin-elektro/1');
    expect(description).toContain('Du berätst unsere Kundschaft');
    expect(description).not.toContain('Schritt im Bewerbungsprozess');
  });

  it('reads the rich-text body instead of process slides and list terms (software vendor skin)', () => {
    const slides = Array.from({ length: 6 }, (_, i) => `<div class="process-slide"><h3 class="process-slide__title">Schritt ${i + 1}</h3>
      <div class="process-slide__description"><p>Wir prüfen deine Bewerbung sorgfältig und melden uns innerhalb weniger Tage mit einer Rückmeldung zum nächsten Schritt.</p></div></div>`).join('');
    const html = `<html><body><header><nav>Karriere</nav></header><main class="r-main">
      <h1>Software Engineer 80-100%</h1>
      <ul class="desfinition-list"><li><div class="desfinition-list__term">Standort</div><div class="desfinition-list__description">St. Gallen</div></li></ul>
      <div class="c-rich-text--default"><div class="rich-text-field">
        <p>Wir suchen einen engagierten Software-Engineer für die Konzeption und Wartung moderner Softwarelösungen.</p>
        <h3>Deine Rolle</h3><ul><li>Du entwickelst und wartest Softwarelösungen im Bereich Steuern</li><li>Du führst Code-Reviews durch</li></ul>
        <h3>Dein Profil</h3><ul><li>Mindestens 5 Jahre Erfahrung als Software-Engineer</li></ul>
      </div></div>
      <div class="component__wrapper"><h2 class="component__title">Du interessierst dich für einen Job bei uns?</h2>
        <div class="component__description"><p>Erfahre mehr über den Bewerbungsprozess, der dich Schritt für Schritt zu deinem neuen Job führt.</p></div></div>
      <div class="process-slider">${slides}</div>
    </main></body></html>`;
    const { description } = extractDetailFields(html, 'https://www.example.ch/de/karriere/offene-stellen/software-engineer-3988');
    expect(description).toContain('Du führst Code-Reviews durch');
    expect(description).toContain('Mindestens 5 Jahre Erfahrung');
    expect(description).not.toContain('Wir prüfen deine Bewerbung sorgfältig');
    expect(description).not.toContain('Erfahre mehr über den Bewerbungsprozess');
  });
});

describe('eRecruiter jobAdContent', () => {
  it('reads the server-rendered body when the JSON-LD skeleton is empty', () => {
    const jsonLd = JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', title: 'Automatenbetreuer (m/w/d)', description: '' });
    const html = `<html><head><script type="application/ld+json">${jsonLd}</script></head><body>
      <div class="jobAd"><div class="jobAdContent">
        <p>Wir sind ein führendes Unternehmen für Verpflegungslösungen am Arbeitsplatz.</p>
        <table><tr><td>Hauptaufgaben</td><td>Befüllen und Reinigen der Automaten auf einer festen Tour</td></tr>
        <tr><td>Profil</td><td>Führerausweis Kategorie B und Freude am Kundenkontakt</td></tr></table>
      </div><div class="jobAdFooter">Jetzt online bewerben</div></div>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://careers.example.ch/Job/4614');
    expect(description).toContain('Befüllen und Reinigen der Automaten');
    expect(description).toContain('Führerausweis Kategorie B');
  });
});

describe('JobPosting body split across schema.org properties', () => {
  it('composes description, responsibilities, skills and benefits once each (clinic ATS)', () => {
    const intro = 'Unsere Klinik ist ein führendes Zentrum für integrative Medizin mit rund 90 Betten.';
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Pflegefachperson HF 40%',
      description: `<p>${intro}</p>`,
      responsibilities: '<p>Ihre Aufgaben</p><ul><li>Übernahme der Behandlungspflege bei akut erkrankten Patient:innen</li></ul>',
      skills: '<p>Sie bringen mit</p><ul><li>Diplom als Pflegefachfrau/-mann HF</li></ul>',
      qualifications: intro,
      educationRequirements: { '@type': 'EducationalOccupationalCredential', credentialCategory: 'professional certificate' },
      jobBenefits: '<p>Wir bieten</p><ul><li>Eine kollegiale Arbeitsatmosphäre</li></ul>',
    });
    const html = `<html><head><script type="application/ld+json">${jsonLd}</script></head><body></body></html>`;
    const [record] = extractJsonLd(html, 'https://jobs.example.com/portal/x/1/detail');
    expect(occurrences(record.description, 'führendes Zentrum')).toBe(1);
    expect(record.description).toContain('Übernahme der Behandlungspflege');
    expect(record.description).toContain('Diplom als Pflegefachfrau');
    expect(record.description).toContain('kollegiale Arbeitsatmosphäre');
    expect(record.description).not.toContain('professional certificate');
    expect(record.description.indexOf('führendes Zentrum')).toBeLessThan(record.description.indexOf('Übernahme'));
    expect(extractDetailFields(html, 'https://jobs.example.com/portal/x/1/detail').description).toBe(record.description);
  });

  it('keeps a description-only JobPosting unchanged', () => {
    const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Elektroplaner', description: '<p>Planung von Elektroanlagen in 3D/BIM.</p>' });
    const html = `<script type="application/ld+json">${jsonLd}</script>`;
    expect(extractJsonLd(html, 'https://example.ch/job/1')[0].description).toBe('Planung von Elektroanlagen in 3D/BIM.');
  });
});

describe('form controls, hidden blocks and print templates are not the body', () => {
  const countries = ['Afghanistan', 'Ägypten', 'Albanien', 'Algerien', 'Andorra', 'Angola', 'Argentinien', 'Armenien',
    'Australien', 'Belgien', 'Brasilien', 'Chile', 'China', 'Dänemark', 'Deutschland', 'Finnland', 'Frankreich',
    'Griechenland', 'Indien', 'Italien', 'Japan', 'Kanada', 'Liechtenstein', 'Österreich', 'Schweiz', 'Spanien']
    .map((name) => `<option value="${name}">${name}</option>`).join('');

  it('cuts an embedded application form out of the body (clinic job board)', () => {
    const html = `<html><body><div class="col-lg-8 job-description">
      <p>Die Klinik sucht eine Fachperson Betreuung für die Kita.</p>${TASKS}
      <div class="application"><form><label>Nationalität</label><select name="nationality">${countries}</select>
      <textarea name="message">Ihre Nachricht an uns</textarea></form></div>
    </div></body></html>`;
    const { description } = extractDetailFields(html, 'https://my.example.ch/job/abc/fachperson-betreuung');
    expect(description).toContain('Fachperson Betreuung');
    expect(description).toContain('Mitarbeit in der Filiale');
    expect(description).not.toContain('Liechtenstein');
    expect(description).not.toContain('Ihre Nachricht an uns');
  });

  it('cuts a hidden "position filled" view but keeps a responsive block (Phenom skin)', () => {
    const html = `<html><body><div class="job-description">
      <p>As part of the team you coordinate distribution projects and support project managers.</p>
      <div ph-page-state="expired" class="hide job-expired-view"><p>We are sorry, the job you are trying to apply for has been filled.</p></div>
      <div class="hidden md:block"><p>Standard office hours, Monday to Friday.</p></div>
    </div></body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.com/global/en/job/R-1/project-support');
    expect(description).toContain('coordinate distribution projects');
    expect(description).toContain('Monday to Friday');
    expect(description).not.toContain('has been filled');
  });

  it('ignores a print template that carries another vacancy (postal group career site)', () => {
    const html = `<html><body>
      <h1>Conductrice / Conducteur CarPostal</h1>
      <article class="print-page" id="printLayout"><main class="content-grid">
        <h2>Teamleiter/in Paketzustellung</h2>
        <p>Gemeinsam mit der Teamleitung führst du ein Team von ca. 25 Mitarbeitenden in der Paketzustellung.</p>
      </main></article>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://job.example.ch/default/job/Conductrice/74652-fr_FR');
    expect(description).not.toContain('Paketzustellung');
  });

  it('reads every sibling <article> section when the title sits above them (hospital job ad)', () => {
    const html = `<html><body><section class="main">
      <p class="intro-text">Die Klinik Chirurgie evaluiert laufend Bewerbungen für die Stelle als</p>
      <h1><strong>Unterassistent*in Chirurgie</strong><br>100%</h1>
      <article><h2>Ihr Aufgabengebiet:</h2><ul><li>Aufnahme und stationäre Mitbetreuung von Patient*innen</li></ul></article>
      <article><h2>Ihr Profil:</h2><ul><li>Wahlstudienjahr- oder PJ-Absolvent*in mit sehr guten Deutschkenntnissen</li></ul></article>
      <article><h2>Was wir Ihnen bieten:</h2><ul><li>Ein kollegiales Team in einer Klinik mit breitem Spektrum</li></ul></article>
    </section></body></html>`;
    const { description } = extractDetailFields(html, 'https://recruitingapp.example.com/Vacancies/301/Description/1');
    expect(description).toContain('Aufnahme und stationäre Mitbetreuung');
    expect(description).toContain('Wahlstudienjahr');
    expect(description).toContain('kollegiales Team');
  });

  it('keeps a print template that carries this vacancy', () => {
    const html = `<html><body>
      <h1>Polizeiaspirant·in</h1>
      <article class="print-page" id="printLayout">
        <h2>Polizeiaspirant·in</h2>
        <p>Sie absolvieren eine zweijährige höhere Berufsbildung mit dem Ziel, den Polizeiberuf auszuüben.</p>
      </article>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/job/Polizeiaspirantin/1370891157/');
    expect(description).toContain('zweijährige höhere Berufsbildung');
  });

  // Review of the extractor PR: a print sample whose heading merely CONTAINS
  // the vacancy title is another vacancy ("Senior Engineer" printed on the
  // page of an "Engineer" ad). Only a title element that reads exactly as the
  // vacancy title keeps a print region.
  it('drops a print template whose title only contains this vacancy\'s title', () => {
    const html = `<html><body>
      <h1>Engineer</h1>
      <div class="job-description"><p>You maintain the production lines and plan preventive maintenance with the shift teams.</p></div>
      <article id="printLayout"><h1>Senior Engineer</h1>OTHER</article>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/job/Engineer/1370891158/');
    expect(description).toContain('preventive maintenance');
    expect(description).not.toContain('OTHER');
  });

  it('drops such a print template also inside the <main> the fallback reads', () => {
    const html = `<html><body><main>
      <h1>Engineer</h1>
      <p>You maintain the production lines and plan preventive maintenance with the shift teams.</p>
      <article id="printLayout" class="print-page"><h2>Senior Engineer</h2><p>OTHER sample ad for a senior role.</p></article>
    </main></body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/job/Engineer/1370891159/');
    expect(description).toContain('preventive maintenance');
    expect(description).not.toContain('OTHER');
  });
});

describe('rendered text is weighed against the structured body', () => {
  const jsonLdPage = (posting: Record<string, unknown>, body: string) => `<html><head>
    <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', ...posting })}</script>
    </head><body>${body}</body></html>`;

  it('reads a branding banner together with, not instead of, the structured body (cantonal hospital)', () => {
    const banner = '<main><h1>Assistenzärztin / Assistenzarzt Medizin</h1><p>Im Herzen der Region ist das gesellschaftliche Zentrum unseres Kantons. '
      + 'Hier gibt es alles für den Alltag, ein vielseitiges kulturelles Angebot, Berge, Seen und Wanderwege direkt vor der Haustür. '
      + 'Geniessen Sie Ihre Freizeit in der Umgebung, im Sommer wie im Winter, und entdecken Sie Vereine, Märkte und Konzerte.</p></main>';
    const body = '<p>Die Klinik für Innere Medizin bietet Ihnen ein breites Ausbildungsangebot und ist als Ausbildungsklinik anerkannt.</p>'
      + '<ul><li>Betreuung stationärer Patientinnen und Patienten</li><li>Teilnahme am Dienstbetrieb</li></ul>';
    const html = jsonLdPage({ title: 'Assistenzärztin / Assistenzarzt Medizin', description: body }, banner);
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/offene-stellen/assistenzarzt/1');
    expect(description).toContain('Ausbildungsklinik anerkannt');
    expect(description).toContain('Teilnahme am Dienstbetrieb');
  });

  it('keeps the rendered body when it carries the structured teaser', () => {
    const teaser = 'Wir suchen eine engagierte Pflegefachperson für unsere Station mit Freude an der Arbeit im Team und an interdisziplinärer Zusammenarbeit.';
    const body = `<div class="job-description"><p>${teaser}</p>${TASKS}${PROFILE}</div>`;
    const html = jsonLdPage({ title: 'Pflegefachperson', description: teaser }, body);
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/job/2');
    expect(description).toContain('Mitarbeit in der Filiale');
    expect(occurrences(description, 'engagierte Pflegefachperson')).toBe(1);
  });

  it('reads only the selected inline posting on a listing page', () => {
    const own = { '@type': 'JobPosting', title: 'Oberärztin / Oberarzt Frauenmedizin', description: 'In unserer Klinik für Frauenmedizin werden jährlich rund 1800 Geburten begleitet. Ab sofort oder nach Vereinbarung suchen wir Verstärkung.' };
    const other = { '@type': 'JobPosting', title: 'Medizinische Praxisassistentin', description: 'Für unser Ambulatorium suchen wir eine Praxisassistentin mit Freude am Kontakt mit Patientinnen und Patienten.' };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [own, other] })}</script></head>
      <body><main><h1>Offene Stellen</h1><div class="job-description"><h2>${own.title}</h2><p>${own.description}</p></div>
      <div class="job-description"><h2>${other.title}</h2><p>${other.description}</p></div></main></body></html>`;
    const [ownRecord] = extractJsonLd(html, 'https://www.example.ch/karriere/jobs.html');
    const detail = extractDetailFields(html, 'https://www.example.ch/karriere/jobs.html', { recordUrl: ownRecord.url });
    expect(ownRecord.url).toContain('#job-');
    expect(detail.description).toContain('1800 Geburten');
    expect(detail.description).not.toContain('Praxisassistentin');
  });

  it('decodes HTML escaped twice in a JSON-LD description (farm business site)', () => {
    const twice = '&amp;lt;ul&amp;gt;&amp;lt;li&amp;gt;Wartung der Landmaschinen im eigenen Betrieb&amp;lt;/li&amp;gt;&amp;lt;/ul&amp;gt;'
      + '&amp;lt;span style=&amp;quot;font-size: 16px;&amp;quot;&amp;gt;Du arbeitest selbständig im Team.&amp;lt;/span&amp;gt;';
    const html = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Betriebsmechaniker:in', description: twice })}</script>`;
    const [record] = extractJsonLd(html, 'https://www.example.ch/job/betriebsmechaniker/');
    expect(record.description).toContain('Wartung der Landmaschinen im eigenen Betrieb');
    expect(record.description).toContain('Du arbeitest selbständig im Team.');
    expect(record.description).not.toMatch(/<\/?(?:ul|li|span)/);
    expect(record.description).not.toContain('font-size');
  });

  it('decodes entity-escaped HTML in a JSON-LD description (fashion retailer ATS)', () => {
    const escaped = '&lt;p&gt;&lt;span lang=&quot;EN-US&quot; style=&quot;font-family: Arial Narrow&quot;&gt;We are here to make you feel empowered.&lt;/span&gt;&lt;/p&gt;'
      + '&lt;ul&gt;&lt;li&gt;Beratung unserer Kundschaft im Store&lt;/li&gt;&lt;/ul&gt;';
    const html = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Modeberaterin 60%', description: escaped })}</script>`;
    const [record] = extractJsonLd(html, 'https://example.hire.test/jobs/1/');
    expect(record.description).toContain('We are here to make you feel empowered.');
    expect(record.description).toContain('Beratung unserer Kundschaft');
    expect(record.description).not.toContain('font-family');
    expect(record.description).not.toContain('&lt;');
  });
});

describe('review findings on #10322', () => {
  it('reads only the selected JobPosting when sibling postings carry their own description', () => {
    const posting = (title: string, body: string, href: string) => `<div itemscope itemtype="http://schema.org/JobPosting">
      <a href="${href}"><span itemprop="title">${title}</span></a>
      <span itemprop="description"><p>${body}</p></span></div>`;
    const html = `<html><body><h1>Pflegefachperson HF 80%</h1>
      ${posting('Pflegefachperson HF 80%', 'Sie betreuen Patientinnen und Patienten auf der chirurgischen Station im Schichtbetrieb.', 'https://jobs.example.ch/job/1/')}
      <aside><h2>Ähnliche Stellen</h2>
      ${posting('Fachperson Betreuung 60%', 'OTHER posting body about the kindergarten team and its daily routine.', 'https://jobs.example.ch/job/2/')}
      </aside></body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/job/1/');
    expect(description).toContain('chirurgischen Station');
    expect(description).not.toContain('OTHER posting body');
  });

  it('cuts a print layout nested inside the <main> the fallback reads', () => {
    const html = `<html><body><main>
      <h1>Conductrice / Conducteur CarPostal</h1>
      <p>Tu conduis les voyageuses et les voyageurs à leur destination du lundi au dimanche sur nos lignes régionales.</p>
      <article id="printLayout" class="print-page"><p>OTHER sample ad: Teamleiter Paketzustellung in Zürich.</p></article>
    </main></body></html>`;
    const { description } = extractDetailFields(html, 'https://job.example.ch/default/job/Conductrice/74652-fr_FR');
    expect(description).toContain('lignes régionales');
    expect(description).not.toContain('OTHER');
  });

  it('drops a vacancy container that is itself hidden', () => {
    const html = `<html><body>
      <div class="job-description hidden"><p>OTHER hidden template text for a vacancy that has been filled.</p></div>
      <div class="job-description"><p>Sie planen die Produktion und koordinieren Lieferungen mit dem Verkauf und der Logistik.</p></div>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/job/3/');
    expect(description).toContain('koordinieren Lieferungen');
    expect(description).not.toContain('OTHER');
  });
});

describe('issue 5253, run 36571839273: the body the audit reads is the ad', () => {
  it('does not read a form help text hidden by inline style as the body (InRecruiting, a-group)', () => {
    const html = `<html><body>
      <div class="card-body vacancy__sections collapse show" id="description__info"><div id="description__body">
        <h3 class="body__headings">Requirements</h3><div class="body__text"><ul><li>Gestione e ottimizzazione dei sistemi di prenotazione e dei canali di vendita online</li><li>Analisi delle performance commerciali e dei principali indicatori</li></ul></div>
      </div></div>
      <form><div class="geolocation-description text-danger" style="display: none">OTHER Select a data item from the drop-down list or enter a new one and click on Add Manually</div></form>
    </body></html>`;
    const { description } = extractDetailFields(html, 'https://inrecruiting.example/a2plus/jobs/booking-revenue-specialist-724674/en/');
    expect(description).toContain('sistemi di prenotazione');
    expect(description).not.toContain('OTHER');
  });

  it('reads a body container named by its id (InRecruiting description__body)', () => {
    const html = `<html><body><main>
      <div class="login-box"><p>Login E-Mail Password Password Recovery</p></div>
      <div id="description__body"><p>Ricerchiamo una persona che gestisca le prenotazioni e la strategia di revenue management del gruppo alberghiero.</p></div>
      <form class="apply"><p>OTHER First Name Surname E-Mail Confirm E-Mail Personal Details Date of Birth Home Address Country Postcode or City name ${'Privacy policy text. '.repeat(40)}</p></form>
    </main></body></html>`;
    const { description } = extractDetailFields(html, 'https://inrecruiting.example/jobs/x/en/');
    expect(description).toContain('revenue management');
    expect(description).not.toContain('OTHER');
  });

  it('cuts a «Similar jobs» section that carries other complete ads (hotel careers, kronenhof)', () => {
    const other = '<article><a href="/en/vacancies/731"><h3>OTHER Demi Chef de Partie</h3><p>OTHER complete ad of another vacancy with its own tasks and profile.</p></a></article>';
    const html = `<html><body><main>
      <h1>Chef de Rang - immediate start (m/w/d)</h1>
      <div class="prose"><h2>This is you</h2><ul><li>Completed training in hospitality or equivalent practical experience</li></ul></div>
      <section class="entry border-gray mt-12"><div class="flex"><h2> Similar jobs </h2><a href="/en/vacancies">See all jobs</a></div><div>${other.repeat(3)}</div></section>
    </main></body></html>`;
    const { description } = extractDetailFields(html, 'https://careers.hotel.example/en/vacancies/716');
    expect(description).toContain('Completed training in hospitality');
    expect(description).not.toContain('OTHER');
  });

  it('cuts a similar-jobs slider whose teasers carry description classes (Prospective, srg-ssr)', () => {
    const html = `<html><body><main id="main">
      <div id="content"><h1>Fufragnadi - emprendissadi da prova</h1><div class="job-description"><p>RTR è in'unitad d'interpresa da la SRG SSR e la chasa da medias per la Svizra rumantscha.</p></div></div>
      <section id="similar-jobs" class="sixteen wide column"><h2>Ulteriuras Plazzas</h2><div class="similar-jobs-slider">
        <div class="slide job"><h1 class="job-title">OTHER HMS-Praktikum</h1><div class="description">OTHER Die SRG SSR bildet motivierte Lernende in unterschiedlichen Lehrberufen aus.</div></div>
      </div></section>
    </main></body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/rtr/offene-stellen/fufragnadi/b6e22b31');
    expect(description).toContain('Svizra rumantscha');
    expect(description).not.toContain('OTHER');
  });

  it("keeps a section whose heading is this vacancy's own title", () => {
    const html = `<html><body><h1>Pflegefachperson HF</h1><section class="related-jobs"><h2>Pflegefachperson HF</h2><div class="job-description"><p>Sie betreuen Patientinnen und Patienten auf der Bettenstation und planen die Pflege.</p></div></section></body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.example.ch/stelle/1', {});
    expect(description).toContain('planen die Pflege');
  });

  it('reads the prose layout tokens of a jobs2web ad whose only itemprop description is the contact card (PostFinance, Mobiliar)', () => {
    const token = (inner: string, itemprop = false) => `<div class="joblayouttoken displayDTM "><div class="inner"><div class="row"><div class="col-xs-12"><span lang="de-DE" ${itemprop ? 'itemprop="description" ' : ''}class="rtltextaligneligible">${inner}</span></div></div></div></div>`;
    const body = 'Im Compliance Office stellst du sicher, dass alle gesetzlichen und regulatorischen Vorgaben im Umgang mit Firmenkundinnen und Firmenkunden erfüllt werden. Du erkennst Risiken frühzeitig, klärst sie direkt mit den Kundinnen und Kunden und dokumentierst deine Erkenntnisse in präzisen Berichten für die Geschäftsleitung.';
    const html = `<html><body><div itemscope itemtype="http://schema.org/JobPosting">
      ${token('Mitarbeiter:in Compliance Office Firmenkunden')}${token('80')}${token('100')}${token('Bern|Bern|BE|Schweiz|CHE')}
      ${token(`<ul><li>${body}</li></ul>`)}
      ${token('Max Muster Compliance Officer [[cust_secondRecruiterPhone]] Erika Beispiel +41 58 000 00 00', true)}
    </div></body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.bank.example/job/Compliance/74803-de_DE');
    expect(description).toContain('Im Compliance Office stellst du sicher');
    expect(description).not.toContain('Bern|Bern');
  });

  it('reads the answers of a BrassRing job detail, not its Angular templates (UBS HomeWithPreLoad)', () => {
    const html = `<html><body><div class="jobDetailsContainer" ng-if="jobs.length > 0 && tgSettings.IsSRCFlow=='no'">
      <p>OTHER You have already applied for this job. {{LimitExceededMessage}} ${'Choose your sign in option {{dynamicStrings.Button_LogIn}}. '.repeat(30)}</p>
      <p class="section2LeftfieldsInJobDetails jobDetailTextArea question thick">Your role</p>
      <p class="section2LeftfieldsInJobDetails jobDetailTextArea answer">Do you want to translate content from English and German into French for our digital products?<br/>• help shape a consistent voice and terminology</p>
      <p class="section2LeftfieldsInJobDetails jobDetailTextArea question thick">About us</p>
      <p class="section2LeftfieldsInJobDetails jobDetailTextArea answer">We are a leading global wealth manager headquartered in Zurich.</p>
    </div></body></html>`;
    const { description } = extractDetailFields(html, 'https://jobs.bank.example/TGnewUI/Search/Home/HomeWithPreLoad?jobid=348358&PageType=jobdetails');
    expect(description).toContain('translate content from English');
    expect(description).toContain('leading global wealth manager');
    expect(description).not.toContain('OTHER');
  });

  it('keeps the lists of the body as `- item` lines (anker-swiss)', () => {
    const html = `<html><body><section class="job-details"><h3>Deine Herausforderung:</h3><ul><li>allgemeine Fassadenarbeiten</li><li><p>kleinere Gipserarbeiten</p></li></ul><p>Ab sofort<br>oder nach Vereinbarung</p></section></body></html>`;
    const { description } = extractDetailFields(html, 'https://anker.example/stellen/maler-1274176/');
    expect(description.split('\n')).toEqual(['Deine Herausforderung:', '- allgemeine Fassadenarbeiten', '- kleinere Gipserarbeiten', 'Ab sofort', 'oder nach Vereinbarung']);
  });

  it('keeps the line structure of a JSON-LD description written as plain text lines (grischapersonal)', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'CAD-ZEICHNER (m/w/d)', description: 'Für unseren Kunden suchen wir\r\n\r\n<strong>Aufgaben</strong>\r\n\r\n- Erstellung von Plänen\r\n- Koordination mit Bauherrschaften' })}</script>`;
    const [record] = extractJsonLd(html, 'https://grischapersonal.example/stellen/');
    expect(record.description.split('\n')).toEqual(['Für unseren Kunden suchen wir', 'Aufgaben', '- Erstellung von Plänen', '- Koordination mit Bauherrschaften']);
  });
});
