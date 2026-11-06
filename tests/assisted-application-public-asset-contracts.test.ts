import { describe, expect, it } from 'vitest';
import { readOnlyPortalContracts } from '../scripts/assisted-application/lib/portal/read-only-contracts.mjs';
import { publicAssetSources, literalScriptAssetUrls, matchesScriptAsset, hasSafePublicScriptQuery, isPublicJavaScriptResponse } from '../scripts/assisted-application/lib/portal/read-only-asset-contracts.mjs';

const url = 'https://jobs.example.com/careers/apply/';
const id = '11111111-2222-3333-4444-555555555555';
const loader = 'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js';
const flow = 'https://jobs.example.com/inc/flow/js/flow.js';
const html = `<html lang='it'><head><script src='${loader}' data-domain-script='${id}' data-document-language='true'></script></head><body><script>
if (typeof Flow === 'undefined') { jQuery.ajax({ async: false, url: '${flow}', dataType: 'script' }); }
</script></body></html>`;

describe('public bootstrap asset identities', () => {
  it('derives static XHR scripts from literal primary loader code, including numeric cache busting', () => {
    const assets = publicAssetSources(html, url);
    expect(assets.loaders).toEqual([flow]);
    expect(matchesScriptAsset(`${flow}?_=1793400000000`, assets.loaders)).toBe(true);
    for (const value of [`${flow}?action=save`, `${flow}?email=private`, `${flow}?_=private`, `${flow}?_=1&_=2`, `${flow}#private`, flow.replace('jobs.example.com', 'private.example.com')]) expect(matchesScriptAsset(value, assets.loaders)).toBe(false);
    expect(isPublicJavaScriptResponse({ headers: { 'content-type': 'application/javascript; charset=utf-8' } })).toBe(true);
    expect(isPublicJavaScriptResponse({ headers: { 'content-type': 'application/json' } })).toBe(false);
  });

  it.each([
    `$.ajax({url:'${flow}',dataType:'json'})`, `$.ajax({url:'${flow}',dataType:'script',type:'POST'})`,
    `$.ajax({url:'${flow}',dataType:'script',data:{email:'private'}})`, `$.ajax({url: candidate.url,dataType:'script'})`,
    `$.ajax({url:'${flow}?action=delete',dataType:'script'})`, `$.ajax({url:'https://other.example.com/code.js',dataType:'script'})`,
  ])('does not grant static loader authority to an API/body/dynamic source', source => {
    expect(literalScriptAssetUrls(source, url, new URL(url).origin)).toEqual([]);
  });

  it('binds only public OneTrust configs to the active document domain id and official loader', () => {
    const assets = publicAssetSources(html, url);
    expect(assets.oneTrust).toMatchObject({ loaderUrl: loader, configs: [
      `https://cdn.cookielaw.org/consent/${id}/${id}.json`, `https://cdn.cookielaw.org/consent/${id}/it.json`,
    ] });
    expect(publicAssetSources(`<!--${html}-->`, url).oneTrust).toBeNull();
    expect(publicAssetSources(`<template>${html}</template>`, url).oneTrust).toBeNull();
    expect(publicAssetSources(html.replace('cdn.cookielaw.org', 'other.example.com'), url).oneTrust).toBeNull();
    expect(publicAssetSources(html.replace(id, 'candidate-email'), url).oneTrust).toBeNull();
    expect(publicAssetSources(html.replace('</head>', `<script src='${loader}' data-domain-script='${id}'></script></head>`), url).oneTrust).toBeNull();
  });

  it('does not accept action queries or credentials for JavaScript asset reads', () => {
    expect(hasSafePublicScriptQuery(`${flow}?v=14`)).toBe(true);
    expect(hasSafePublicScriptQuery(`${flow}?action=submit`)).toBe(false);
    expect(hasSafePublicScriptQuery('https://user:password@jobs.example.com/flow.js')).toBe(false);
  });
});

describe('bootstrap GET authorization order', () => {
  it.each([404, 500])('does not fetch config after an official loader HTTP %s, even with a queued config request', async status => {
    let route: any;
    const calls: string[] = [];
    const frame = {};
    const config = `https://cdn.cookielaw.org/consent/${id}/${id}.json`;
    const page: any = { mainFrame: () => frame, url: () => url, waitForLoadState: async () => {}, goto: async () => {
      for (const [target, type] of [[loader, 'script'], [config, 'xhr']]) {
        await route({ request: () => ({ url: () => target, method: () => 'GET', resourceType: () => type, isNavigationRequest: () => false, frame: () => frame }), abort: async () => {}, fulfill: async () => {} });
      }
    } };
    const context: any = { route: async (_: string, fn: any) => { route = fn; }, routeWebSocket: async () => {}, exposeBinding: async () => {}, addInitScript: async () => {}, newPage: async () => page, close: async () => {} };
    const get = async (target: string) => { calls.push(target); return { status: target === url ? 200 : status, url: target,
      headers: { 'content-type': target === url ? 'text/html' : 'text/javascript' }, body: Buffer.from(target === url ? html : '/* failed loader */') }; };
    const result = await readOnlyPortalContracts({ applyUrl: url, get, launch: async () => ({ newContext: async () => context, close: async () => {} }) });
    expect(result.complete).toBe(false);
    expect(calls).toEqual([url, loader]);
    expect(calls).not.toContain(config);
  });
});
