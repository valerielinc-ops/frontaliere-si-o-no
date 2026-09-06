#!/usr/bin/env node
/**
 * Measure the "variable NPA" criterion on a wide sample of promoted specs.
 *
 * #7464 left the prospector unable to read a vacancy's municipality from the
 * free text of a detail page, and said why: the vacancy's own NPA sits next to
 * the employer's boilerplate NPA, and nothing in the repo said which is which.
 * The proposed discriminator is variance across the pages of the same employer.
 * This script produces the number that decides whether it holds — it publishes
 * nothing and changes no gate.
 *
 * Pages are reached through the same polite, public-network-only transport and
 * the same listing cascade the promoted crawler uses (`collectSpecListingRows`,
 * `fetchRuntimePage`), because a measurement taken on a different program is a
 * statement about a different program.
 *
 * Ground truth is the location the listing itself already carries, graded by
 * the production resolver. Pages without it are reported as unscored rather
 * than folded into the rate.
 *
 * Usage:
 *   node scripts/prospect-measure-postal-variance.mjs
 *   node scripts/prospect-measure-postal-variance.mjs --pages=8 --min-hosts=10
 *   node scripts/prospect-measure-postal-variance.mjs --hosts=physioswiss,recruitingapp-2649
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROSPECTOR_DIR } from './lib/prospector/config.mjs';
import {
  collectSpecListingRows,
  createSpecUrlPolicy,
  fetchRuntimePage,
} from './lib/prospector/spec-crawler.mjs';
import { resolveDetailOrListingSwissGeography } from './lib/prospector/location-evidence.mjs';
import {
  aggregatePostalVariance,
  freeTextPostalMentions,
  summarizeHostPostalVariance,
} from './lib/prospector/postal-variance.mjs';

const CRAWLERS_DIR = path.join(PROSPECTOR_DIR, 'crawlers');
const REPORT_JSON = path.join(PROSPECTOR_DIR, 'postal-variance.json');
const REPORT_MD = path.join(PROSPECTOR_DIR, 'postal-variance.md');

// The three hosts #7464 names as the reason the rule could not be written:
// physioswiss carries the association's NPA on every page, and the two Umantis
// tenants are where the bare gazetteer match invents places. A sample that
// omits the cases that motivated the question cannot answer it.
const REQUIRED_KEYS = ['physioswiss', 'recruitingapp-2862', 'recruitingapp-2649'];

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @returns {string[]} spec keys to try, most promising first */
function sampleKeys() {
  const explicit = String(arg('hosts', '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  const specs = fs.readdirSync(CRAWLERS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const key = f.replace(/\.json$/, '');
      let spec = {};
      try { spec = JSON.parse(fs.readFileSync(path.join(CRAWLERS_DIR, f), 'utf8')); } catch { /* skip */ }
      return { key, spec };
    })
    .filter(({ spec }) => Array.isArray(spec.seedUrls) && spec.seedUrls.length);
  const rest = specs
    .filter(({ key }) => !REQUIRED_KEYS.includes(key))
    .sort((a, b) => (b.spec.sampleVacancyCount || 0) - (a.spec.sampleVacancyCount || 0)
      || a.key.localeCompare(b.key));
  // Alternate Umantis and generic hosts: the two families fail differently, and
  // a sample drawn from one of them would measure that family, not the rule.
  const umantis = rest.filter(({ spec }) => spec.platform === 'umantis.com').map(({ key }) => key);
  const generic = rest.filter(({ spec }) => spec.platform !== 'umantis.com').map(({ key }) => key);
  const interleaved = [];
  for (let i = 0; i < Math.max(umantis.length, generic.length); i += 1) {
    if (generic[i]) interleaved.push(generic[i]);
    if (umantis[i]) interleaved.push(umantis[i]);
  }
  return [...REQUIRED_KEYS, ...interleaved];
}

/**
 * The place the listing itself names, used as ground truth.
 *
 * Deliberately the raw listing string, not the resolver's verdict: the resolver
 * drops rows it cannot certify as Swiss, and grading only the rows it kept
 * would measure the criterion on the population where the problem is already
 * solved. `accepted` records the resolver's opinion alongside, so the report
 * can be re-read on the narrower population without re-crawling.
 *
 * @param {Record<string, any>} row
 * @returns {{ truth: string, accepted: boolean }}
 */
function listingTruth(row) {
  const truth = String(row.addressLocality || row.location || '').replace(/\s+/g, ' ').trim();
  return { truth, accepted: Boolean(resolveDetailOrListingSwissGeography({}, row).geography) };
}

/**
 * @param {string} key
 * @param {number} pagesPerHost
 */
async function measureHost(key, pagesPerHost) {
  const spec = JSON.parse(fs.readFileSync(path.join(CRAWLERS_DIR, `${key}.json`), 'utf8'));
  const runtime = { timeoutMs: 20000 };
  const urlPolicy = createSpecUrlPolicy(spec);
  try {
    const rows = await collectSpecListingRows(spec, runtime, urlPolicy);
    const sample = rows.slice(0, pagesPerHost);
    const pages = [];
    for (const row of sample) {
      let page;
      try {
        page = await fetchRuntimePage(row.url, urlPolicy, runtime);
      } catch (error) {
        pages.push({ url: row.url, error: String(error?.message || error) });
        continue;
      }
      pages.push({
        url: page.url || row.url,
        ...listingTruth(row),
        mentions: freeTextPostalMentions(page.body || ''),
      });
    }
    const fetched = pages.filter((p) => Array.isArray(p.mentions));
    const summary = summarizeHostPostalVariance(pages);
    return {
      companyKey: key,
      companyHost: spec.companyHost || '',
      platform: spec.platform || '',
      listingRows: rows.length,
      fetched: fetched.length,
      errors: pages.filter((p) => p.error).map((p) => ({ url: p.url, error: p.error })),
      ...summary,
      // Keep the raw pairs next to the verdict: a rate nobody can trace back to
      // the pages it came from is not evidence the child issue can act on.
      perPage: summary.perPage.map((page, index) => ({
        ...page,
        truthAcceptedByResolver: Boolean(fetched[index]?.accepted),
        allMentions: (fetched[index]?.mentions || [])
          .map((m) => ({ key: m.key, known: m.known, cantons: m.cantons })),
      })),
    };
  } finally {
    await urlPolicy.dispatcher.close().catch(() => {});
  }
}

function pct(value) {
  return value === null || value === undefined ? 'n/d' : `${(value * 100).toFixed(1)}%`;
}

/** @param {any} report */
function renderMarkdown(report) {
  const lines = [
    '# NPA variabile vs boilerplate — misura su campione ampio',
    '',
    `Generato: ${report.generatedAt} · comando: \`node scripts/prospect-measure-postal-variance.mjs\``,
    '',
    'Criterio misurato: **l\'NPA che non compare su tutte le pagine di dettaglio dello',
    'stesso datore è quello dell\'annuncio**. Verità di riferimento: la località che il',
    'listing porta già, graduata dal resolver di produzione. Baseline di confronto:',
    'primo NPA della pagina, varianza ignorata. Questa misura non modifica nessun gate.',
    '',
    '## Aggregato',
    '',
    `- host misurati: ${report.totals.hosts} (pagine ${report.totals.pages}, con verità nota ${report.totals.withTruth})`,
    `- criterio «NPA variabile»: precision ${pct(report.totals.criterion.precision)} · recall ${pct(report.totals.criterion.recall)}`
      + ` (hit ${report.totals.criterion.hits}, miss ${report.totals.criterion.misses}, nessuna previsione ${report.totals.criterion.noPrediction})`,
    `- baseline «primo NPA»: precision ${pct(report.totals.baseline.precision)} · recall ${pct(report.totals.baseline.recall)}`
      + ` (hit ${report.totals.baseline.hits}, miss ${report.totals.baseline.misses}, nessuna previsione ${report.totals.baseline.noPrediction})`,
    '',
    '## Per host',
    '',
    '| host | pagine | NPA costanti (boilerplate) | NPA variabili | verità note | precision | recall | baseline precision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const host of report.hosts) {
    lines.push([
      '',
      `\`${host.companyKey}\``,
      host.pages,
      host.constant.length ? host.constant.map((k) => `\`${k}\``).join('<br>') : '—',
      host.variable.length ? host.variable.map((k) => `\`${k}\``).join('<br>') : '—',
      host.withTruth,
      pct(host.criterion.precision),
      pct(host.criterion.recall),
      pct(host.baseline.precision),
      '',
    ].join(' | ').trim());
  }
  const skipped = report.skipped || [];
  if (skipped.length) {
    lines.push('', '## Host non misurati', '');
    for (const entry of skipped) lines.push(`- \`${entry.companyKey}\` — ${entry.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const pagesPerHost = positiveInt(arg('pages'), 6);
  const minHosts = positiveInt(arg('min-hosts'), 8);
  // Hosts alone do not make the measure: a spec whose vacancies are all abroad
  // (recruitingapp-2649 is the Alexander von Humboldt-Stiftung, in Bonn)
  // contributes pages and no gradable page at all. Keep drawing until enough
  // pages carry a location to score against.
  const minTruthPages = positiveInt(arg('min-truth-pages'), 25);
  const maxAttempts = positiveInt(arg('max-attempts'), minHosts * 4);
  const keys = sampleKeys();

  const hosts = [];
  const skipped = [];
  let attempts = 0;
  const enough = () => hosts.length >= minHosts
    && hosts.reduce((sum, host) => sum + host.withTruth, 0) >= minTruthPages;
  for (const key of keys) {
    if (enough() && !REQUIRED_KEYS.includes(key)) break;
    if (attempts >= maxAttempts) break;
    attempts += 1;
    process.stderr.write(`[postal-variance] ${key}…\n`);
    let host;
    try {
      host = await measureHost(key, pagesPerHost);
    } catch (error) {
      skipped.push({ companyKey: key, reason: String(error?.message || error) });
      continue;
    }
    if (!host.measurable) {
      skipped.push({ companyKey: key, reason: `solo ${host.fetched} pagine di dettaglio raggiunte, varianza non osservabile` });
      continue;
    }
    hosts.push(host);
  }

  const byHost = Object.fromEntries(hosts.map((h) => [h.companyKey, h]));
  const report = {
    generatedAt: new Date().toISOString(),
    criterion: 'NPA non presente su tutte le pagine di dettaglio dello stesso host',
    truthSource: 'localita del listing graduata da resolveDetailOrListingSwissGeography',
    pagesPerHost,
    totals: aggregatePostalVariance(byHost),
    hosts,
    skipped,
  };
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(REPORT_MD, renderMarkdown(report));
  console.log(`[postal-variance] host ${report.totals.hosts} · pagine ${report.totals.pages} · verità note ${report.totals.withTruth}`);
  console.log(`[postal-variance] criterio precision ${pct(report.totals.criterion.precision)} recall ${pct(report.totals.criterion.recall)}`);
  console.log(`[postal-variance] baseline precision ${pct(report.totals.baseline.precision)} recall ${pct(report.totals.baseline.recall)}`);
  console.log(`[postal-variance] report: ${path.relative(process.cwd(), REPORT_JSON)}, ${path.relative(process.cwd(), REPORT_MD)}`);
  // The measurement reports; it does not judge. A host that cannot be reached
  // is data about the corpus, not a failure of the script.
  if (report.totals.hosts < minHosts || report.totals.withTruth < minTruthPages) {
    process.stderr.write(`[postal-variance] attenzione: ${report.totals.hosts}/${minHosts} host,`
      + ` ${report.totals.withTruth}/${minTruthPages} pagine con verità nota\n`);
  }
}

main().catch((error) => {
  console.error(`[postal-variance] ${error?.stack || error}`);
  process.exitCode = 1;
});
