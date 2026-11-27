import { describe, expect, it } from 'vitest';
import { formPostingMatch } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic rebuild of a city career site that hands off to a SuccessFactors tenant: the order's posting is on
// the city's own site, its apply route is the tenant's module, and the final application page carries the
// requisition caption but a portal title/heading that is not the order's employer or role words.
const applyUrl = 'https://career2.successfactors.eu/career?company=EXAMPLECITY&career_job_req_id=52113&lang=de_DE&career_ns=job_application';
const postingUrl = 'https://jobs.example-city.test/job/Sachbearbeiter-Controlling/52113-de/';
const pageUrl = 'https://career2.successfactors.eu/portalcareer?company=EXAMPLECITY&correlation_Id=synthetic&lang=de_DE&clientId=jobs2web&socialApply=false&career_ns=job_application&site=&career_job_req_id=52113&jobPipeline=RCM+';
const proof = { via: 'successfactors', applyUrl, postingUrl };
const role = 'Sachbearbeiter Controlling (m/w/d)';
const job = { title: role, company: 'Departement Hochbau' };
const body = ['Optionen', 'Sprache', 'Meine Bewerbungsunterlagen', '* Lebenslauf', 'Motivationsschreiben',
  'Profilinformationen', 'Stellenspezifische Informationen', 'Profil anzeigen', 'Speichern', 'Bewerben'];
const form = (...lines: string[]) => [...lines, ...body, pageUrl].join('\n');
const opts = {
  postingMatched: true, postingEntry: true, pageUrl, postingUrl, paidPostingUrl: postingUrl,
  postingRouteProof: proof, applyUrl, formFieldLabels: ['Sprache'],
};

describe('SuccessFactors final page on the route proven for the posting', () => {
  it('binds the form that shows the role with the requisition of the proven route', () => {
    // The tenant titles its page with its own name: an employer heading and a role-like first line.
    const text = form('Zürcher Stellen', 'Zürcher Stellen', `${role} (52113)`);
    expect(formPostingMatch(text, job, { ...opts, pageHeading: 'Zürcher Stellen', pageHeadings: ['Zürcher Stellen'] })).toBe('match');
    expect(formPostingMatch(form('Karriere Stadt Zürich', `${role} (52113)`), job, { ...opts, pageHeadings: ['Karriere Stadt Zürich'] })).toBe('match');
  });

  it('stays a mismatch when the requisition, the role or the route is not the proven one', () => {
    const wrongId = form('Zürcher Stellen', `${role} (52114)`);
    expect(formPostingMatch(wrongId, job, { ...opts, pageHeadings: ['Zürcher Stellen'] })).toBe('mismatch');
    const otherRole = form('Zürcher Stellen', 'Projektleiter Hochbau (52113)');
    expect(formPostingMatch(otherRole, job, { ...opts, pageHeadings: ['Zürcher Stellen'] })).toBe('mismatch');
    const twoIds = form('Zürcher Stellen', `${role} (52113) (52114)`);
    expect(formPostingMatch(twoIds, job, { ...opts, pageHeadings: ['Zürcher Stellen'] })).toBe('mismatch');
    // A different requisition in the address is not the module the resolver proved.
    const otherRoute = pageUrl.replace('career_job_req_id=52113', 'career_job_req_id=52114');
    expect(formPostingMatch(form('Zürcher Stellen', `${role} (52113)`), job, { ...opts, pageUrl: otherRoute, pageHeadings: ['Zürcher Stellen'] })).toBe('mismatch');
    // Another tenant host with the same ids is not the proven tenant.
    const otherHost = pageUrl.replace('career2', 'career5');
    expect(formPostingMatch(form('Zürcher Stellen', `${role} (52113)`), job, { ...opts, pageUrl: otherHost, pageHeadings: ['Zürcher Stellen'] })).toBe('mismatch');
  });

  it('needs the resolver proof: the same text without it is not bound by the requisition alone', () => {
    const text = form('Zürcher Stellen', `${role} (52113)`);
    expect(formPostingMatch(text, job, { ...opts, postingRouteProof: null, pageHeadings: ['Zürcher Stellen'] })).not.toBe('match');
  });
});
