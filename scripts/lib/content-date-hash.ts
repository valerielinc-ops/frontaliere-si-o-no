/**
 * Hashes behind `data/content-dates.json`.
 *
 * `git log` cannot date this content at build time: every deploy checkout is
 * shallow, so all pages would report the last commit. The dates are therefore
 * committed, and the hash is what proves they are real: a text or parameter
 * change without a new date fails `tests/content-dates.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AC_SALARY_CAP_CHF,
  CH_SOCIAL_RATE,
  DEFAULT_TECH_PARAMS,
  FRANCHIGIA_NUOVI_FRONTALIERI,
  ITALY_CHILD_ALLOWANCE_ANNUAL_MIN,
  LOMBARDIA_ADDIZIONALE_REGIONALE,
  SWISS_CHILD_ALLOWANCE_ANNUAL,
} from '../../constants';
import type { FaqHubEntry } from '../../data/faq-hub';

const FISCAL_SOURCE_FILES = [
  'services/calculationService.ts',
  'services/irpefAddizionaleRegime.ts',
  'services/pensionParameters.ts',
];

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Only what the reader sees: moving a field or adding a label does not date the answer. */
export function hashFaqEntry(entry: FaqHubEntry): string {
  return sha(JSON.stringify([entry.question, entry.answer, entry.sources]));
}

/** Parameter values of `constants.ts` (not the whole file) plus the calculation sources. */
export function hashFiscalParams(rootDir: string): string {
  const values = JSON.stringify([
    AC_SALARY_CAP_CHF,
    CH_SOCIAL_RATE,
    DEFAULT_TECH_PARAMS,
    FRANCHIGIA_NUOVI_FRONTALIERI,
    ITALY_CHILD_ALLOWANCE_ANNUAL_MIN,
    LOMBARDIA_ADDIZIONALE_REGIONALE,
    SWISS_CHILD_ALLOWANCE_ANNUAL,
  ]);
  return sha(values + FISCAL_SOURCE_FILES.map((file) => readFileSync(resolve(rootDir, file), 'utf8')).join('\n'));
}
