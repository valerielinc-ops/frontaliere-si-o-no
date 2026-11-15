/**
 * Perimetro dei workflow dei sender di email (perf-plan email senders, B4/C8/D4/
 * E3/F1-F3). Per ognuno:
 *
 *  1. SEGRETI. Lo step di Remote Config usa `--only-env` con SOLO le chiavi che il
 *     codice del job legge davvero da `process.env`. Una chiave nuova letta e non
 *     elencata fa fallire QUESTO test (la CI), non il job in produzione, dove
 *     un provider senza chiave degraderebbe l'invio in silenzio.
 *  2. INSTALL. `npm ci` solo su miss della cache di node_modules (composite
 *     action `npm-ci-cached`), e nessun `cache: npm` di setup-node.
 *  3. TIMEOUT. Il job dichiara `timeout-minutes`.
 *
 * La catena di importazione e' calcolata staticamente (import statici e dinamici
 * con specificatore letterale) dagli stessi entry point che il workflow esegue;
 * lo stesso metodo di tests/send-job-alerts-workflow-perimeter.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { importSpecifiers } from '../scripts/ci/check-dependency-free-import-closure.mjs';
import { stripSourceComments } from '../scripts/lib/source-comments.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

const ROOT = path.resolve(__dirname, '..');
const SLOW = 120_000;
const mapped = new Set(Object.values(RC_TO_ENV as Record<string, string[]>).flat());

/** Entry point comuni: quelli che ogni workflow esegue o carica con import() pigro. */
const COMMON_ENTRY_POINTS = [
  'scripts/load-rc-env.mjs',
  'scripts/lib/github-issue-creator.mjs',
  'scripts/lib/email-cascade.mjs',
  'scripts/lib/firestore-admin.mjs',
  'functions/src/emailCascade.js',
];

/**
 * Moduli che l'assemble IMPORTA solo per funzioni di utilita', ma il cui carico
 * di segreti (provider AI e di traduzione) non viene mai eseguito in questi job.
 * Le loro chiavi non vanno nello step di Remote Config.
 */
const KEYS_NOT_NEEDED_FROM = new Set([
  'scripts/lib/ai-models.mjs',
  'scripts/lib/free-translate.mjs',
  'scripts/lib/shared-jobs-crawler.mjs',
]);

interface SenderPerimeter {
  name: string;
  workflow: string;
  jobId: string;
  entryPoints: string[];
  /** Moduli aggiuntivi le cui chiavi non servono (con motivo). */
  extraKeysNotNeededFrom?: string[];
  /** Chiavi che DEVONO restare elencate. */
  mustList?: string[];
  /** Chiavi che NON devono comparire (segreti di altri canali). */
  mustNotList?: string[];
}

const UNRELATED = ['GITHUB_PAT', 'LINKEDIN_ACCESS_TOKEN', 'TIKTOK_ACCESS_TOKEN', 'FB_PAGE_ACCESS_TOKEN'];

const SENDERS: SenderPerimeter[] = [
  {
    name: 'company-alerts',
    workflow: 'send-company-alerts.yml',
    jobId: 'send-company-alerts',
    entryPoints: ['scripts/assemble-jobs-dataset.mjs', 'scripts/send-company-alerts.mjs'],
    mustList: ['ENABLE_JOB_ALERTS', 'NEWSLETTER_SECRET', 'MAILEROO_API_KEY', 'RESEND_API_KEY'],
    mustNotList: [...UNRELATED, 'GEMINI_API_KEY', 'GROQ_API_KEY'],
  },
];

// ── closure con memoria: ogni file si analizza una sola volta ──────────────────
const sourceCache = new Map<string, string | null>();
const specCache = new Map<string, string[]>();
const strippedCache = new Map<string, string>();

function readSource(rel: string): string | null {
  if (!sourceCache.has(rel)) {
    try { sourceCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { sourceCache.set(rel, null); }
  }
  return sourceCache.get(rel)!;
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}/index.mjs`, `${base}/index.js`, `${base}/index.ts`]) {
    try { if (fs.statSync(path.join(ROOT, candidate)).isFile()) return candidate; } catch { /* prossimo */ }
  }
  return null;
}

function importsOf(rel: string): string[] {
  let cached = specCache.get(rel);
  if (!cached) {
    const src = readSource(rel);
    cached = src && /\.(m?js|ts|tsx)$/.test(rel)
      ? importSpecifiers(src).map((spec: string) => resolveImport(rel, spec)).filter(Boolean) as string[]
      : [];
    specCache.set(rel, cached);
  }
  return cached;
}

function closureOf(entries: string[]) {
  const seen = new Set<string>();
  const missing: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    if (readSource(rel) === null) { missing.push(rel); continue; }
    seen.add(rel);
    for (const target of importsOf(rel)) if (!seen.has(target)) queue.push(target);
  }
  return { files: seen, missing };
}

function stripped(rel: string): string {
  let code = strippedCache.get(rel);
  if (code === undefined) { code = stripSourceComments(readSource(rel) ?? ''); strippedCache.set(rel, code); }
  return code;
}

function envNamesRead(rel: string): Set<string> {
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
}

function loadWorkflow(file: string) {
  const text = fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
  return { text, doc: YAML.parse(text, { logLevel: 'silent' }) as any };
}

describe.each(SENDERS)('$name — perimetro del workflow', (sender) => {
  const { doc } = loadWorkflow(sender.workflow);
  const job = doc.jobs[sender.jobId];
  const steps: any[] = job.steps;
  const loadStep = steps.find((s) => String(s?.run ?? '').includes('scripts/load-rc-env.mjs'));
  const onlyEnvArg = String(loadStep?.run ?? '').match(/--only-env=(\S+)/)?.[1] ?? '';
  const listed = new Set(onlyEnvArg.split(',').filter(Boolean));

  it('lo step di Remote Config usa --only-env con chiavi note al loader e nessun doppione', () => {
    expect(loadStep, 'step load-rc-env.mjs').toBeTruthy();
    expect(onlyEnvArg).not.toBe('');
    const list = onlyEnvArg.split(',');
    expect(new Set(list).size).toBe(list.length);
    for (const name of list) expect(mapped.has(name), `${name} non e in RC_TO_ENV`).toBe(true);
  });

  it('ogni chiave Remote Config letta dal codice del job e elencata', () => {
    const closure = closureOf([...COMMON_ENTRY_POINTS, ...sender.entryPoints]);
    expect(closure.missing).toEqual([]);
    const skip = new Set([...KEYS_NOT_NEEDED_FROM, ...(sender.extraKeysNotNeededFrom ?? [])]);
    const missing: string[] = [];
    for (const rel of closure.files) {
      if (skip.has(rel) || !/\.(m?js|ts)$/.test(rel)) continue;
      for (const name of envNamesRead(rel)) {
        if (mapped.has(name) && !listed.has(name)) missing.push(`${name} (${rel})`);
      }
    }
    expect(missing, `chiavi lette dal codice e assenti da --only-env: ${missing.join(', ')}`).toEqual([]);
  }, SLOW);

  it('le chiavi del canale ci sono e i segreti di altri canali no', () => {
    for (const needed of sender.mustList ?? []) expect(listed.has(needed), needed).toBe(true);
    for (const unrelated of sender.mustNotList ?? UNRELATED) expect(listed.has(unrelated), unrelated).toBe(false);
  });

  it('install con cache: composite npm-ci-cached, nessun npm ci diretto ne cache: npm', () => {
    expect(steps.some((s) => s?.uses === './.github/actions/npm-ci-cached')).toBe(true);
    expect(steps.filter((s) => /(^|\s)npm ci(\s|$)/.test(String(s?.run ?? '')))).toEqual([]);
    for (const step of steps) {
      if (String(step?.uses ?? '').startsWith('actions/setup-node@')) expect(step.with?.cache).toBeUndefined();
    }
  });

  it('il job dichiara timeout-minutes', () => {
    expect(typeof job['timeout-minutes']).toBe('number');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(120);
  });
});
