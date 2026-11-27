import { describe, expect, it } from 'vitest';
import { formPostingMatch, namesAnotherEmployer } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Real page lines of the dry run of a city posting on SuccessFactors (public posting data; the candidate's file
// name replaced by <file>). The document title «Karrierechancen: Für <role> (<requisition>) bewerben» was read as
// another employer because «für» is not in the page vocabulary, and so was the unbound module route.
const applyUrl = 'https://career2.successfactors.eu/career?company=STZH&career_job_req_id=52113&lang=de_DE&career_ns=job_application';
const postingUrl = 'https://jobs.stadt-zuerich.ch/job/Vermessungsassistentin/1376278557/';
const pageUrl = 'https://career2.successfactors.eu/portalcareer?company=STZH&correlation_Id=synthetic&lang=de_DE&clientId=jobs2web&socialApply=false&career_ns=job_application&site=&career_job_req_id=52113&jobPipeline=RCM+&isInternalUser=false&showAlertCreated=false&_s.crb=synthetictoken';
const job = { title: 'Vermessungsassistent*in', company: 'Stadt Zürich', titleByLocale: { it: 'Geometra', en: 'Surveying assistant', fr: 'Assistant e en arpentage' } };
const h1 = 'Vermessungsassistent*in (52113)';
const documentTitle = 'Karrierechancen: Für Vermessungsassistent*in (52113) bewerben';
const body = [
  'Stadt Zürich', 'Abmelden', 'Optionen', 'Deutsch', h1, 'Herzlich willkommen bei der Stadt Zürich.',
  'Bitte laden Sie im Abschnitt «Meine Bewerbungsunterlagen» alle geforderten Dokumente hoch und vervollständigen Sie die weiteren Informationen.',
  'Pflichtfelder sind mit einem Stern (*) gekennzeichnet.', 'Alle Abschnitte einblenden', 'Alle Abschnitte ausblenden',
  'Zulässige Dateiformate: Microsoft Word (DOCX), PDF, Bild und Text (max. 10MB pro Datei)',
  'Meine Bewerbungsunterlagen', 'Lebenslauf', 'Dokument herunterladen <file> Zuletzt geändert: 27.11.2026 Erforderlich', '<file>',
  'Dokument <file> bearbeiten Öffnet ein Dialogfeld', 'Profilinformationen', 'Stellenspezifische Informationen', 'Profil anzeigen', 'Speichern', 'Bewerben',
];
const run = (title: string, { headings = [h1], entry = applyUrl, proof = true, lines = body, at = pageUrl } = {}) => formPostingMatch([title, ...lines, at].join('\n'), job, {
  postingUrl: entry, paidPostingUrl: postingUrl, pageUrl: at, pageHeadings: headings, pageHeading: headings.length === 1 ? headings[0] : '',
  formFieldLabels: [], applyUrl, postingRouteProof: proof ? { via: 'successfactors', applyUrl, postingUrl } : null,
});

describe('a title line that holds the role and only grammar names no other employer', () => {
  it('binds the real page whether the run opened the module or the posting', () => {
    expect(run(documentTitle)).toBe('match');
    expect(run(documentTitle, { entry: postingUrl })).toBe('match');
    expect(run(documentTitle, { proof: false })).toBe('match');
  });

  it('does not read grammatical words of a call to apply as an employer', () => {
    for (const line of [documentTitle, 'Für Vermessungsassistent*in (52113) bewerben', 'Apply for Vermessungsassistent*in (52113)', 'Postulez pour Vermessungsassistent*in (52113)']) {
      expect(namesAnotherEmployer(line, job)).toBe(false);
    }
  });

  it('keeps a title or heading that names another employer positively a conflict', () => {
    expect(run('Karrierechancen: Für Vermessungsassistent*in (52113) bewerben bei Siemens AG')).toBe('mismatch');
    expect(run('Karrierechancen: Vermessungsassistent*in (52113) | Siemens AG')).toBe('mismatch');
    expect(run('Karrierechancen: Für Vermessungsassistent*in (52113) bewerben | Other Resort')).toBe('mismatch');
    expect(run(documentTitle, { headings: [h1, 'Bewerbung bei Siemens AG'] })).toBe('mismatch');
  });

  it('stays a mismatch for another requisition, even when the title line is the same', () => {
    expect(run(documentTitle, { headings: ['Vermessungsassistent*in (52114)'] })).toBe('mismatch');
  });

  it('stays a mismatch when the address names another requisition than the order module', () => {
    expect(run(documentTitle, { at: pageUrl.replace('career_job_req_id=52113', 'career_job_req_id=52114') })).toBe('mismatch');
  });

  it('keeps an unbound module route a conflict when no requisition of the order is shown', () => {
    const noRequisition = ['Stadt Zürich', 'Abmelden', 'Meine Bewerbungsunterlagen', 'Speichern', 'Bewerben'];
    expect(run('Karrierechancen: Für Vermessungsassistent*in bewerben', { headings: ['Vermessungsassistent*in'], lines: noRequisition })).toBe('mismatch');
  });
});
