#!/usr/bin/env node
/**
 * Crawler — cantonal/municipal agendas on the iCMS platform (P9a), one
 * source per run, on the shared `createAgendaCrawler` factory:
 *
 *   node scripts/crawl-icms-agenda.mjs --source nw-agenda [--dry-run]
 *   node scripts/crawl-icms-agenda.mjs --source ow-agenda
 *   node scripts/crawl-icms-agenda.mjs --source lu-stadt-agenda
 *
 * Each source is one document fetched once per run (the whole upcoming
 * agenda is in it), parsed by scripts/lib/icms-agenda.mjs. robots.txt of the
 * three hosts is empty (no rule, no AI-bot block) as of 2026-10-05.
 * A run whose fetch fails writes nothing and exits 0 (factory contract: a
 * transient network/WAF failure keeps the previous slice); a page that loads
 * but yields zero events exits 1 (format drift), so crawl-events.yml
 * surfaces it.
 */
import { pathToFileURL } from 'node:url';
import { createAgendaCrawler } from './lib/agenda-crawler-factory.mjs';
import { EVENT_SOURCES } from './lib/events-utils.mjs';
import { parseIcmsAnlaesseHtml, parseIcmsTermineRss } from './lib/icms-agenda.mjs';

/** Per-source fetch target and parser; keys must exist in EVENT_SOURCES. */
export const ICMS_AGENDAS = {
  'nw-agenda': { url: 'https://www.nw.ch/anlaesseaktuelles', origin: 'https://www.nw.ch', format: 'anlaesse' },
  'ow-agenda': { url: 'https://www.ow.ch/anlaesseaktuelles', origin: 'https://www.ow.ch', format: 'anlaesse' },
  'lu-stadt-agenda': { url: 'https://www.stadtluzern.ch/aktuelles/termine.rss', origin: 'https://www.stadtluzern.ch', format: 'rss' },
};

export function parserFor(sourceKey) {
  const agenda = ICMS_AGENDAS[sourceKey];
  const source = EVENT_SOURCES[sourceKey];
  if (!agenda || !source) throw new Error(`unknown iCMS agenda source: ${sourceKey}`);
  const context = { sourceKey, canton: source.canton, origin: agenda.origin };
  return agenda.format === 'rss'
    ? (body) => parseIcmsTermineRss(body, context)
    : (body) => parseIcmsAnlaesseHtml(body, context);
}

function sourceArg(argv) {
  const index = argv.indexOf('--source');
  if (index >= 0) return argv[index + 1];
  return argv.find((arg) => arg.startsWith('--source='))?.slice('--source='.length);
}

async function main() {
  const argv = process.argv.slice(2);
  const sourceKey = sourceArg(argv);
  if (!sourceKey || !ICMS_AGENDAS[sourceKey]) {
    console.error(`usage: node scripts/crawl-icms-agenda.mjs --source <${Object.keys(ICMS_AGENDAS).join('|')}> [--dry-run]`);
    process.exit(2);
  }
  const crawler = createAgendaCrawler({
    sourceKey,
    baseUrl: () => ICMS_AGENDAS[sourceKey].url,
    parseDayHtml: parserFor(sourceKey),
    iterations: 1,
  });
  const dryRun = argv.includes('--dry-run');
  const { events } = await crawler.crawl({ dryRun });
  if (dryRun) console.log(JSON.stringify(events.slice(0, 3), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[icms-agenda] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
