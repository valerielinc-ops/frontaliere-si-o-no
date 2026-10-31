import { describe, expect, it, vi } from 'vitest';
import { cookielessTelemetryProtocol, officialConsentGeoLoader, derivedConsentPublicReads, officialConsentUiAssets, observationalBeaconQuerySender, matchesObservationalTelemetry, officialConsentSvgGetter, consentPublicLogo } from '../scripts/assisted-application/lib/portal/public-consent-bootstrap.mjs';
import { readOnlyPortalContracts } from '../scripts/assisted-application/lib/portal/read-only-contracts.mjs';
import { observationalBeaconSender } from './fixtures/observational-beacon-sender.mjs';
const page = 'https://jobs.example.com/apply/';
const code = `var _paq=window._paq||[];_paq.push(['disableCookies']);_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);(function(){var u='//metrics.example.com/';_paq.push(['setTrackerUrl',u+'matomo.php']);_paq.push(['setSiteId',7]);var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];g.type='text/javascript';g.async=true;g.defer=true;g.src=u+'matomo.js';s.parentNode.insertBefore(g,s);})();`;
const loader = 'K.prototype.getGeoLocation=function(e){var t=this.getGeolocationURL(e);this.otFetch(t,this.geoLocationJsonCallback.bind(this,e),!0)}';
const id = '12345678-1234-1234-1234-123456789012';
const rule = 'abcdefab-1234-1234-1234-123456789012';
const configUrl = `https://cdn.cookielaw.org/consent/${id}/${id}.json`;
const primary = { configs: [configUrl], language: 'it' };
const geo = 'https://geolocation.onetrust.com/cookieconsentpub/v1/geo/location';
describe('public consent bootstrap provenance', () => {
  it('classifies only the complete active cookieless asynchronous observation block', () => {
    expect(cookielessTelemetryProtocol(`<script>${code}</script>`, page)).toMatchObject({ trackerUrl: 'https://metrics.example.com/matomo.php' });
    for (const source of [code.replace("_paq.push(['disableCookies']);", ''), code.replace('g.async=true', 'g.async=false'), code.replace("g.defer=true;", "g.defer=true;g.onload=function(){document.querySelector('input').required=true;};"), code.replace("u+'matomo.php'", "u+'submit.php'")]) {
      expect(cookielessTelemetryProtocol(`<script>${source}</script>`, page)).toBeNull();
    }
    expect(cookielessTelemetryProtocol(`<template><script>${code}</script></template>`, page)).toBeNull();
    expect(cookielessTelemetryProtocol(`<script>${code}</script><script>${code}</script>`, page)).toBeNull();
  });
  it('requires the official loader contract and exact primary config for anonymous geo and language reads', () => {
    expect(officialConsentGeoLoader(loader)).toBe(true);
    expect(officialConsentGeoLoader(loader.replace('this.otFetch(t,', 'this.saveCandidate(t,'))).toBe(false);
    const config = { SkipGeolocation: false, GeolocationUrl: geo, RuleSet: [{ Id: rule, LanguageSwitcherPlaceholder: { it: 'it' } }] };
    expect(derivedConsentPublicReads(config, configUrl, primary, true)).toEqual({ configs: [`https://cdn.cookielaw.org/consent/${id}/${rule}/it.json`], geo, sdkUrl: null });
    expect(derivedConsentPublicReads(config, configUrl, primary, false).geo).toBeNull();
    expect(derivedConsentPublicReads(config, configUrl+'?private=1', primary, true)).toEqual({ configs: [], geo: null });
    expect(derivedConsentPublicReads({ ...config, GeolocationUrl: geo+'?save=1' }, configUrl, primary, true).geo).toBeNull();
    expect(derivedConsentPublicReads(config, configUrl, { ...primary, language: 'fr' }, true).configs).toEqual([]);
    expect(derivedConsentPublicReads({ ...config, RuleSet: [{ Id: '../action', LanguageSwitcherPlaceholder: { it: 'it' } }] }, configUrl, primary, true).configs).toEqual([]);
  });
});


it.each(['observed', 'beacon', 'proven_query', 'before_script', 'iframe', 'over_budget', 'non_target'])('keeps telemetry aborts separate only with the full router proof: %s', async kind => {
  let handler: any;
  const body = vi.fn(() => { throw new Error('must not read telemetry body'); });
  const headers = vi.fn(() => { throw new Error('must not read telemetry headers'); });
  const frame = {};
  const script = 'https://metrics.example.com/matomo.js';
  const tracker = 'https://metrics.example.com/matomo.php';
  const aborted: any[] = [];
  const request = (url: string, method: string, type: string, main = true) => ({
    url: () => url, method: () => method, resourceType: () => type, frame: () => main ? frame : {},
    isNavigationRequest: () => false, headers, postDataBuffer: body,
  });
  const browserPage: any = { mainFrame: () => frame, url: () => page, waitForLoadState: async () => {},
    goto: async () => {
      if (kind !== 'before_script') await handler({ request: () => request(script, 'GET', 'script'), fulfill: async () => {}, abort: async () => {} });
      for (let i = 0; i < (kind === 'over_budget' ? 17 : 1); i++) {
        const req = request(['non_target', 'proven_query'].includes(kind) ? tracker+'?record=synthetic' : tracker, 'POST', kind === 'beacon' ? 'other' : kind === 'proven_query' ? 'ping' : 'xhr', kind !== 'iframe');
        await handler({ request: () => req, abort: async () => { aborted.push(req); } });
      }
    } };
  const context: any = { route: async (_: any, fn: any) => { handler = fn; }, routeWebSocket: async () => {},
    exposeBinding: async () => {}, addInitScript: async () => {}, newPage: async () => browserPage, close: async () => {} };
  const proof = await readOnlyPortalContracts({ applyUrl: page, launch: async () => ({ newContext: async () => context, close: async () => {} }),
    get: async (url: string) => ({ url, status: 200, headers: { 'content-type': url === page ? 'text/html' : 'application/javascript' },
      body: Buffer.from(url === page ? `<script>${code}</script>` : kind === 'proven_query' ? observationalBeaconSender : '/* public metrics runtime */') }) });
  expect(aborted).toHaveLength(kind === 'over_budget' ? 17 : 1);
  expect(body).not.toHaveBeenCalled(); expect(headers).not.toHaveBeenCalled();
  if (['observed', 'beacon', 'proven_query'].includes(kind)) {
    expect(proof.deniedRequests).toHaveLength(0);
    expect(proof.publicAssetProof.ignoredTelemetryRequests).toBe(1);
  } else expect(proof.deniedRequests).toHaveLength(1);
});

it('derives finite UI JSON assets only from the exact official SDK and version contract', () => {
  const url = 'https://cdn.cookielaw.org/scripttemplates/202608.1.0/otBannerSdk.js';
  const sdk = `var name='otFlat',button='otCookieSettingsButton.json';var style=E.getBannerSDKAssestsUrl()+'/otCommonStyles'+(D.useRTL?'Rtl':'')+'.css';s.prototype.getBannerSDKAssestsUrl=function(){return this.getBannerVersionUrl()+"/assets"};s.prototype.getBannerVersionUrl=function(){var e=_.bannerScriptElement.getAttribute("src");return ""+(-1!==e.indexOf("/consent/")?e.split("consent/")[0]+"scripttemplates/":e.split("otSDKStub")[0])+P.moduleInitializer.Version}`;
  expect(officialConsentUiAssets(sdk, url, url)).toContain('https://cdn.cookielaw.org/scripttemplates/202608.1.0/assets/otFlat.json');
  expect(officialConsentUiAssets(sdk, url, url)).toContain('https://cdn.cookielaw.org/scripttemplates/202608.1.0/assets/otCommonStyles.css');
  expect(officialConsentUiAssets(sdk, url, url)).toContain('https://cdn.cookielaw.org/scripttemplates/202608.1.0/assets/otCookieSettingsButton.json');
  expect(officialConsentUiAssets(sdk, url+'?private=1', url)).toEqual([]);
  expect(officialConsentUiAssets(sdk.replace('"/assets"', '"/save"'), url, url)).toEqual([]);
  expect(officialConsentUiAssets(sdk.replace("'otFlat'", "'../write'"), url, url).some((file: string) => file.includes('../write'))).toBe(false);
  expect(officialConsentUiAssets(sdk.replace("'/otCommonStyles'", "'/../write'"), url, url).some((file: string) => file.endsWith('.css'))).toBe(false);
});

it('requires the positively matched observational sender before ignoring an encoded tracking query', () => {
  const protocol = { trackerUrl: 'https://metrics.example.com/matomo.php' };
  const value = protocol.trackerUrl+'?record=synthetic';
  expect(observationalBeaconQuerySender(observationalBeaconSender)).toBe(true);
  expect(observationalBeaconQuerySender(observationalBeaconSender.replace('g.sendBeacon(dR,dQ)', 'saveCandidate(dR,dQ)'))).toBe(false);
  expect(matchesObservationalTelemetry(protocol, value)).toBe(false);
  expect(matchesObservationalTelemetry(protocol, value, true)).toBe(true);
  for (const other of ['https://other.example.com/matomo.php?record=x', protocol.trackerUrl+'/save', protocol.trackerUrl+'#private', protocol.trackerUrl+'?x='+ 'x'.repeat(32000)]) expect(matchesObservationalTelemetry(protocol, other, true)).toBe(false);
});

it('permits only the named public SVG from the attested language config and SDK getter', () => {
  const source = 'Zt.prototype.getPersistentCookieSvg=function(e){e=e||D.cookiePersistentLogo;return e?Xt.otFetch(e,!0):Promise.resolve(null)}';
  const url = 'https://cdn.cookielaw.org/logos/static/ot_guard_logo.svg';
  expect(officialConsentSvgGetter(source)).toBe(true);
  expect(officialConsentSvgGetter(source.replace('Xt.otFetch(e,!0)', 'Xt.save(e)'))).toBe(false);
  expect(consentPublicLogo({ CommonData: { OTGuardLogo: url } }, true, 'https://cdn.cookielaw.org/consent/language.json', ['https://cdn.cookielaw.org/consent/language.json'])).toBe(url);
  expect(consentPublicLogo({ CommonData: { OTGuardLogo: url } }, false, 'https://cdn.cookielaw.org/consent/language.json', ['https://cdn.cookielaw.org/consent/language.json'])).toBeNull();
  expect(consentPublicLogo({ CommonData: { OTGuardLogo: url } }, true, configUrl, ['https://cdn.cookielaw.org/consent/language.json'])).toBeNull();
  for (const other of [url+'?private=1', url.replace('cdn.cookielaw.org', 'other.example.com'), url.replace('ot_guard_logo', 'other')]) expect(consentPublicLogo({ CommonData: { OTGuardLogo: other } }, true, 'https://cdn.cookielaw.org/consent/language.json', ['https://cdn.cookielaw.org/consent/language.json'])).toBeNull();
});
