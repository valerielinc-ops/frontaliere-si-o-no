/**
 * Perimetro del workflow `send-job-alerts.yml` (perf-plan PR 7).
 *
 * Tre rischi, ognuno trasformato in un rosso di CI invece che in un job di
 * produzione fallito (o, peggio, in un invio degradato in silenzio):
 *
 *  1. CHECKOUT. Resta PIENO, per misura: togliere `public/images/` (4,4 GB)
 *     lascerebbe ~2,2 GB di dati letti dall'assemble, sopra la soglia oltre cui lo
 *     sparse con `filter: blob:none` e' piu' lento del fetch unico (vedi
 *     `tests/checkout-sparse-profiles.test.ts`). Il test tiene vere due cose: che
 *     il workflow non abbia un profilo sparse non generato, e la PRECONDIZIONE per
 *     un futuro profilo: il codice del job legge UN solo percorso di
 *     `public/images/`, `brands/`. Se qualcuno ne legge un altro, il test fallisce
 *     prima che serva scoprirlo con un ENOENT in produzione.
 *  2. SEGRETI. Lo step di Remote Config riceve solo le chiavi che il codice legge
 *     davvero da `process.env`. Una chiave nuova letta e non elencata fallisce qui.
 *  3. CACHE di `node_modules`, chiave sul lockfile e sulla major di Node.
 *
 * La catena di importazione e' calcolata qui, staticamente (import statici e
 * dinamici con specificatore letterale), partendo dagli stessi entry point che
 * lo step del workflow esegue.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { importSpecifiers } from '../scripts/ci/check-dependency-free-import-closure.mjs';
import { stripSourceComments } from '../scripts/lib/source-comments.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/send-job-alerts.yml');
const doc: any = YAML.parse(fs.readFileSync(WORKFLOW, 'utf8'), { logLevel: 'silent' });
const job = doc.jobs['send-alerts'];
const steps: any[] = job.steps;

/** Gli entry point che il workflow esegue, e quelli che il sender carica con `import()` pigro. */
const ENTRY_POINTS = [
  'scripts/load-rc-env.mjs',
  'scripts/assemble-jobs-dataset.mjs',
  'scripts/send-job-alerts.mjs',
  'scripts/lib/github-issue-creator.mjs',
  // Caricati dal sender con import dinamico dentro funzioni (cascade e handle Firestore).
  'scripts/lib/email-cascade.mjs',
  'scripts/lib/firestore-admin.mjs',
  'functions/src/emailCascade.js',
];

/**
 * Moduli che l'assemble IMPORTA solo per funzioni di utilita' (dedicated-crawler-common),
 * ma il cui carico di segreti (provider AI e di traduzione) non viene mai eseguito
 * in questo job. Le loro chiavi non vanno nello step di Remote Config.
 */
const KEYS_NOT_NEEDED_FROM = new Set([
  'scripts/lib/ai-models.mjs',
  'scripts/lib/free-translate.mjs',
  'scripts/lib/shared-jobs-crawler.mjs',
]);

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // pacchetti e builtin: non sono file del repo
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}/index.mjs`, `${base}/index.js`, `${base}/index.ts`]) {
    const full = path.join(ROOT, candidate);
    try { if (fs.statSync(full).isFile()) return candidate; } catch { /* prossimo */ }
  }
  return null;
}

function importClosure(entries: string[]) {
  const seen = new Map<string, string>();
  const missing: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    let src: string;
    try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { missing.push(rel); continue; }
    seen.set(rel, src);
    if (!/\.(m?js|ts|tsx)$/.test(rel)) continue;
    for (const spec of importSpecifiers(src)) {
      const target = resolveImport(rel, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return { files: seen, missing };
}

const closure = importClosure(ENTRY_POINTS);
// Togliere i commenti da ~350 file costa secondi: si fa una volta sola, alla prima richiesta.
const strippedCache = new Map<string, string>();
const stripped = (rel: string) => {
  let code = strippedCache.get(rel);
  if (code === undefined) { code = stripSourceComments(closure.files.get(rel) ?? ''); strippedCache.set(rel, code); }
  return code;
};
const SLOW = 120_000;
const checkoutStep = steps.find((step) => typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@'));

describe('checkout', () => {
  it('e pieno e senza un profilo sparse non generato (decisione misurata, documentata nel workflow)', () => {
    expect(checkoutStep?.with?.['sparse-checkout']).toBeUndefined();
    expect(checkoutStep?.with?.filter).toBeUndefined();
    expect(checkoutStep?.with?.['fetch-depth']).toBe(1);
  });

  it('la catena di importazione e completa: nessun import relativo non risolto', () => {
    expect(closure.missing).toEqual([]);
    expect(closure.files.size).toBeGreaterThan(300);
  });

  it('PRECONDIZIONE per un futuro sparse: nessun percorso di public/images/ diverso da brands/ e letto dal codice eseguibile del job', () => {
    const offenders: string[] = [];
    for (const rel of closure.files.keys()) {
      if (!/\.(m?js|ts|tsx)$/.test(rel)) continue;
      const code = stripped(rel).replace(/(['"])\s*,\s*(['"])/g, '/');
      for (const match of code.matchAll(/public\/images(?:\/[\w.-]*)?/g)) {
        if (match[0] !== 'public/images/brands') offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(offenders, `letture di public/images/ fuori da brands/: ${offenders.join('; ')}`).toEqual([]);
  }, SLOW);

  it('il sender cerca i loghi esattamente nella cartella che il profilo reincludere', () => {
    const sender = closure.files.get('scripts/send-job-alerts.mjs')!;
    expect(sender).toContain("path.join(ROOT, 'public', 'images', 'brands')");
  });
});

describe('segreti: solo le chiavi che il codice legge', () => {
  const loadStep = steps.find((s) => s?.name === 'Load secrets from Remote Config');
  const onlyEnvArg = String(loadStep?.run ?? '').match(/--only-env=(\S+)/)?.[1] ?? '';
  const listed = new Set(onlyEnvArg.split(',').filter(Boolean));
  const mapped = new Set(Object.values(RC_TO_ENV as Record<string, string[]>).flat());

  const readFromProcessEnv = (rel: string) => {
    const names = new Set<string>();
    const code = stripped(rel);
    for (const re of [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g, /\benv\.([A-Z][A-Z0-9_]*)\b/g]) {
      for (const m of code.matchAll(re)) names.add(m[1]);
    }
    for (const m of code.matchAll(/\{([^}]{1,400})\}\s*=\s*process\.env/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':')[0].trim();
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
      }
    }
    return names;
  };

  it('lo step usa --only-env, con chiavi note al loader e nessun doppione', () => {
    expect(onlyEnvArg).not.toBe('');
    const list = onlyEnvArg.split(',');
    expect(new Set(list).size).toBe(list.length);
    for (const name of list) expect(mapped.has(name), `${name} non e in RC_TO_ENV`).toBe(true);
    expect(list.length).toBeLessThan(45);
  });

  it('ogni chiave Remote Config letta dal codice del job e elencata', () => {
    const missing: string[] = [];
    for (const rel of closure.files.keys()) {
      if (KEYS_NOT_NEEDED_FROM.has(rel) || !/\.(m?js|ts)$/.test(rel)) continue;
      for (const name of readFromProcessEnv(rel)) {
        if (mapped.has(name) && !listed.has(name)) missing.push(`${name} (${rel})`);
      }
    }
    expect(missing, `chiavi lette dal codice e assenti da --only-env: ${missing.join(', ')}`).toEqual([]);
  }, SLOW);

  it('i segreti di altri canali non sono piu esposti a questo job', () => {
    for (const unrelated of ['GITHUB_PAT', 'LINKEDIN_ACCESS_TOKEN', 'TIKTOK_ACCESS_TOKEN', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'FB_PAGE_ACCESS_TOKEN']) {
      expect(listed.has(unrelated), unrelated).toBe(false);
    }
    // Quelli del canale, invece, ci sono: senza provider il cascade non invia.
    for (const needed of ['MAILEROO_API_KEY', 'MAILGUN_API_KEY', 'RESEND_API_KEY', 'NEWSLETTER_SECRET', 'ENABLE_JOB_ALERTS']) {
      expect(listed.has(needed), needed).toBe(true);
    }
  });

  it('i parametri Remote Config introdotti dalla perf-plan sono tutti mappati e caricati', () => {
    for (const name of [
      'JOB_ALERT_CANDIDATE_INDEX_MODE', 'JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE', 'JOB_EMAIL_RANKING_IMPRESSIONS_MODE',
      'JOB_ALERT_BATCH_BOOKKEEPING', 'JOB_ALERT_LIVE_LINK_MANIFEST', 'JOB_ALERT_LIVE_LINK_MANIFEST_MAX_AGE_HOURS', 'JOB_ALERT_PLAN_BATCH_SIZE',
    ]) {
      expect(mapped.has(name), `${name} in RC_TO_ENV`).toBe(true);
      expect(listed.has(name), `${name} in --only-env`).toBe(true);
    }
  });
});

describe('cache di node_modules e memoria', () => {
  it('node_modules in cache con chiave su lockfile e major di Node; npm ci solo su miss', () => {
    const cache = steps.find((s) => s?.id === 'node-modules-cache');
    expect(cache?.uses).toMatch(/^actions\/cache@/);
    expect(cache?.with?.path).toBe('node_modules');
    expect(cache?.with?.key).toContain("hashFiles('package-lock.json')");
    expect(cache?.with?.key).toContain('node22');
    const install = steps.find((s) => s?.name === 'Install dependencies');
    expect(install?.run).toBe('npm ci');
    expect(install?.if).toContain("steps.node-modules-cache.outputs.cache-hit != 'true'");
  });

  it('NODE_OPTIONS=--max-old-space-size=8192 resta (si toglie dopo 2 run misurate con heap <= 3 GiB)', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    expect((text.match(/--max-old-space-size=8192/g) || []).length).toBe(2);
  });
});
