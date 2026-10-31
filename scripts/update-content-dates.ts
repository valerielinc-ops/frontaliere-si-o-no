/**
 * Refreshes `data/content-dates.json`: every FAQ entry or fiscal parameter set
 * whose hash changed gets today's date, the others keep theirs.
 *
 *   npx tsx scripts/update-content-dates.ts
 *
 * Run it after editing `data/faq-hub/*` or the calculation parameters;
 * `tests/content-dates.test.ts` fails until the dates are in step.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_FAQ_HUB } from '../data/faq-hub';
import { hashFaqEntry, hashFiscalParams } from './lib/content-date-hash';

interface DatedHash { updatedAt: string; hash: string }
interface ContentDates { fiscalParams: DatedHash; faq: Record<string, DatedHash> }

const rootDir = process.cwd();
const file = resolve(rootDir, 'data/content-dates.json');
const previous = JSON.parse(readFileSync(file, 'utf8')) as ContentDates;
const today = new Date().toISOString().slice(0, 10);

const carry = (record: DatedHash | undefined, hash: string): DatedHash =>
  record?.hash === hash ? record : { updatedAt: today, hash };

const next: ContentDates = {
  fiscalParams: carry(previous.fiscalParams, hashFiscalParams(rootDir)),
  faq: Object.fromEntries(
    [...ALL_FAQ_HUB]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => [entry.id, carry(previous.faq[entry.id], hashFaqEntry(entry))]),
  ),
};

writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
const changed = Object.entries(next.faq).filter(([id, record]) => previous.faq[id]?.hash !== record.hash).length;
console.log(`[content-dates] ${changed} FAQ entries re-dated, fiscal params ${next.fiscalParams === previous.fiscalParams ? 'unchanged' : 're-dated'}`);
