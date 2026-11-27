import { describe, expect, it } from 'vitest';
import { formPostingMatch, keepsProvenSuccessFactorsModule } from '../scripts/assisted-application/lib/portal/portal.mjs';

// City career site handing off to a SuccessFactors tenant (public posting data, synthetic tokens). After sign-in
// the form is served at a session address (`/portalcareer?_s.crb=…`) that carries neither the company nor the
// requisition; the only identity on the page is the H1 «Role (requisition)» of the module route the order has.
const moduleUrl = (requisition = '52113', company = 'STZH') =>
  `https://career2.successfactors.eu/career?company=${company}&career_job_req_id=${requisition}&lang=de_DE&career_ns=job_application`;
const postingUrl = 'https://jobs.stadt-zuerich.ch/job/Vermessungsassistentin/1376278557/';
const pageUrl = 'https://career2.successfactors.eu/portalcareer?_s.crb=synthetictoken';
const job = { title: 'Vermessungsassistent*in', company: 'Stadt Zürich' };
const h1 = 'Vermessungsassistent*in (52113)';
const page = (heading: string) => [
  'Stadt Zürich', 'Abmelden', 'Optionen', 'Deutsch', heading,
  'Herzlich willkommen bei der Stadt Zürich.',
  'Bitte laden Sie im Abschnitt «Meine Bewerbungsunterlagen» alle geforderten Dokumente hoch und vervollständigen Sie die weiteren Informationen. Pflichtfelder sind mit einem Stern (*) gekennzeichnet.',
  'Wir freuen uns auf Ihre Bewerbung.',
  'Meine Bewerbungsunterlagen', '* Lebenslauf', 'Motivationsschreiben', 'Weitere Unterlagen (Diplome/Zeugnisse/usw.)',
  'Profilinformationen', 'Stellenspezifische Informationen', 'Profil anzeigen', 'Speichern', 'Bewerben', pageUrl,
].join('\n');
const run = (heading: string, headings: string[], { proof = true, applyUrl = moduleUrl() } = {}) => formPostingMatch(page(heading), job, {
  postingEntry: true, postingMatched: true, pageUrl, postingUrl, paidPostingUrl: postingUrl,
  pageHeadings: headings, pageHeading: '', formFieldLabels: ['Sprache'], applyUrl,
  postingRouteProof: proof ? { via: 'successfactors', applyUrl, postingUrl } : null,
});

describe('SuccessFactors session form of a city posting', () => {
  it('binds the form whose H1 is the order role with the requisition of the order module route', () => {
    const headings = [h1, 'Herzlich willkommen bei der Stadt Zürich.', 'Wir freuen uns auf Ihre Bewerbung.', 'Meine Bewerbungsunterlagen', 'Profilinformationen', 'Stellenspezifische Informationen'];
    expect(run(h1, headings)).toBe('match');
    expect(run(h1, headings, { proof: false })).toBe('match');
  });

  it('does not read the tenant welcome copy exposed as a heading as another employer', () => {
    expect(run(h1, [h1, 'Wir freuen uns auf Ihre Bewerbung.'])).toBe('match');
  });

  it('stays a mismatch for another requisition, even without the resolver proof, and for another employer heading', () => {
    expect(run('Vermessungsassistent*in (52114)', ['Vermessungsassistent*in (52114)'])).toBe('mismatch');
    expect(run('Vermessungsassistent*in (52114)', ['Vermessungsassistent*in (52114)'], { proof: false })).toBe('mismatch');
    expect(run(h1, [h1, 'Bewerbung bei Siemens AG'])).toBe('mismatch');
  });
});

describe('re-resolution of a SuccessFactors order', () => {
  const generic = 'https://career2.successfactors.eu/careers?company=STZH';

  it('keeps the module route when the posting resolves to the same tenant careers page without a requisition', () => {
    expect(keepsProvenSuccessFactorsModule(moduleUrl(), generic)).toBe(true);
    expect(keepsProvenSuccessFactorsModule(moduleUrl(), 'https://career2.successfactors.eu/careers?company=stzh&lang=de_DE')).toBe(true);
  });

  it('takes the new resolution for another tenant, host, requisition or a non SuccessFactors route', () => {
    expect(keepsProvenSuccessFactorsModule(moduleUrl(), 'https://career2.successfactors.eu/careers?company=OTHER')).toBe(false);
    expect(keepsProvenSuccessFactorsModule(moduleUrl(), 'https://career5.successfactors.eu/careers?company=STZH')).toBe(false);
    expect(keepsProvenSuccessFactorsModule(moduleUrl(), moduleUrl('99999'))).toBe(false);
    expect(keepsProvenSuccessFactorsModule(moduleUrl(), moduleUrl())).toBe(false);
    expect(keepsProvenSuccessFactorsModule(moduleUrl(), 'https://example.test/careers?company=STZH')).toBe(false);
    expect(keepsProvenSuccessFactorsModule(generic, moduleUrl())).toBe(false);
    expect(keepsProvenSuccessFactorsModule('', generic)).toBe(false);
  });
});
