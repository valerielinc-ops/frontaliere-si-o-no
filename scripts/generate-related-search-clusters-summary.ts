import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergeRelatedSearchSummaryPartials,
  relatedSearchClustersPlugin,
  type RelatedSearchSummaryPartial,
} from '../build-plugins/relatedSearchClustersPlugin';
import { resolveJobsSeoPagesFlushed } from '../build-plugins/shared/buildSignals';

const outputPath = process.env.RELATED_SEARCH_CLUSTERS_SUMMARY_OUT;
if (!outputPath) {
  throw new Error('RELATED_SEARCH_CLUSTERS_SUMMARY_OUT is required');
}

const SUMMARY_LOCALES = ['it', 'en', 'de', 'fr'] as const;

/**
 * Il matching di un candidato dipende solo dai job e dal suo locale. Su un
 * runner da 4 core il summary all-locale (prepass postings + build-contexts,
 * un thread per volta) si divide in un processo per locale: ognuno scrive un
 * parziale con l'indice globale dei candidati e il genitore ricompone il file
 * IDENTICO byte per byte a quello sequenziale (verificato dal `prep_compare`
 * del banco). `RELATED_SEARCH_SUMMARY_PARALLEL=0` torna al percorso storico.
 */
async function runParallel(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-summary-'));
  const script = fileURLToPath(import.meta.url);
  const started = Date.now();
  const partialPaths = SUMMARY_LOCALES.map((locale) => path.join(tmpDir, `${locale}.json`));
  const children: ChildProcess[] = [];
  try {
    await Promise.all(
      SUMMARY_LOCALES.map(
        (locale, index) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [...process.execArgv, script], {
              stdio: 'inherit',
              env: {
                ...process.env,
                RELATED_SEARCH_SUMMARY_SCOPE: locale,
                RELATED_SEARCH_SUMMARY_PARTIAL_OUT: partialPaths[index],
              },
            });
            children.push(child);
            child.once('error', reject);
            child.once('exit', (code) =>
              code === 0 ? resolve() : reject(new Error(`summary child ${locale} exited with code ${code}`)),
            );
          }),
      ),
    );
    const partials = partialPaths.map(
      (partialPath) => JSON.parse(fs.readFileSync(partialPath, 'utf-8')) as RelatedSearchSummaryPartial,
    );
    const summary = mergeRelatedSearchSummaryPartials(partials);
    const absolutePath = path.resolve(process.cwd(), outputPath as string);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(summary), 'utf-8');
    console.log(
      `related-search summary: ${SUMMARY_LOCALES.length} locale processes merged in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } finally {
    // Se un figlio fallisce gli altri non devono continuare a occupare il
    // runner: si fermano, e la cartella dei parziali sparisce comunque.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const isChild = Boolean(process.env.RELATED_SEARCH_SUMMARY_PARTIAL_OUT);
if (!isChild && process.env.RELATED_SEARCH_SUMMARY_PARALLEL !== '0') {
  await runParallel();
} else {
  // The summary-only plugin path performs the same exact all-locale matching as
  // a monolithic build, then serializes only the metadata foreign shards need.
  // There is no jobs-seo producer in this prep process, so resolve its barrier
  // explicitly; the production build keeps the normal producer/consumer barrier.
  resolveJobsSeoPagesFlushed();
  const plugin = relatedSearchClustersPlugin(process.cwd());
  const closeBundle = plugin.closeBundle;
  if (typeof closeBundle !== 'function') {
    throw new Error('related-search-clusters plugin has no callable closeBundle hook');
  }
  await closeBundle.call(plugin);
  if (isChild) {
    console.log(
      `[summary-child] scope=${process.env.RELATED_SEARCH_SUMMARY_SCOPE} rss_mb=${Math.round(process.memoryUsage().rss / 1048576)} ` +
        `max_rss_mb=${Math.round(process.resourceUsage().maxRSS / 1024)}`,
    );
  }
}

console.log(`related-search-clusters summary ready: ${path.resolve(outputPath)}`);
