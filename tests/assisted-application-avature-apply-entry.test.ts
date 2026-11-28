import { describe, expect, it } from 'vitest';
import {
  applicationEntryControlMatchesSelectedPosting,
  applicationEntryControls,
  avatureApplyEntryBelongsToPosting,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { refusal } from '../scripts/assisted-application/lib/portal/agent.mjs';

// Synthetic Avature posting page: fieldless, one styled «Apply» anchor to the portal Login view of the same
// requisition id, plus a cookie control that is site chrome.
const ORIGIN = 'https://careers.example.test';
const POSTING = `${ORIGIN}/ExampleCareers/JobDetail/Senior-Example-Role/4711`;
const protocol = {
  vendor: 'avature', portalId: '23', namespace: '/ExampleCareers', page: 'JobDetail', origin: ORIGIN,
  path: '/ExampleCareers/JobDetail/Senior-Example-Role/4711',
  quoted: { portalId: '23', urlPath: 'ExampleCareers', page: 'JobDetail', applicationName: 'customPortal', applicationCode: 'customPortal_23' },
};
const applyHref = `${ORIGIN}/ExampleCareers/Login?jobId=4711`;
const context = {
  applyUrl: POSTING, postingUrl: POSTING, sourceProtocol: protocol, postingRouteProof: null,
  job: { company: 'Example Advisory AG', title: 'Senior Example Role' },
  // Not proved by the employer name: the proof under test must stand without it.
  allowSingleExternalApplicationEntry: false,
};
const snapshot = (href = applyHref) => ({
  url: POSTING, fields: [], links: [], dialogs: [],
  buttons: [{ id: 'e1', text: 'Apply', label: 'Apply', href, frame: 0 }, { id: 'e2', text: 'Customise Cookies', chrome: true }],
});

describe('Avature posting page: the Apply anchor is the application entry', () => {
  it('binds the entry by the requisition id in the Login URL, without the employer name', () => {
    const snap = snapshot();
    const entries = applicationEntryControls(snap as any, context as any);
    expect(entries).toHaveLength(1);
    expect(applicationEntryControlMatchesSelectedPosting({ name: 'Apply', href: applyHref } as any, entries, snap as any, context as any)).toBe(true);
  });

  it('lets the runner open it (not the reserved final submit) on a fieldless posting page', () => {
    const info = { button: true, name: 'Apply', leaves: true, inForm: false, submits: false, href: applyHref };
    expect(refusal({ action: 'click' } as any, info as any, { navigationEnabled: true, allowApplicationEntry: true })).toBe('');
    // Not proved: the same control stays reserved.
    expect(refusal({ action: 'click' } as any, info as any, { navigationEnabled: true, allowApplicationEntry: false })).toBe('final_submit_reserved');
  });

  it.each([
    ['another requisition id', `${ORIGIN}/ExampleCareers/Login?jobId=9999`],
    ['an extra parameter', `${ORIGIN}/ExampleCareers/Login?jobId=4711&next=/x`],
    ['another path of the portal', `${ORIGIN}/ExampleCareers/ResetPassword?jobId=4711`],
    ['another namespace', `${ORIGIN}/OtherCareers/Login?jobId=4711`],
    ['another origin', 'https://evil.example/ExampleCareers/Login?jobId=4711'],
    ['no id', `${ORIGIN}/ExampleCareers/Login`],
    ['a plain http route', 'http://careers.example.test/ExampleCareers/Login?jobId=4711'],
  ])('does not bind %s', (_name, href) => {
    expect(avatureApplyEntryBelongsToPosting(href, context as any)).toBe(false);
    expect(applicationEntryControls(snapshot(href) as any, context as any)).toHaveLength(0);
  });

  it('needs the portal to attest itself: no protocol, no proof', () => {
    expect(avatureApplyEntryBelongsToPosting(applyHref, { ...context, sourceProtocol: null } as any)).toBe(false);
    expect(avatureApplyEntryBelongsToPosting(applyHref, { ...context, sourceProtocol: { ...protocol, page: 'Register' } } as any)).toBe(false);
  });

  it('refuses a posting URL that is not the attested JobDetail route', () => {
    const otherUrl = `${ORIGIN}/ExampleCareers/JobDetail/Other-Role/5000`;
    expect(avatureApplyEntryBelongsToPosting(applyHref, { ...context, postingUrl: otherUrl, applyUrl: otherUrl } as any)).toBe(false);
  });
});
