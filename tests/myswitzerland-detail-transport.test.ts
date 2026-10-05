/**
 * Detail transport of the MySwitzerland crawler (owner decision D1,
 * 2026-10-05): browser User-Agent on detail pages only, and a hard stop of the
 * detail phase on any escalation signal. Fixtures only, no live network.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHALLENGE_MAX_BYTES,
  MYSWITZERLAND_DETAIL_BROWSER_UA,
  MYSWITZERLAND_DETAIL_TRANSPORT_MODE,
  REFUSAL_STOP_MIN_SAMPLE,
  assertDetailUrlAllowed,
  classifyDetailResponse,
  createDetailTransportStats,
  fetchMySwitzerlandDetailPage,
  recordDetailResponse,
  reportDetailTransport,
} from '../scripts/lib/myswitzerland-detail-transport.mjs';
import { DETAIL_FAILURE_RATIO_THRESHOLD } from '../scripts/lib/detail-failure-reuse-policy.mjs';
import { fetchDetailEnrichment } from '../scripts/crawl-myswitzerland-events.mjs';

const DETAIL_URL = 'https://www.myswitzerland.com/de-ch/erlebnisse/veranstaltungen/sample-event/';

const detailHtml = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: 'Sample event',
  startDate: '2099-01-01T20:00:00+01:00',
  location: { '@type': 'Place', name: 'Hall', address: { streetAddress: 'Via Roma 1', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' } },
})}</script></head><body>${'<p>content</p>'.repeat(10)}</body></html>`;
// The 3 KB `private, no-store` interstitial shape measured on 2026-10-05.
const challengeHtml = `<!DOCTYPE html><html><head><title>Client Challenge</title><script src="/_fs-ch-1T1wmsGaOgGaSxcX/script.js"></script></head><body>${'x'.repeat(2900)}</body></html>`;

const perLocaleHits = Object.fromEntries(
  ['it', 'en', 'de', 'fr'].map((locale) => [locale, { url: '/experiences/event/sample-event/', title: 'Sample event' }]),
);

describe('browser User-Agent: only on the detail request', () => {
  it('sends the fixed desktop UA and an HTML Accept, with no cookie header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(detailHtml, { status: 200 }));

    const result = await fetchMySwitzerlandDetailPage(DETAIL_URL, { fetchImpl });

    expect(result).toEqual({ status: 200, html: detailHtml });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['User-Agent']).toBe(MYSWITZERLAND_DETAIL_BROWSER_UA);
    expect(MYSWITZERLAND_DETAIL_BROWSER_UA).toMatch(/Chrome\/\d+/);
    expect(MYSWITZERLAND_DETAIL_BROWSER_UA).not.toMatch(/bot|headless/i);
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('cookie');
  });

  it('refuses other hosts and the robots.txt-disallowed paths', () => {
    expect(() => assertDetailUrlAllowed('https://myswitzerland.com/de-ch/x/')).toThrow(/host/);
    expect(() => assertDetailUrlAllowed('https://www.myswitzerland.com/api/events')).toThrow(/robots/);
    expect(() => assertDetailUrlAllowed('https://www.myswitzerland.com/de-ch/api/events')).toThrow(/robots/);
    expect(() => assertDetailUrlAllowed('https://www.myswitzerland.com/sitecore/content')).toThrow(/robots/);
    expect(() => assertDetailUrlAllowed('https://www.myswitzerland.com/sitecore_services/x')).toThrow(/robots/);
    expect(() => assertDetailUrlAllowed(DETAIL_URL)).not.toThrow();
  });
});

describe('classifyDetailResponse', () => {
  it('separates content, refusal, escalation and other outcomes', () => {
    expect(classifyDetailResponse({ status: 200, html: detailHtml })).toBe('ok');
    expect(classifyDetailResponse({ status: 406, html: null })).toBe('refused');
    expect(classifyDetailResponse({ status: 403, html: null })).toBe('escalation');
    expect(classifyDetailResponse({ status: 429, html: null })).toBe('escalation');
    expect(classifyDetailResponse({ status: 200, html: challengeHtml })).toBe('escalation');
    expect(classifyDetailResponse({ status: 404, html: null })).toBe('other');
    expect(classifyDetailResponse({ status: 0, html: null })).toBe('other');
  });

  it('keeps a full page without JSON-LD as content, whatever words it contains', () => {
    const big = `<html><body>newsletter captcha ${'y'.repeat(CHALLENGE_MAX_BYTES)}</body></html>`;
    expect(classifyDetailResponse({ status: 200, html: big })).toBe('ok');
  });
});

describe('stop of the detail phase (escalation)', () => {
  it.each([
    ['HTTP 403', { status: 403, html: null }],
    ['HTTP 429', { status: 429, html: null }],
    ['challenge page', { status: 200, html: challengeHtml }],
  ])('%s stops the phase at once: no further request, no retry', async (reason, response) => {
    const stats = createDetailTransportStats();
    const fetchPage = vi.fn().mockResolvedValue(response);
    const pause = vi.fn().mockResolvedValue(undefined);

    const first = await fetchDetailEnrichment(perLocaleHits, { fetchPage, pause, stats });
    const second = await fetchDetailEnrichment(perLocaleHits, { fetchPage, pause, stats });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(stats.stopped?.reason).toBe(reason);
    expect(stats.escalation).toBe(1);
  });

  it('a challenge page is never parsed as event content', async () => {
    const stats = createDetailTransportStats();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ status: 200, html: challengeHtml })
      .mockResolvedValue({ status: 200, html: detailHtml });

    const enrichment = await fetchDetailEnrichment(perLocaleHits, { fetchPage, pause: vi.fn(), stats });

    expect(enrichment).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('406 above the policy threshold stops the phase; a lone 406 does not', () => {
    const stats = createDetailTransportStats();
    const minRefusalsToStop = Math.floor(DETAIL_FAILURE_RATIO_THRESHOLD * REFUSAL_STOP_MIN_SAMPLE) + 1;
    for (let i = 0; i < minRefusalsToStop - 1; i += 1) {
      recordDetailResponse(stats, { status: 406, html: null }, DETAIL_URL);
      expect(stats.stopped).toBeNull();
    }
    recordDetailResponse(stats, { status: 406, html: null }, DETAIL_URL);
    expect(stats.stopped).toBeNull();
    for (let i = minRefusalsToStop; i < REFUSAL_STOP_MIN_SAMPLE - 1; i += 1) {
      recordDetailResponse(stats, { status: 200, html: detailHtml }, DETAIL_URL);
      expect(stats.stopped).toBeNull();
    }
    recordDetailResponse(stats, { status: 406, html: null }, DETAIL_URL);
    expect(stats.stopped?.reason).toMatch(/HTTP 406 above the 15% policy threshold/);
  });

  it('a 406 rate within the threshold over a large sample keeps going', () => {
    const stats = createDetailTransportStats();
    for (let i = 0; i < REFUSAL_STOP_MIN_SAMPLE * 5; i += 1) {
      recordDetailResponse(stats, i % 10 === 0 ? { status: 406, html: null } : { status: 200, html: detailHtml }, DETAIL_URL);
    }
    expect(stats.refused).toBeGreaterThan(0);
    expect(stats.stopped).toBeNull();
  });
});

describe('step summary observer', () => {
  it('reports attempts, 200/406/other, the mode, and an ::error:: when stopped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysw-summary-'));
    const summaryPath = path.join(dir, 'summary.md');
    const stats = createDetailTransportStats();
    recordDetailResponse(stats, { status: 200, html: detailHtml }, DETAIL_URL);
    recordDetailResponse(stats, { status: 406, html: null }, DETAIL_URL);
    recordDetailResponse(stats, { status: 404, html: null }, DETAIL_URL);
    recordDetailResponse(stats, { status: 429, html: null }, DETAIL_URL);
    const log = vi.fn();

    reportDetailTransport(stats, { env: { GITHUB_STEP_SUMMARY: summaryPath }, log });

    const summary = fs.readFileSync(summaryPath, 'utf8');
    expect(summary).toContain(`Modo: ${MYSWITZERLAND_DETAIL_TRANSPORT_MODE}`);
    expect(summary).toContain('Dettagli tentati: 4');
    expect(summary).toContain('200: 1 · 406: 1 · 403/429/challenge: 1 · altro: 1');
    expect(summary).toContain('::error::MySwitzerland detail phase stopped: HTTP 429');
    expect(log.mock.calls.some(([line]) => String(line).startsWith('::error::'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes no ::error:: on a clean run', () => {
    const stats = createDetailTransportStats();
    recordDetailResponse(stats, { status: 200, html: detailHtml }, DETAIL_URL);
    const log = vi.fn();

    const summary = reportDetailTransport(stats, { env: {}, log });

    expect(summary).not.toContain('FERMATA');
    expect(log.mock.calls.some(([line]) => String(line).startsWith('::error::'))).toBe(false);
  });
});
