import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistDutyWeekHistory } from './lib/pharmacy-duty-week-history';

// The atomic refresh owns this generated directory. Tests call the parameterized
// writer with temporary fixtures, never this entry point or the tracked feeds.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(fs.readFileSync(resolve(root, 'data/pharmacies-ticino-complete.json'), 'utf8'));
const duties = JSON.parse(fs.readFileSync(resolve(root, 'data/pharmacy-duties-ticino.json'), 'utf8'));
const written = persistDutyWeekHistory(resolve(root, 'data/pharmacy-duty-week-history'), catalogue, duties);
console.log(`[pharmacy-duty-week-history] ${written} observed weekly editions updated; no current availability inferred`);
