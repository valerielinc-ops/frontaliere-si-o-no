import { describe, expect, it, vi } from 'vitest';
import { portalProtocolFromHtml, readPublicPortalProtocol } from '../scripts/assisted-application/lib/portal/protocol.mjs';
import { applicationReceipt, applicationStage, portalJobKey } from '../scripts/assisted-application/lib/portal/stages.mjs';
import { safeSigninAction, verificationHistoryTarget, verificationTarget } from '../scripts/assisted-application/lib/portal/verify.mjs';

const origin = 'https://careers.example';
const namespace = '/ExternalJobs';
const applyUrl = `${origin}${namespace}/JobDetail/Infrastructure-Strategy-Manager/71825`;
const profileUrl = `${origin}${namespace}/ApplicationConfirmation?jobId=71825`;
const reviewUrl = `${origin}${namespace}/ApplicationReview?jobId=71825`;
// Anonymized primary protocol shape: these values are not a vendor/tenant allowlist.
const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (page = 'JobDetail') => `<meta name="avature.portal.id" content="87">
<meta name="avature.portal.urlPath" content="ExternalJobs"><meta name="avature.portal.page" content="${page}">
<portal-data id="synapserBootstrap" data-applicationName="customPortal" data-applicationCode="customPortal_87"></portal-data>`;
const context = async () => ({ applyUrl, sourceProtocol: await portalProtocolFromHtml(html(), applyUrl), job: { title: 'Infrastructure Strategy Manager' } });
const profile = { url: profileUrl, fields: [], text: 'Thank you for your interest. Since you have already submitted your personal information, the application process will be simpler.',
  buttons: [{ text: 'Apply', href: reviewUrl }, { text: 'My profile' }] };
const review = { url: reviewUrl, fields: [], text: 'Infrastructure Strategy Manager. Please review the information below. Once you have reviewed, please select Submit to finalise your application.',
  buttons: [{ text: 'Apply' }, { text: 'Cancel' }, { text: 'Edit profile' }] };

describe('primary Avature protocol and posting namespace', () => {
  it('binds a slug/path posting to a query-based review through captured metadata', async () => {
    const ctx = await context();
    expect(ctx.sourceProtocol).toMatchObject({ vendor: 'avature', portalId: '87', namespace, page: 'JobDetail' });
    expect(portalJobKey(applyUrl)).toBeNull();
    expect(portalJobKey(applyUrl, ctx.sourceProtocol)).toBe('71825');
    expect(verificationTarget({ ...ctx, evidence: { finalUrl: reviewUrl } })).toBe(reviewUrl);
    expect(verificationTarget({ applyUrl, evidence: { finalUrl: reviewUrl } })).toBeNull();
    expect(safeSigninAction(`${origin}${namespace}/Login?jobId=71825`, applyUrl, ctx.sourceProtocol)).toBe(true);
    expect(verificationHistoryTarget(`${origin}${namespace}/MyApplications`, applyUrl, ctx.sourceProtocol)).toBe(`${origin}${namespace}/MyApplications`);
    expect(applicationStage({ ...profile, protocol: await portalProtocolFromHtml(html('ApplicationConfirmation'), profileUrl) }, ctx))
      .toMatchObject({ kind: 'review_navigation', destination: reviewUrl });
    expect(applicationStage({ ...review, protocol: await portalProtocolFromHtml(html('ApplicationReview'), reviewUrl) }, ctx).kind).toBe('final_review');
    expect(applicationReceipt(profile, ctx)).toBe(false);
    expect(applicationReceipt(review, ctx)).toBe(false);
  });

  it.each([
    ['no metadata', ''],
    ['wrong application code', html().replace('customPortal_87', 'customPortal_88')],
    ['duplicate identity', html() + '<meta name="avature.portal.id" content="87">'],
    ['different namespace', html().replace('ExternalJobs', 'OtherJobs')],
    ['wrong source page', html('Login')],
    ['other application', html().replace('data-applicationName="customPortal"', 'data-applicationName="other"')],
  ])('rejects %s instead of treating an arbitrary numeric path as a job', async (_case, markup) => {
    expect(await portalProtocolFromHtml(markup, applyUrl)).toBeNull();
    expect(portalJobKey(applyUrl, await portalProtocolFromHtml(markup, applyUrl))).toBeNull();
  });

  it('fails closed on current metadata, job or route namespace disagreement', async () => {
    const ctx = await context();
    expect(applicationStage(profile, ctx).kind).toBe('unknown_apply');
    const wrongPortal = await portalProtocolFromHtml(html('ApplicationConfirmation').replaceAll('87', '88'), profileUrl);
    expect(applicationStage({ ...profile, protocol: wrongPortal }, ctx).kind).toBe('unknown_apply');
    expect(portalJobKey(applyUrl + '?jobId=999', ctx.sourceProtocol)).toBeNull();
    expect(verificationTarget({ ...ctx, evidence: { finalUrl: reviewUrl.replace('71825', '999') } })).toBeNull();
    for (const route of ['ApplicationSave/MyApplications', 'Login/Save/MyApplications']) {
      expect(verificationHistoryTarget(`${origin}${namespace}/${route}`, applyUrl, ctx.sourceProtocol)).toBeNull();
    }
    expect(verificationTarget({ ...ctx, evidence: { finalUrl: `${origin}${namespace}/ApplicationSave/ApplicationReview?jobId=71825` } })).toBeNull();
    expect(safeSigninAction(`${origin}${namespace}/ApplicationSave/Login?jobId=71825`, applyUrl, ctx.sourceProtocol)).toBe(false);
  });

  it.each(['&JOBID=999', '&jobId=71825', '&postingId=bad', '&jobId=%20'])('never borrows title instructions for ambiguous job identity: %s', async suffix => {
    const ctx = await context(); const url = reviewUrl + suffix;
    const snapshot = { ...review, url, protocol: await portalProtocolFromHtml(html('ApplicationReview'), url) };
    expect(applicationStage(snapshot, ctx).kind).toBe('posting_mismatch');
    expect(applicationReceipt({ ...snapshot, text: 'Thank you for your application for Infrastructure Strategy Manager.', buttons: [] }, ctx)).toBe(false);
  });

  it('reads only the original public posting and never executes its scripts', async () => {
    const fetchImpl = vi.fn(async () => new Response(html() + '<script>throw new Error("must not run")</script>', { headers: { 'content-type': 'text/html' } }));
    expect(await readPublicPortalProtocol(applyUrl, { fetchImpl, lookupImpl })).toMatchObject({ portalId: '87', namespace });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(applyUrl, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    for (const value of [reviewUrl, applyUrl + '?action=submit', applyUrl + '#apply', applyUrl.replace('JobDetail', 'ApplicationSave')]) {
      fetchImpl.mockClear();
      expect(await readPublicPortalProtocol(value, { fetchImpl, lookupImpl })).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it.each(['127.0.0.1', '10.1.2.3', '[::1]', '[fd00::1]', 'localhost'])('does not request a private literal host: %s', async host => {
    const fetchImpl = vi.fn(); const resolve = vi.fn(lookupImpl);
    expect(await readPublicPortalProtocol(applyUrl.replace('careers.example', host), { fetchImpl, lookupImpl: resolve })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['private', 'mixed'])('does not request a hostname resolving to %s addresses', async kind => {
    const fetchImpl = vi.fn();
    const addresses = [{ address: '10.1.2.3', family: 4 }, ...(kind === 'mixed' ? [{ address: '93.184.216.34', family: 4 }] : [])];
    expect(await readPublicPortalProtocol(applyUrl, { fetchImpl, lookupImpl: async () => addresses })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shares a single validated DNS result with the socket dispatcher', async () => {
    const resolve = vi.fn(lookupImpl);
    const fetchImpl = vi.fn(async (_url, options) => {
      // Undici receives the validated-policy dispatcher rather than global fetch.
      expect(options.dispatcher).toBeDefined();
      return new Response(html(), { headers: { 'content-type': 'text/html' } });
    });
    expect(await readPublicPortalProtocol(applyUrl, { fetchImpl, lookupImpl: resolve })).not.toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it.each(['no proof', 'oversized header', 'oversized body', 'wrong content type', 'redirect'])('does not authorize an inspection from %s', async kind => {
    const headers = { 'content-type': kind === 'wrong content type' ? 'application/json' : 'text/html', ...(kind === 'oversized header' ? { 'content-length': '524289' } : {}) };
    const response = new Response(kind === 'no proof' ? '<html></html>' : kind === 'oversized body' ? 'x'.repeat(524289) : html(), { headers, status: kind === 'redirect' ? 302 : 200 });
    expect(await readPublicPortalProtocol(applyUrl, { fetchImpl: async () => response, lookupImpl })).toBeNull();
  });
});
