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
 *   and `jobBenefits` was read from `description` alone.
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
