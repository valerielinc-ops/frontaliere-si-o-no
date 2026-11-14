import { describe, expect, it } from 'vitest';
import { formPostingMatch, successFactorsRequisitionShown } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Stellenportal Bund, order eHSYErA1 (2026-11-10): after sign-in SuccessFactors serves the application form at
// /portalcareer, whose address carries neither the company nor the requisition, and the federal page names no
// employer the order's data names. Rebuilt from the decrypted stop report, page text only (no candidate data).
const job = { title: 'Application Manager/-in', company: 'Swiss Armed Forces (VTG)' };
const applyUrl = 'https://career74.sapsf.eu/career?company=bundesamtf&career_ns=job_application&career_job_req_id=20604&jobPipeline=bundinternetde&lang=de_DE';
const pageUrl = 'https://career74.sapsf.eu/portalcareer?_s.crb=synthetic';
const form = (heading: string) => [
  'Stellenportal Bund',
  'Schweizerische Eidgenossenschaft Confédération suisse Confederazione Svizzera Confederaziun svizra',
  'Stellenportal Bund Abmelden Optionen Deutsch',
  heading,
  'Bewerbungsprofil',
  'Meine Dokumente',
  '* Lebenslauf Lebenslauf hinzufügen Öffnet ein Dialogfeld',
  'Meine persönlichen Informationen',
  'Stellenspezifische Informationen',
  'Bewerbungsprofil anzeigen Speichern Bewerben',
  'Eidgenössisches Personalamt EPA',
  pageUrl,
].join('\n');

describe('SuccessFactors after sign-in: the requisition the runner entered binds its form', () => {
  it('matches the form that shows the role with the requisition of the apply address', () => {
    expect(formPostingMatch(form('Application Manager/-in (20604)'), job, { pageUrl })).toBe('mismatch');
    expect(formPostingMatch(form('Application Manager/-in (20604)'), job, { pageUrl, applyUrl })).toBe('match');
    expect(successFactorsRequisitionShown(form('Application Manager/-in (20604)'), job, { pageUrl, applyUrl })).toBe(true);
    expect(formPostingMatch(form('Application Manager/-in (H/F) (20604)'), job, { pageUrl, applyUrl })).toBe('match');
    expect(formPostingMatch(form('Application Manager/-in (M/F/D) (20604)'), job, { pageUrl, applyUrl })).toBe('match');
  });

  it('never matches another posting', () => {
    // Another requisition, another role, two requisitions, a role without its requisition.
    expect(formPostingMatch(form('Application Manager/-in (20605)'), job, { pageUrl, applyUrl })).toBe('mismatch');
    expect(formPostingMatch(form('Projektleiter/-in Informatik (20604)'), job, { pageUrl, applyUrl })).toBe('mismatch');
    expect(formPostingMatch(form('Application Manager/-in (20604) (20605)'), job, { pageUrl, applyUrl })).toBe('mismatch');
    expect(formPostingMatch(form('Application Manager/-in'), job, { pageUrl, applyUrl })).toBe('mismatch');
    // The requisition next to a longer heading that names another role or employer.
    expect(formPostingMatch(form('Senior Application Manager/-in Logistikbasis der Armee (20604)'), job, { pageUrl, applyUrl })).toBe('mismatch');
    // A single non-title word is already another role (review of #17984).
    expect(formPostingMatch(form('Senior Application Manager/-in (20604)'), job, { pageUrl, applyUrl })).toBe('mismatch');
    // A non-title word shorter than three characters is another role too.
    expect(formPostingMatch(form('IT Application Manager/-in (20604)'), job, { pageUrl, applyUrl })).toBe('mismatch');
    // The requisition binding itself refuses any extra word, short or long (review of #17984).
    for (const heading of ['Senior Application Manager/-in (20604)', 'IT Application Manager/-in (20604)', 'Application Manager/-in bei X (20604)']) {
      expect(successFactorsRequisitionShown(form(heading), job, { pageUrl, applyUrl })).toBe(false);
    }
    // Gender markers the portal adds to the title name no other role.
    expect(formPostingMatch(form('Application Manager/-in (m/w/d) (20604)'), job, { pageUrl, applyUrl })).toBe('match');
    // The candidate's home or the list of applications: no role heading with this requisition.
    expect(formPostingMatch(['Stellenportal Bund', 'Meine Bewerbungen', 'Application Manager/-in', 'Status: Entwurf', pageUrl].join('\n'), job, { pageUrl, applyUrl })).toBe('mismatch');
    // Another SuccessFactors host, or an apply address that is not a job-application module.
    expect(formPostingMatch(form('Application Manager/-in (20604)'), job, { pageUrl: pageUrl.replace('career74', 'career5'), applyUrl })).toBe('mismatch');
    expect(formPostingMatch(form('Application Manager/-in (20604)'), job, {
      pageUrl, applyUrl: applyUrl.replace('career_ns=job_application', 'career_ns=job_listing'),
    })).toBe('mismatch');
    expect(formPostingMatch(form('Application Manager/-in (20604)'), job, { pageUrl: 'https://career74.sapsf.eu/xi/ui/rcmcareer', applyUrl })).toBe('mismatch');
  });
});
