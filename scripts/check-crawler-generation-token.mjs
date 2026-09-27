#!/usr/bin/env node
/**
 * Preflight del token di generazione di un crawler-group, eseguito subito dopo
 * il checkout e prima di qualunque crawl.
 *
 * Il job riceve `CRAWLER_GENERATION_TOKEN` come
 * `inputs.generation_token || <run_id>-<run_attempt>`: senza input il token si
 * ricava dalle coordinate della run, con la stessa grammatica dell'orchestratore.
 * Un valore ESPLICITO fuori grammatica resta invece un errore (fail-closed, vedi
 * resolveCrawlerGenerationToken), perche' sostituirlo in silenzio scollegherebbe
 * la run dalla generazione che il chiamante voleva correlare.
 *
 * Prima di questo preflight l'errore emergeva solo al commit, dopo 30-60 minuti
 * di crawl: il 2026-09-27 cinque dispatch manuali con token
 * `backlog-100-20260927-group<NN>` hanno crawlato 27+14+29+27+27 membri e poi
 * marcato ciascuno exit 43 con `Missing CRAWLER_GENERATION_TOKEN`.
 *
 * Exit: 0 token valido (stampato), 1 token assente o malformato.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCrawlerGenerationToken, resolveCrawlerGenerationToken } from './lib/crawler-generation-token.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true, token: string } | { ok: false, message: string }}
 */
export function checkCrawlerGenerationToken(env = process.env) {
  const token = resolveCrawlerGenerationToken(env);
  if (isCrawlerGenerationToken(token)) return { ok: true, token };
  const raw = env.CRAWLER_GENERATION_TOKEN;
  const shown = typeof raw === 'string' && raw.length > 0 ? JSON.stringify(raw) : '(vuoto)';
  return {
    ok: false,
    message: `CRAWLER_GENERATION_TOKEN ${shown} non rispetta la grammatica <run_id>-<run_attempt> `
      + '(es. 36326506734-1). Lascia vuoto `generation_token` in un dispatch manuale: il workflow '
      + 'ricava il token da github.run_id e github.run_attempt. Nessun crawler e\' stato avviato.',
  };
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  const result = checkCrawlerGenerationToken(process.env);
  if (result.ok) {
    console.log(`crawler generation token: ${result.token}`);
  } else {
    console.log(`::error title=Invalid crawler generation token::${result.message}`);
    process.exitCode = 1;
  }
}
