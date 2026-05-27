#!/usr/bin/env node
/**
 * One-shot diagnostic probe for the BAZG (Swiss Customs) public waiting-times
 * endpoint.
 *
 * As of 2026-04-21 the public BAZG portal was redesigned as a Nuxt-based SPA
 * and no stable public JSON endpoint could be discovered from the HTML (the
 * old `/dam/.../wartezeiten.json` route returns 502). This script pings the
 * most-likely URLs and reports the HTTP status / content type, so re-running
 * it periodically tells us when BAZG publishes a proper API.
 *
 * Usage:
 *   node scripts/probe-bazg-waiting-times.mjs
 *
 * Exit code: 0 if ≥1 endpoint returns `application/json` with HTTP 2xx,
 * otherwise 1 (so CI pipelines can auto-re-enable the BAZG cascade).
 */

const CANDIDATES = [
  'https://www.bazg.admin.ch/api/waiting-times',
  'https://www.bazg.admin.ch/api/wartezeiten',
  'https://www.bazg.admin.ch/udsc/api/waiting-times',
  'https://www.bazg.admin.ch/udsc/api/wartezeiten',
  'https://www.bazg.admin.ch/dam/bazg/de/dokumente/abgaben/zollanmeldung/wartezeiten.json',
  'https://www.bazg.admin.ch/dam/bazg/it/dokumente/abgaben/zollanmeldung/wartezeiten.json',
  'https://www.udsc.admin.ch/api/waiting-times',
  'https://api.udsc.admin.ch/waiting-times',
];

const UA = 'FrontaliereTicino-Probe/1.0 (contact: info@frontaliereticino.ch)';

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const ct = res.headers.get('content-type') || '';
    let sample = '';
    if (ct.includes('json') && res.ok) {
      try {
        const txt = await res.text();
        sample = txt.slice(0, 200).replace(/\s+/g, ' ');
      } catch {
        sample = '(stream read failed)';
      }
    }
    return { url, status: res.status, contentType: ct, ok: res.ok && ct.includes('json'), sample };
  } catch (err) {
    return { url, status: null, contentType: null, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`Probing ${CANDIDATES.length} BAZG candidate endpoints…\n`);
  const results = [];
  for (const url of CANDIDATES) {
    const r = await probe(url);
    results.push(r);
    const symbol = r.ok ? '✅' : '❌';
    const meta = r.error ? r.error : `${r.status} ${r.contentType || '(no content-type)'}`;
    console.log(`${symbol} [${r.status ?? '--'}] ${r.url} — ${meta}`);
    if (r.sample) console.log(`    sample: ${r.sample}`);
  }
  const ok = results.filter((r) => r.ok);
  console.log(`\nSummary: ${ok.length}/${results.length} endpoints returned JSON.`);
  process.exit(ok.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ probe failed:', err);
  process.exit(1);
});
