import { describe, expect, it } from 'vitest';
import { formPostingMatch } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Final application page of a city career site that hands off to a SuccessFactors tenant (public posting data):
// the order's posting is on the city's own site, its apply route is the tenant's module, and the page shows the
// role with the requisition (H1) plus the tenant's German section captions, which the browser can expose as
// headings. The captions were read as «another employer» and ended the run on `posting_unbound`.
const applyUrl = 'https://career2.successfactors.eu/career?company=STZH&career_job_req_id=52113&lang=de_DE&career_ns=job_application';
const postingUrl = 'https://jobs.stadt-zuerich.ch/job/Vermessungsassistentin/1376278557/';
const pageUrl = 'https://career2.successfactors.eu/portalcareer?company=STZH&correlation_Id=synthetic&lang=de_DE&clientId=jobs2web&socialApply=false&career_ns=job_application&site=&career_job_req_id=52113&jobPipeline=RCM+';
const proof = { via: 'successfactors', applyUrl, postingUrl };
const job = { title: 'Vermessungsassistent*in', company: 'Stadt Zürich' };
const h1 = 'Vermessungsassistent*in (52113)';
const page = (heading = h1) => [
  'Stadt Zürich', 'Abmelden', 'Optionen', 'Deutsch', heading,
  'Herzlich willkommen bei der Stadt Zürich.',
  'Bitte laden Sie im Abschnitt «Meine Bewerbungsunterlagen» alle geforderten Dokumente hoch und vervollständigen Sie die weiteren Informationen. Pflichtfelder sind mit einem Stern (*) gekennzeichnet.',
  'Wir freuen uns auf Ihre Bewerbung.',
  'Meine Bewerbungsunterlagen', '* Lebenslauf', 'Motivationsschreiben', 'Weitere Unterlagen (Diplome/Zeugnisse/usw.)',
  'Profilinformationen', 'Stellenspezifische Informationen', 'Profil anzeigen', 'Speichern', 'Bewerben', pageUrl,
].join('\n');
const opts = {
  postingMatched: true, postingEntry: true, pageUrl, postingUrl, paidPostingUrl: postingUrl,
  postingRouteProof: proof, applyUrl, formFieldLabels: ['Sprache'],
};
const withHeadings = (pageHeadings: string[], extra = {}) => ({ ...opts, pageHeadings, pageHeading: pageHeadings.length === 1 ? pageHeadings[0] : '', ...extra });

describe('SuccessFactors final page of a city posting', () => {
  it('binds the form whose H1 is the role with the proven requisition', () => {
    expect(formPostingMatch(page(), job, withHeadings([h1]))).toBe('match');
  });

  it('does not read the tenant section captions exposed as headings as another employer', () => {
    for (const captions of [['Meine Bewerbungsunterlagen'], ['Profilinformationen'], ['Stellenspezifische Informationen'],
      [h1, 'Meine Bewerbungsunterlagen', 'Profilinformationen', 'Stellenspezifische Informationen']]) {
      expect(formPostingMatch(page(), job, withHeadings(captions))).toBe('match');
    }
  });

  it('keeps German gender forms of the same title (*in, :in, _in, /in) bound to the same requisition', () => {
    for (const form of ['Vermessungsassistent*in', 'Vermessungsassistent:in', 'Vermessungsassistent_in', 'Vermessungsassistent/in']) {
      expect(formPostingMatch(page(`${form} (52113)`), { ...job, title: form }, withHeadings([`${form} (52113)`]))).toBe('match');
    }
  });

  it('stays a mismatch for another employer heading, another requisition, another role or another route', () => {
    expect(formPostingMatch(page('Bewerbung bei Siemens AG'), job, withHeadings(['Bewerbung bei Siemens AG']))).toBe('mismatch');
    expect(formPostingMatch(page('Vermessungsassistent*in (52114)'), job, withHeadings(['Vermessungsassistent*in (52114)']))).toBe('mismatch');
    expect(formPostingMatch(page('Projektleiter Hochbau (52113)'), job, withHeadings(['Projektleiter Hochbau (52113)']))).toBe('mismatch');
    const otherRoute = pageUrl.replace('career_job_req_id=52113', 'career_job_req_id=52114');
    expect(formPostingMatch(page().replace(pageUrl, otherRoute), job, withHeadings([h1], { pageUrl: otherRoute }))).toBe('mismatch');
  });
});
