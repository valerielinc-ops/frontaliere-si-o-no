import { describe, expect, it } from 'vitest';
import { applicationEntryControls, isVerifiedPostingEntry, startsApplication } from '../scripts/assisted-application/lib/portal/portal.mjs';

const postingUrl = 'https://jobs.fictional-employer.test/job/customer-success-manager/990021/';
const applyUrl = 'https://career55.sapsf.eu/career?company=Fixture&career_job_req_id=77123&career_ns=job_application';
const postingRouteProof = { via: 'successfactors', applyUrl, postingUrl };
const job = { company: 'Fictional Employer GmbH', title: 'Customer Success Manager' };
const context = { applyUrl, postingUrl, postingRouteProof, job };

const postingSnapshot = (controls: any[], patch: Record<string, unknown> = {}) => ({
  url: postingUrl,
  title: 'Customer Success Manager | Fictional Employer',
  text: 'Fictional Employer GmbH\nCustomer Success Manager\nPostes vacants',
  fields: [],
  buttons: controls,
  links: [],
  ...patch,
});

describe('SuccessFactors Career Site Builder employer-domain posting entries', () => {
  it.each([
    ['French', 'Postuler »»'],
    ['German', 'Bewerben »»'],
    ['Italian', 'Candidati »»'],
    ['English', 'Apply »»'],
  ])('selects one duplicated %s Apply entry and ignores site chrome', (_locale, label) => {
    const top = { id: 'apply-top', text: label, chrome: true };
    const bottom = { id: 'apply-bottom', text: label, chrome: true };
    const controls = [
      { id: 'search', text: 'Rechercher les offres', chrome: true },
      { id: 'reset', text: 'Réinitialiser', chrome: true },
      { id: 'alert', text: 'Créer une alerte', chrome: true },
      { id: 'spontaneous', text: 'Candidature spontanée', chrome: true },
      { id: 'profile', text: 'Mon profil de candidature', chrome: true },
      { id: 'language', text: 'Langue', chrome: true },
      top,
      bottom,
    ];

    expect(startsApplication(label)).toBe(true);
    expect(applicationEntryControls(postingSnapshot(controls), context)).toEqual([top]);
  });

  it('binds a custom-domain posting through the SuccessFactors requisition route proof', () => {
    expect(isVerifiedPostingEntry({ applyUrl, postingUrl, postingRouteProof })).toBe(true);
    expect(applicationEntryControls(postingSnapshot([
      { id: 'apply', text: 'Postuler »»', chrome: true },
    ]), context)).toHaveLength(1);
    expect(applicationEntryControls(postingSnapshot([
      { id: 'apply', text: 'Postuler »»', chrome: true },
    ], { url: postingUrl.replace('990021', '990022') }), context)).toEqual([]);
  });

  it('also requires the selected title or employer when no resolver route proof exists', () => {
    const noRouteProof = { applyUrl, postingUrl, job };
    const apply = { id: 'apply', text: 'Postuler »»', chrome: true };
    expect(applicationEntryControls(postingSnapshot([apply]), noRouteProof)).toEqual([apply]);
    expect(applicationEntryControls(postingSnapshot([apply], {
      text: 'Another Employer\nOffice Coordinator',
      title: 'Another Employer careers',
    }), noRouteProof)).toEqual([]);
  });

  it('still recognizes the matched posting when the employer header exposes search fields', () => {
    const apply = { id: 'apply', text: 'Postuler »»', chrome: true };
    const snapshot = postingSnapshot([apply], {
      fields: [{ id: 'job-search', kind: 'text', inputType: 'text', label: 'Rechercher les offres' }],
    });

    expect(applicationEntryControls(snapshot, context)).toEqual([apply]);
  });

  it('accepts a direct custom-domain Apply link, including when the portal marks it as chrome', () => {
    const top = { id: 'apply-top', text: 'Postuler »»', href: applyUrl, chrome: true };
    const bottom = { id: 'apply-bottom', text: 'Postuler »»', href: applyUrl, chrome: true };
    const snapshot = postingSnapshot([], {
      links: [
        { id: 'spontaneous', text: 'Candidature spontanée', href: `${postingUrl}#spontaneous`, chrome: true },
        top,
        bottom,
      ],
    });

    expect(applicationEntryControls(snapshot, context)).toEqual([top]);
  });

  it('does not choose among differently named or requisition-conflicting Apply controls', () => {
    const ambiguous = postingSnapshot([
      { id: 'apply-top', text: 'Postuler »»', chrome: true },
      { id: 'apply-bottom', text: 'Bewerben »»', chrome: true },
    ]);
    const wrongTarget = postingSnapshot([
      { id: 'apply', text: 'Postuler »»', href: applyUrl.replace('77123', '77124'), chrome: true },
    ]);
    expect(applicationEntryControls(ambiguous, context)).toEqual([]);
    expect(applicationEntryControls(wrongTarget, context)).toEqual([]);
  });

  it('accepts a matching SuccessFactors public apply id on its tenant host', () => {
    const publicApplyUrl = 'https://career55.sapsf.eu/talentcommunity/apply/990021/';
    expect(isVerifiedPostingEntry({ applyUrl: publicApplyUrl, postingUrl })).toBe(true);
  });

  it('requires route proof before binding a cross-origin public apply id', () => {
    const publicApplyUrl = 'https://career55.sapsf.eu/talentcommunity/apply/990021/';
    const unrelatedPostingUrl = 'https://unrelated.example/job/other/990021/';
    expect(isVerifiedPostingEntry({ applyUrl: publicApplyUrl, postingUrl: unrelatedPostingUrl })).toBe(false);
    expect(isVerifiedPostingEntry({
      applyUrl: publicApplyUrl,
      postingUrl: unrelatedPostingUrl,
      postingRouteProof: { via: 'successfactors', applyUrl: publicApplyUrl, postingUrl: unrelatedPostingUrl },
    })).toBe(true);
  });

  it('does not treat an unbound same-tenant career shell as this posting continuation', () => {
    const genericCareer = { id: 'generic-career', text: 'Postuler »»', href: 'https://career55.sapsf.eu/career/' };
    expect(applicationEntryControls(postingSnapshot([genericCareer]), context)).toEqual([]);
  });

  it('keeps the posting-bound Apply entry when an unrelated Apply link is also present', () => {
    const bound = { id: 'bound', text: 'Postuler »»', href: applyUrl, chrome: true };
    const unrelated = {
      id: 'unrelated',
      text: 'Postuler »»',
      href: 'https://unrelated.example/job/other/990021/',
      chrome: true,
    };
    expect(applicationEntryControls(postingSnapshot([bound, unrelated]), context)).toEqual([bound]);
  });
});
