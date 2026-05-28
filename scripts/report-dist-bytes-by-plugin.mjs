#!/usr/bin/env node
// report-dist-bytes-by-plugin.mjs
//
// Walks dist/ and attributes bytes per emitting plugin/category and per
// locale. Output is one JSONL line appended to data/dist-size-history.jsonl
// + a stdout summary table.
//
// Usage:
//   node scripts/report-dist-bytes-by-plugin.mjs [--dist=dist] [--no-append]
//                                                [--gate-total-bytes=10200000000]
//                                                [--run-id=<id>] [--sha=<sha>]
//                                                [--tar-size-bytes=<n>]
//
// Exit codes:
//   0  ok
//   1  --gate-total-bytes set AND total exceeded → block deploy
//   2  dist dir missing / unreadable
//
// Design constraints (from CI-cost history, PR #480 dist-shrink rollback):
//   - Pure fs.stat walk, no file content reads.
//   - Sequential readdir w/ withFileTypes — already I/O-bound on EXT4, worker
//     parallelism added <2 % wall-clock in spike test and 12 MB peak RSS.
//   - Target: < 30 s on ~470 k files.
//
// Classification is prefix-based. Unknown prefixes are bucketed under
// "other-<top-segment>" so a new plugin path is visible the first build.

import { readdir, stat } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const out = {
    dist: 'dist',
    append: true,
    gateTotalBytes: null,
    runId: process.env.GITHUB_RUN_ID || null,
    sha: process.env.GITHUB_SHA || null,
    tarSizeBytes: null,
  };
  for (const arg of argv) {
    if (arg === '--no-append') out.append = false;
    else if (arg.startsWith('--dist=')) out.dist = arg.slice(7);
    else if (arg.startsWith('--gate-total-bytes=')) out.gateTotalBytes = Number(arg.slice(19));
    else if (arg.startsWith('--run-id=')) out.runId = arg.slice(9);
    else if (arg.startsWith('--sha=')) out.sha = arg.slice(6);
    else if (arg.startsWith('--tar-size-bytes=')) out.tarSizeBytes = Number(arg.slice(17));
  }
  return out;
}

// Classifier: ordered. First match wins. Locale is detected separately.
// Locale-prefixed paths (en/, de/, fr/) are stripped before matching, so
// `en/find-jobs-ticino/...` and `cerca-lavoro-ticino/...` map to the same
// plugin bucket. Root (no locale prefix) is IT.
const LOCALES = new Set(['en', 'de', 'fr']);

const PLUGIN_RULES = [
  // jobs SEO (active + soft-landing + previousSlugs bridges).
  // jobsSeoPagesPlugin emits under canton-aware sections for every canton
  // (TI, ZH, BE, GR, BS, VD, VS, LU, AG, GE, SO, SG, FR, TG, NE, …) plus a
  // pan-Switzerland section. The IT/EN/DE/FR section names diverge per
  // locale (e.g. cerca-lavoro-zurigo / find-jobs-zurich / jobs-in-zurich /
  // trouver-emploi-zurich), so we use a regex to catch the whole family
  // without enumerating every canton × every locale × every prefix.
  { plugin: 'jobs-seo', regex:
    /^(cerca-lavoro|find-jobs|jobs-im|jobs-in|trouver-emploi)-[a-z][a-z-]*(\/|\.html$)/ },
  // related search cluster pages
  { plugin: 'cluster', prefixes: [
    'ricerca-cluster/', 'search-cluster/', 'such-cluster/', 'recherche-cluster/',
    'ricerca/', 'cluster-ricerca/',
  ]},
  // OG / article pages — paths vary across locales (articoli-frontaliere
  // / articles-frontalier / grenzgaenger-artikel / cross-border-articles
  // …). Regex catches the family without enumerating singular/plural and
  // EN/DE/FR/IT variants.
  { plugin: 'og-pages', regex:
    /^(articoli-frontaliere|articles?-frontaliers?|articles?-frontalier|grenzgaenger-artikel|cross-border-articles?)\// },
  // hub plugins
  { plugin: 'hub-salary', prefixes: ['stipendi/', 'salaries/', 'gehaelter/', 'salaires/'] },
  { plugin: 'hub-faq', prefixes: ['faq/', 'domande/', 'fragen/', 'questions/'] },
  { plugin: 'hub-comparison', prefixes: ['confronti/', 'comparisons/', 'vergleiche/', 'comparaisons/'] },
  { plugin: 'hub-section', prefixes: ['sezioni/', 'sections/', 'abschnitte/'] },
  // Daily-feature SEO plugins (fuelDailyPlugin, healthPremiumsPlugin,
  // borderWaitPagesPlugin, weatherCommutePlugin, salaryCalculatorPlugin).
  // Each emits under 4 locale-aware section names — regex catches all.
  { plugin: 'fuel-daily', regex:
    /^(prix-essence-suisse|prezzi-benzina|benzinpreis-schweiz|gasoline-price-switzerland|prezzi-diesel|prix-gasoil-suisse|dieselpreis-schweiz|diesel-price-switzerland)\// },
  { plugin: 'health-premiums', regex:
    /^(primes-assurance-maladie|premi-cassa-malati|krankenkassenpraemien|health-insurance-premiums)\// },
  { plugin: 'border-wait', regex:
    /^(temps-attente-douane|wartezeit-grenze|traffico-dogane|border-wait)\// },
  { plugin: 'weather-commute', regex:
    /^(meteo-frontalieri|meteo-frontaliers|pendler-wetter|commute-weather)\// },
  { plugin: 'salary-calculator', regex:
    /^(calcola-stipendio|calculate-salary|calculer-salaire|gehalt-berechnen)\// },
  // Editorial / evergreen sections (companies-hiring, living-in-ticino,
  // ticino-job-market, glossary, guides, taxes-and-pension, statistics,
  // service-comparison, faq, alerts/reports).
  { plugin: 'companies-hiring', regex:
    /^(aziende-che-assumono|companies-hiring|entreprises-recrutent|unternehmen-einstellen|entreprises-qui-recrutent|firmen-die-einstellen)\// },
  { plugin: 'living-in-ticino', regex:
    /^(vivere-in-ticino|living-in-ticino|leben-im-tessin|vivre-au-tessin|vita-in-ticino)\// },
  { plugin: 'job-market', regex:
    /^(mercato-lavoro-ticino|ticino-job-market|tessiner-arbeitsmarkt|marche-travail-tessin)\// },
  { plugin: 'glossary', regex:
    /^(glossario-frontaliere|cross-border-glossary|grenzgaenger-glossar|glossaire-frontalier)\// },
  { plugin: 'guides', regex:
    /^(guida-frontaliere|cross-border-guide|grenzgaenger-ratgeber|guide-frontalier)\// },
  { plugin: 'taxes-pension', regex:
    /^(tasse-e-pensione|taxes-and-pension|steuern-und-vorsorge|impots-et-retraite)\// },
  { plugin: 'statistics', regex:
    /^(statistiche|statistics|statistiken|statistiques)\// },
  { plugin: 'service-compare', regex:
    /^(compara-servizi|service-comparison|service-vergleich|comparaison-services)\// },
  { plugin: 'faq-pages', regex:
    /^(domande-frequenti-frontalieri|frequently-asked-questions|haeufige-fragen|questions-frequentes)\// },
  { plugin: 'alerts', regex:
    /^(allerte|alerts|warnungen|alertes|report|reports)\// },
  // Site-search root paths (one .html per locale).
  { plugin: 'site-search', regex: /^(ricerca|search|suche|recherche)(\/|\.html$)/ },
  // assets bundle (incl. webfonts)
  { plugin: 'assets', prefixes: ['assets/', 'fonts/'] },
  // data files shipped
  { plugin: 'data', prefixes: ['dati/', 'data/'] },
  // sitemaps + robots + rss feeds + .well-known
  { plugin: 'sitemap', regex: /^sitemap[^/]*\.xml(\.gz)?$|^robots\.txt$|^rss(-[a-z]{2})?\.xml$|^\.well-known(\/|$)/ },
  // OG images
  { plugin: 'og-images', prefixes: ['og-images/', 'og/'] },
  // public/ root images
  { plugin: 'images', prefixes: ['images/', 'img/'] },
  // PDFs (whitepapers)
  { plugin: 'pdf', regex: /\.pdf$/ },
  // LLM-facing prose dumps (llms.txt + llms-full.txt)
  { plugin: 'llms-txt', regex: /^llms(-full)?\.txt$/ },
  // Root-level static `.html` redirect aliases: lavoro-ticino-{role}.html,
  // calcolatore.html, contatti.html, glossary.html, etc. These are emitted
  // by individual small plugins; bucket together so they don't pollute
  // `other-*` 50+ times each.
  { plugin: 'static-aliases', regex: /^[a-z][a-z0-9-]*\.html$/ },
];

function classify(relPath) {
  // Detect locale (top-level segment)
  let locale = 'it';
  let remainder = relPath;
  const firstSlash = relPath.indexOf('/');
  if (firstSlash > 0) {
    const head = relPath.slice(0, firstSlash);
    if (LOCALES.has(head)) {
      locale = head;
      remainder = relPath.slice(firstSlash + 1);
    }
  } else if (LOCALES.has(relPath)) {
    // bare 'en' file? shouldn't happen, but be safe
    locale = relPath;
    remainder = '';
  }

  for (const rule of PLUGIN_RULES) {
    if (rule.prefixes) {
      for (const p of rule.prefixes) {
        if (remainder.startsWith(p) || remainder === p.replace(/\/$/, '')) {
          return { plugin: rule.plugin, locale };
        }
      }
    }
    if (rule.regex && rule.regex.test(remainder)) {
      return { plugin: rule.plugin, locale };
    }
  }
  // Unknown — bucket by top segment of remainder (or 'root' if none)
  const idx = remainder.indexOf('/');
  const topSeg = idx > 0 ? remainder.slice(0, idx) : remainder;
  return { plugin: `other-${topSeg || 'root'}`, locale };
}

async function walk(distDir) {
  const totals = {
    totalBytes: 0,
    totalFiles: 0,
    byPlugin: {},      // plugin → { bytes, files }
    byLocale: {},      // locale → { bytes, files }
    byPluginLocale: {},// "plugin/locale" → { bytes, files }
  };

  async function recurse(absDir, relDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await recurse(abs, rel);
      } else if (e.isFile()) {
        let st;
        try { st = await stat(abs); } catch { continue; }
        const bytes = st.size;
        const { plugin, locale } = classify(rel);

        totals.totalBytes += bytes;
        totals.totalFiles += 1;

        const pb = totals.byPlugin[plugin] ||= { bytes: 0, files: 0 };
        pb.bytes += bytes; pb.files += 1;

        const lb = totals.byLocale[locale] ||= { bytes: 0, files: 0 };
        lb.bytes += bytes; lb.files += 1;

        const key = `${plugin}/${locale}`;
        const plb = totals.byPluginLocale[key] ||= { bytes: 0, files: 0 };
        plb.bytes += bytes; plb.files += 1;
      }
    }
  }

  await recurse(distDir, '');
  return totals;
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function printSummary(totals) {
  const rows = Object.entries(totals.byPlugin)
    .sort((a, b) => b[1].bytes - a[1].bytes);
  console.log('\n[dist-bytes-report] by plugin:');
  for (const [plugin, { bytes, files }] of rows) {
    const pct = ((bytes / totals.totalBytes) * 100).toFixed(1);
    console.log(`  ${plugin.padEnd(22)} ${fmtBytes(bytes).padStart(10)}  ${pct.padStart(5)}%  (${files} files)`);
  }
  console.log('\n[dist-bytes-report] by locale:');
  for (const [locale, { bytes, files }] of Object.entries(totals.byLocale).sort((a, b) => b[1].bytes - a[1].bytes)) {
    const pct = ((bytes / totals.totalBytes) * 100).toFixed(1);
    console.log(`  ${locale.padEnd(4)} ${fmtBytes(bytes).padStart(10)}  ${pct.padStart(5)}%  (${files} files)`);
  }
  console.log(`\n[dist-bytes-report] TOTAL: ${fmtBytes(totals.totalBytes)}  (${totals.totalFiles} files)\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distDir = isAbsolute(args.dist) ? args.dist : join(ROOT, args.dist);
  if (!existsSync(distDir)) {
    console.error(`[dist-bytes-report] dist not found: ${distDir}`);
    process.exit(2);
  }

  const t0 = Date.now();
  const totals = await walk(distDir);
  const elapsedMs = Date.now() - t0;

  printSummary(totals);
  console.log(`[dist-bytes-report] walk: ${(elapsedMs / 1000).toFixed(1)}s`);

  const row = {
    timestamp: new Date().toISOString(),
    runId: args.runId,
    sha: args.sha,
    totalBytes: totals.totalBytes,
    totalFiles: totals.totalFiles,
    tarSizeBytes: args.tarSizeBytes,
    byPlugin: totals.byPlugin,
    byLocale: totals.byLocale,
    byPluginLocale: totals.byPluginLocale,
  };

  if (args.append) {
    const historyPath = join(ROOT, 'data', 'dist-size-history.jsonl');
    if (!existsSync(historyPath)) writeFileSync(historyPath, '');
    appendFileSync(historyPath, JSON.stringify(row) + '\n');
    console.log(`[dist-bytes-report] appended to data/dist-size-history.jsonl`);
  }

  // Gate
  if (args.gateTotalBytes != null && Number.isFinite(args.gateTotalBytes)) {
    const subject = args.tarSizeBytes ?? totals.totalBytes;
    const label = args.tarSizeBytes != null ? 'tar' : 'dist';
    if (subject > args.gateTotalBytes) {
      console.error(
        `\n[dist-bytes-report] GATE FAIL: ${label} size ${fmtBytes(subject)} ` +
        `exceeds ${fmtBytes(args.gateTotalBytes)}. ` +
        `GitHub Pages artifact hard cap is 10 GB — blocking deploy ` +
        `before it fails downstream.`
      );
      process.exit(1);
    }
    console.log(`[dist-bytes-report] gate OK: ${label} ${fmtBytes(subject)} < ${fmtBytes(args.gateTotalBytes)}`);
  }
}

main().catch((err) => {
  console.error('[dist-bytes-report] error:', err);
  process.exit(2);
});
