/**
 * Contratto dei flag dell'assemble nei workflow dei sender (perf-plan email
 * senders, B1/C7/D1).
 *
 * I flag passati alla composite `assemble-jobs-cache-key` (input `args`) e quelli
 * dello step `node scripts/assemble-jobs-dataset.mjs` DEVONO essere identici: la
 * chiave e' calcolata con i flag, e uno scarto fa mancare la cache a ogni run
 * (o, peggio, ripristinare un'uscita costruita in un'altra modalita').
 *
 * Il test tiene anche vera la PRECONDIZIONE del flag `--active-only
 * --no-summaries`: il sender legge solo `data/jobs.json` (mai l'archivio degli
 * scaduti, `previousSlugs` o i riassunti dei crawler) e l'assemble in modalita'
 * active-only non salta mai la lettura delle slice `expired`, che alimentano il
 * carry-forward di `firstSeenAt`: la chiave le include ancora.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '../scripts/lib/source-comments.mjs';

const ROOT = path.resolve(__dirname, '..');

interface Case {
  name: string;
  workflow: string;
  jobId: string;
  /** Flag attesi (nell'ordine in cui compaiono). */
  flags: string;
  /** Script del sender: non deve leggere i dati che il flag salta. */
  sender: string;
}

const CASES: Case[] = [
  {
    name: 'company-alerts',
    workflow: 'send-company-alerts.yml',
    jobId: 'send-company-alerts',
    flags: '--active-only --no-summaries',
    sender: 'scripts/send-company-alerts.mjs',
  },
  {
    name: 'saved-jobs-digest',
    workflow: 'send-saved-jobs-digest.yml',
    jobId: 'send-digest',
    flags: '--active-only --no-summaries',
    sender: 'scripts/send-saved-jobs-digest.mjs',
  },
];

// C7 / D1 — dove i flag NON si applicano, e perche.
//   newsletter: il sender legge `previousSlugs` / `previousSlugsByLocale`
//   (buildJobContextIndex, validSlugs di sanitizeJobUrls): in modalita active-only
//   l'assemble non esegue la riconciliazione degli scaduti che li popola, quindi un
//   link valido per slug storico verrebbe riscritto. Il workflow resta in assemble
//   completo e questo test tiene vera la ragione.
describe('newsletter: assemble completo, perche legge previousSlugs', () => {
  const source = stripSourceComments(fs.readFileSync(path.join(ROOT, 'scripts/send-newsletter.mjs'), 'utf8'));
  const doc: any = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/send-newsletter.yml'), 'utf8'), { logLevel: 'silent' });
  const steps: any[] = doc.jobs.newsletter.steps;

  it('il sender legge previousSlugs: il flag --active-only non e applicabile', () => {
    expect(source).toContain('previousSlugs');
  });

  it('il workflow non passa --active-only / --no-summaries ne alla key action ne all assemble', () => {
    const keyStep = steps.find((s) => s?.uses === './.github/actions/assemble-jobs-cache-key');
    const assembleStep = steps.find((s) => /assemble-jobs-dataset\.mjs/.test(String(s?.run ?? '')));
    expect(String(keyStep?.with?.args ?? '')).toBe('');
    expect(String(assembleStep?.run)).not.toMatch(/--active-only|--no-summaries/);
  });

  it('assegna heap sufficiente all assemble completo senza cambiare il contratto del sender', () => {
    const assembleStep = steps.find((s) => /assemble-jobs-dataset\.mjs/.test(String(s?.run ?? '')));
    expect(String(assembleStep?.env?.NODE_OPTIONS)).toContain('--max-old-space-size=8192');
  });
});

const normalize = (value: string) => value.trim().split(/\s+/).filter(Boolean).join(' ');

describe.each(CASES)('$name — flag dell\'assemble', (c) => {
  const doc: any = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', c.workflow), 'utf8'), { logLevel: 'silent' });
  const steps: any[] = doc.jobs[c.jobId].steps;
  const keyStep = steps.find((s) => s?.uses === './.github/actions/assemble-jobs-cache-key');
  const assembleStep = steps.find((s) => /node scripts\/assemble-jobs-dataset\.mjs(\s|$)/.test(String(s?.run ?? '')));

  it('i flag della key action e dello step di assemble sono identici', () => {
    expect(keyStep, 'step assemble-jobs-cache-key').toBeTruthy();
    expect(assembleStep, 'step assemble').toBeTruthy();
    const keyFlags = normalize(String(keyStep.with?.args ?? ''));
    const runFlags = normalize(String(assembleStep.run).replace(/^[\s\S]*?node scripts\/assemble-jobs-dataset\.mjs/, ''));
    expect(keyFlags).toBe(normalize(c.flags));
    expect(runFlags).toBe(keyFlags);
  });

  it('la cache e ripristinata e salvata con la chiave calcolata dalla key action', () => {
    const restore = steps.find((s) => String(s?.uses ?? '').startsWith('actions/cache/restore@'));
    const save = steps.find((s) => String(s?.uses ?? '').startsWith('actions/cache/save@'));
    for (const step of [restore, save]) {
      expect(step, 'cache step').toBeTruthy();
      expect(step.with.key).toContain('steps.assemble_cache_key.outputs.key');
      expect(step.with['restore-keys']).toBeUndefined();
    }
    expect(restore.with.key).toBe(save.with.key);
  });

  if (c.flags.includes('--active-only') || c.flags.includes('--no-summaries')) {
    it('PRECONDIZIONE: il sender non legge expired-jobs, previousSlugs ne i riassunti dei crawler', () => {
      const code = stripSourceComments(fs.readFileSync(path.join(ROOT, c.sender), 'utf8'));
      for (const forbidden of ['expired-jobs', 'previousSlugs', 'crawler-summaries', 'jobs-crawler-summaries', 'jobs-meta']) {
        expect(code.includes(forbidden), `${c.sender} legge ${forbidden}`).toBe(false);
      }
      // L'unico file di dati dell'assemble che il sender legge.
      expect(code).toContain("path.join(ROOT, 'data', 'jobs.json')");
    });
  }
});

describe('assemble-jobs-dataset: la modalita active-only dipende ancora dalle slice expired', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/assemble-jobs-dataset.mjs'), 'utf8');

  it('la chiave di cache hasha le slice expired in ogni modalita (nessuna esclusione in active-only)', () => {
    const fingerprint = src.slice(src.indexOf('export function computeAssembleInputFingerprint()'));
    const head = fingerprint.slice(0, 400);
    expect(head).toContain('const dirs = [JOBS_SLICES_DIR, EXPIRED_SLICES_DIR, SUMMARIES_SLICES_DIR];');
  });

  it('il motivo: l\'assemble attivo legge la slice expired per il carry-forward di firstSeenAt', () => {
    expect(src).toMatch(/expiredSlice = readExpiredSliceRows\(crawlerKey, \{ dir: EXPIRED_SLICES_DIR \}\)/);
    expect(src).toMatch(/carryForwardFirstSeenAt\(hardened\.jobs, \{\s*existingJobs: priorJobs \|\| \[\],\s*archivedJobs: Array\.isArray\(expiredSlice\)/);
  });
});
