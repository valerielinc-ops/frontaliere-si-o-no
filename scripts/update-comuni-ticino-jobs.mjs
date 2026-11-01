#!/usr/bin/env node
/**
 * Comuni ticinesi: i concorsi pubblicati dai singoli Comuni.
 *
 * Tutta la logica sta in ./lib/ticino-comuni-crawler.mjs, l'elenco dei Comuni
 * in data/ticino-comuni-registry.json.
 */
import { runTicinoComuniCrawler } from './lib/ticino-comuni-crawler.mjs';

const TICINO_COMUNI_KEY = 'comuni-ticino';
const COMPANY_NAME = 'Comuni ticinesi';

console.log(`🏛️ ${COMPANY_NAME} (${TICINO_COMUNI_KEY})`);
runTicinoComuniCrawler();
