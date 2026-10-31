import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { primaryApplicationProtocolFromHtml, readPrimaryApplicationProtocol, PRIMARY_PROTOCOL_MAX_BYTES, PRIMARY_PROTOCOL_MAX_JSON_BYTES } from '../functions/src/lib/primaryApplicationProtocol.js';
import { publicContractGet as serverGet } from '../functions/src/lib/publicContractTransport.js';
import { publicContractGet, publicContractTimeZoneLookup } from '../scripts/assisted-application/lib/portal/public-contract-get.mjs';

const applyUrl = 'https://careers.example.test/ExternalJobs/JobDetail/IT-Manager/42';
const jobTitle = 'IT Manager';
const html = (title = jobTitle) => `<meta name="avature.portal.id" content="87"><meta name="avature.portal.urlPath" content="ExternalJobs"><meta name="avature.portal.page" content="JobDetail"><portal-data id="synapserBootstrap" data-applicationName="customPortal" data-applicationCode="customPortal_87"></portal-data><h1>${title}</h1>`;
const nativeUrl = 'https://jobs.example.test/IT-Manager.html';
const nativeHtml = (handler = "javascript: this.closest('form').submit(); return false;") => `<h1>${jobTitle}</h1><form action="${nativeUrl}" method="post"><input name="mail"><input name="vorname"><input name="nachname"><input type="file" name="cv"><a href="#" onclick="${handler}">Inviare</a></form>`;
function transport(specs: Array<any>) {
  const requests: any[] = [];
  const requestImpl = (url: URL, options: any, callback: any) => {
    const req: any = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const spec = specs.shift() || {};
      const response: any = Readable.from([Buffer.from(spec.body || '')]);
      response.statusCode = spec.status || 200;
      response.headers = spec.headers || { 'content-type': 'text/html; charset=utf-8' };
      callback(response);
    });
    req.destroy = (error: any) => req.emit('error', error);
    requests.push({ url, options });
    return req;
  };
  return { requests, requestImpl };
}
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];

describe('server primary posting protocol', () => {
  it('shares one pinned transport with the existing Node named wrappers', () => {
    expect(publicContractGet).toBe(serverGet);
  });
  it('requires independent primary tokens plus a unique complete H1 equal to the server title', () => {
    expect(primaryApplicationProtocolFromHtml(html(), { applyUrl, jobTitle })).toMatchObject({ vendor: 'avature', sourceTitle: jobTitle,
      quoted: { titleSource: 'unique-h1', sourceTitle: jobTitle, applicationCode: 'customPortal_87' } });
    expect(primaryApplicationProtocolFromHtml(html(), { applyUrl, jobTitle: 'Another job' })).toBeNull();
    expect(primaryApplicationProtocolFromHtml('<h1>IT Manager</h1>', { applyUrl, jobTitle })).toBeNull();
  });
  it.each([
    ['comment', `<!--${html()}-->`], ['script', `<script>const markup=${JSON.stringify(html())}</script>`],
    ['template', `<template>${html()}</template>`], ['noscript', `<noscript>${html()}</noscript>`],
    ['textarea', `<textarea>${html()}</textarea>`], ['foreign heading', html() + '<svg><h1>Another job</h1></svg>'],
    ['duplicate heading', html() + '<h1>IT Manager</h1>'],
    ['duplicate metadata', html() + '<meta name="avature.portal.id" content="87">'],
    ['wrong namespace', html().replace('ExternalJobs', 'AnotherPortal')],
    ['wrong application', html().replace('customPortal_87', 'customPortal_88')],
    ['title suffix', html('IT Manager — with a medical degree')],
  ])('does not promote %s into primary authority', (_label, markup) => {
    expect(primaryApplicationProtocolFromHtml(markup, { applyUrl, jobTitle })).toBeNull();
  });
  it('parses entities and real HTML tags without executing any supplied script', () => {
    const markup = html('IT &amp; Support <span>Manager</span>') + '<script>throw new Error("must not execute")</script>';
    expect(primaryApplicationProtocolFromHtml(markup, { applyUrl, jobTitle: 'IT & Support Manager' })?.sourceTitle).toBe('IT & Support Manager');
  });
  it('recognizes a distinct primary inline native-form submission without inventing a numeric job key', () => {
    expect(primaryApplicationProtocolFromHtml(nativeHtml(), { applyUrl: nativeUrl, jobTitle })).toMatchObject({ vendor: 'primary_inline_form_submit', sourceTitle: jobTitle });
    for (const markup of [nativeHtml("alert('extra'); this.closest('form').submit(); return false;"), nativeHtml().replace('method="post"', 'method="get"'),
      nativeHtml().replace(`action="${nativeUrl}"`, 'action="https://other.example.test/send"'), nativeHtml() + nativeHtml(),
      nativeHtml().replace('name="mail"', 'name="mail" form="foreign"')]) {
      expect(primaryApplicationProtocolFromHtml(markup, { applyUrl: nativeUrl, jobTitle })).toBeNull();
    }
  });
  it('does not combine an empty labelledby reference with a valid submit label', () => {
    const markup = '<span id="empty"></span><span id="commit">Inviare</span>'
      + nativeHtml().replace('href="#"', 'href="#" aria-labelledby="empty commit"');
    expect(primaryApplicationProtocolFromHtml(markup, { applyUrl: nativeUrl, jobTitle })).toBeNull();
  });
  it('bounds labelledby expansion and the complete protocol JSON without truncating proof', () => {
    const huge = '<span id="noise">' + 'n'.repeat(20_000) + '</span>' + nativeHtml()
      + '<form method="get">' + '<button type="button" aria-labelledby="noise">Other</button>'.repeat(100) + '</form>';
    expect(primaryApplicationProtocolFromHtml(huge, { applyUrl: nativeUrl, jobTitle })).toBeNull();
    const expanded = '<span id="noise">' + 'n'.repeat(280) + '</span>' + nativeHtml()
      + '<form method="get">' + '<button type="button" aria-labelledby="noise">Other</button>'.repeat(250) + '</form>';
    const protocol = primaryApplicationProtocolFromHtml(expanded, { applyUrl: nativeUrl, jobTitle });
    expect(protocol === null || Buffer.byteLength(JSON.stringify(protocol)) <= PRIMARY_PROTOCOL_MAX_JSON_BYTES).toBe(true);
  });
  it.each(['ApplicationSave', 'Save', 'Application%53ave', '%53ave', 'Application%2553ave', '%5cSave'])('does not request an initial mutating source route %s', async path => {
    const fixture = transport([]); let lookups = 0;
    expect(await readPrimaryApplicationProtocol({ applyUrl: `https://ats.example.test/ExternalJobs/${path}?jobId=42`, jobTitle },
      { resolve: async () => { lookups++; return resolve(); }, requestImpl: fixture.requestImpl })).toBeNull();
    expect(lookups).toBe(0); expect(fixture.requests).toHaveLength(0);
  });
  it('keeps an exact public form query in the posting identity and refuses action queries before DNS', async () => {
    const queryUrl = nativeUrl + '?jobId=42';
    const fixture = transport([{ body: nativeHtml().replaceAll(nativeUrl, queryUrl) }]);
    expect(await readPrimaryApplicationProtocol({ applyUrl: queryUrl, jobTitle }, { resolve, requestImpl: fixture.requestImpl }))
      .toMatchObject({ applyUrl: queryUrl, sourceProtocol: { vendor: 'primary_inline_form_submit' } });
    const blocked = transport([]); let lookups = 0;
    expect(await readPrimaryApplicationProtocol({ applyUrl: nativeUrl + '?action=save', jobTitle },
      { resolve: async () => { lookups++; return resolve(); }, requestImpl: blocked.requestImpl })).toBeNull();
    expect(lookups).toBe(0); expect(blocked.requests).toHaveLength(0);
  });
  it.each([300, 304, 305, 306])('does not treat HTTP %s plus Location as an owned redirect', async status => {
    const fixture = transport([{ status, headers: { location: applyUrl.replace('careers.example.test', 'ats.example.test') } }, { body: html() }]);
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve, requestImpl: fixture.requestImpl })).toBeNull();
    expect(fixture.requests).toHaveLength(1);
  });
  it('does not infer the expected server title from the public body', async () => {
    const fixture = transport([{ body: html() }]); let lookups = 0;
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle: '' },
      { resolve: async () => { lookups++; return resolve(); }, requestImpl: fixture.requestImpl })).toBeNull();
    expect(lookups).toBe(0); expect(fixture.requests).toHaveLength(0);
  });
  it('separates pure archived decoding from permission to request that source', async () => {
    const source = 'https://jobs.example.test/apply/role/42/';
    const markup = nativeHtml().replaceAll(nativeUrl, source);
    expect(primaryApplicationProtocolFromHtml(markup, { applyUrl: source, jobTitle }))
      .toMatchObject({ vendor: 'primary_inline_form_submit' });
    const fixture = transport([]); let lookups = 0;
    expect(await readPrimaryApplicationProtocol({ applyUrl: source, jobTitle },
      { resolve: async () => { lookups++; return resolve(); }, requestImpl: fixture.requestImpl })).toBeNull();
    expect(lookups).toBe(0); expect(fixture.requests).toHaveLength(0);
  });
  it('uses GET without cookies/body/auth and pins the validated DNS result', async () => {
    const fixture = transport([{ body: html() }]);
    const result = await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve, requestImpl: fixture.requestImpl });
    expect(result).toMatchObject({ applyUrl, sourceProtocol: { sourceTitle: jobTitle } });
    expect(fixture.requests).toHaveLength(1);
    const options = fixture.requests[0].options;
    expect(options).toMatchObject({ method: 'GET', agent: false, servername: 'careers.example.test' });
    expect(options.headers).not.toHaveProperty('Cookie'); expect(options.headers).not.toHaveProperty('Authorization');
    let pinned: any;
    options.lookup('careers.example.test', {}, (_error: any, address: any, family: any) => { pinned = { address, family }; });
    expect(pinned).toEqual({ address: '93.184.216.34', family: 4 });
  });
  it('uses only a server-read redirect edge for a cross-origin source mapping, never numeric ID equality', async () => {
    const finalUrl = applyUrl.replace('careers.example.test', 'ats.example.test').replace('/42', '/91');
    const fixture = transport([{ status: 302, headers: { location: finalUrl } }, { body: html() }]);
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve, requestImpl: fixture.requestImpl }))
      .toMatchObject({ applyUrl: finalUrl, sourceProtocol: { origin: 'https://ats.example.test', path: new URL(finalUrl).pathname } });
    expect(fixture.requests).toHaveLength(2);
  });
  it('denies private or mixed DNS before any socket and rechecks every redirect', async () => {
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
      const fixture = transport([]);
      expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve: async () => addresses, requestImpl: fixture.requestImpl })).toBeNull();
      expect(fixture.requests).toHaveLength(0);
    }
    const fixture = transport([{ status: 302, headers: { location: applyUrl.replace('careers.example.test', 'private.example.test') } }]);
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve: async (host: string) => [{ address: host.startsWith('private') ? '127.0.0.1' : '93.184.216.34', family: 4 }], requestImpl: fixture.requestImpl })).toBeNull();
    expect(fixture.requests).toHaveLength(1);
  });
  it('never follows a source redirect into an apply/commit route', async () => {
    const fixture = transport([{ status: 302, headers: { location: 'https://ats.example.test/ExternalJobs/ApplicationSave?jobId=42' } }]);
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve, requestImpl: fixture.requestImpl })).toBeNull();
    expect(fixture.requests).toHaveLength(1);
  });
  it('limits redirects, cumulative bytes and aborts including DNS', async () => {
    const loop = transport(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: applyUrl } })));
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve, requestImpl: loop.requestImpl })).toBeNull();
    expect(loop.requests).toHaveLength(4);
    const large = transport([{ body: 'x'.repeat(PRIMARY_PROTOCOL_MAX_BYTES + 1) }]);
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve, requestImpl: large.requestImpl })).toBeNull();
    const timeout = transport([]);
    expect(await readPrimaryApplicationProtocol({ applyUrl, jobTitle }, { resolve: () => new Promise(() => {}), requestImpl: timeout.requestImpl, signal: AbortSignal.timeout(10) })).toBeNull();
    expect(timeout.requests).toHaveLength(0);
  });
  it('preserves the exact named Rexx POST guard before the extracted engine', async () => {
    const fixture = transport([]);
    await expect(publicContractTimeZoneLookup('https://jobs.example.test/timezone.html', { timeZone: 'Europe/Zurich', protocol: null,
      resolve, requestImpl: fixture.requestImpl })).rejects.toMatchObject({ code: 'contract_lookup_invalid' });
    expect(fixture.requests).toHaveLength(0);
  });
});
