import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import YAML from 'yaml';

/**
 * Ratchet sul pool cache Actions (tetto 10 GiB per repo).
 *
 * Il difetto. `actions/setup-node` con `cache: 'npm'` fa restore E save con la
 * stessa chiave, e il save finisce nello scope del ref CORRENTE. Un workflow
 * che gira su `pull_request` scrive quindi una copia per ogni
 * `refs/pull/<n>/merge`: misurato il 2026-09-20, la chiave
 * `node-cache-Linux-x64-npm-965db012…` esisteva in tre copie da 487 MB (main +
 * due PR), 0,91 GiB di byte identici su un pool all'87 % (8,73 GiB/10 GiB) con
 * una finestra di ritenzione di ~10 h. Con 5-6 PR aperte sono ~2,4-2,9 GB. Ogni
 * GB occupato da un duplicato sfratta prima il manifest incrementale e i pack
 * HTML di jobs-seo, che sopravvivono solo finché il deploy successivo arriva
 * dentro la finestra (19-20/09/2026: fermo di 10,2 h, tre leg su quattro senza
 * riuso).
 *
 * L'invariante che questi test tengono fermo NON è «il file è scritto così»: è
 * «nessun percorso che gira su un ref di PR salva la cache npm». La lettura
 * resta libera ovunque, perché lo scope delle cache Actions è gerarchico e una
 * run su `refs/pull/<n>/merge` legge anche le cache del branch di default
 * (verificato sulla run 35507603250: `Cache hit` su chiavi esistenti SOLO su
 * `refs/heads/main`).
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');
const ACTION_PATH = resolve(ROOT, '.github/actions/ci-npm-setup/action.yml');
const ACTION_RAW = readFileSync(ACTION_PATH, 'utf-8');
const ACTION = YAML.parse(ACTION_RAW) as {
  runs?: { steps?: Array<Record<string, unknown>> };
};
const DEPLOY_RAW = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8');

type Step = {
  uses?: string;
  with?: Record<string, unknown>;
  if?: string;
  id?: string;
  run?: string;
  name?: string;
};

const actionSteps = (ACTION.runs?.steps ?? []) as Step[];
const stepUsing = (steps: Step[], prefix: string): Step[] =>
  steps.filter((s) => typeof s.uses === 'string' && s.uses.startsWith(prefix));

/** `on:` viene letto da YAML come la chiave booleana `true`. */
const triggersOf = (doc: unknown): string[] => {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return [];
  const on = (d as { on?: unknown; true?: unknown }).on ?? (d as { true?: unknown }).true;
  if (!on) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on as Record<string, unknown>);
};

/** `cache: 'npm'` dentro un `with:` di setup-node, a qualunque profondità. */
const declaresNpmCache = (raw: string): boolean => {
  const doc = YAML.parse(raw) as unknown;
  let found = false;
  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    const uses = obj.uses;
    const wth = obj.with as Record<string, unknown> | undefined;
    if (typeof uses === 'string' && uses.startsWith('actions/setup-node@') && wth && wth.cache === 'npm') {
      found = true;
      return;
    }
    Object.values(obj).forEach(walk);
  };
  walk(doc);
  return found;
};

/** File locali (`uses: ./…`) raggiunti da un workflow, chiusura transitiva. */
const localDependencies = (file: string, seen = new Set<string>()): string[] => {
  if (seen.has(file) || !existsSync(file)) return [...seen];
  seen.add(file);
  const raw = readFileSync(file, 'utf-8');
  for (const m of raw.matchAll(/uses:\s*(\.\/[^\s'"]+)/g)) {
    const ref = m[1].replace(/^\.\//, '');
    // `uses: ./.github/actions/x` → action.yml nella directory.
    const candidates = /\.ya?ml$/.test(ref)
      ? [resolve(ROOT, ref)]
      : [resolve(ROOT, ref, 'action.yml'), resolve(ROOT, ref, 'action.yaml')];
    const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
    if (hit && hit !== file) localDependencies(hit, seen);
  }
  return [...seen];
};

describe('ci-npm-setup: la cache npm si salva solo su main', () => {
  it('setup-node non dichiara più `cache: npm` (il save per-ref nasceva da lì)', () => {
    const setupNode = stepUsing(actionSteps, 'actions/setup-node@');
    expect(setupNode, 'nessuno step actions/setup-node nella composite').not.toHaveLength(0);
    for (const step of setupNode) {
      expect(
        step.with?.cache,
        '`cache: npm` su setup-node salva la cache nello scope del ref corrente: su un ref di PR è un duplicato da ~487 MB',
      ).toBeUndefined();
    }
  });

  it('il restore gira SEMPRE (nessuna condizione di ref)', () => {
    const restores = stepUsing(actionSteps, 'actions/cache/restore@');
    expect(restores, 'la composite deve ripristinare la cache npm').toHaveLength(1);
    expect(
      restores[0].if,
      'il restore non va condizionato: una run di PR deve poter leggere la cache di main',
    ).toBeUndefined();
  });

  it('il save è condizionato a refs/heads/main', () => {
    const saves = stepUsing(actionSteps, 'actions/cache/save@');
    expect(saves, 'la composite deve avere esattamente uno step di save').toHaveLength(1);
    const cond = String(saves[0].if ?? '');
    expect(cond).toContain("github.ref == 'refs/heads/main'");
  });

  it('restore e save condividono chiave e path (una chiave sola, una copia sola)', () => {
    const [restore] = stepUsing(actionSteps, 'actions/cache/restore@');
    const [save] = stepUsing(actionSteps, 'actions/cache/save@');
    expect(restore.with?.key).toBe(save.with?.key);
    expect(restore.with?.path).toBe(save.with?.path);
    expect(String(restore.with?.key)).toContain('npm-cache-meta');
  });

  it('la chiave resta quella di setup-node: `node-cache-<OS>-<arch>-npm-<hash del lockfile>`', () => {
    // Le copie già scritte su `main` dagli altri workflow `cache: 'npm'` sono
    // raggiungibili solo se la chiave è composta allo stesso modo. `process.arch`
    // è minuscolo (`x64`), `runner.arch` no: va letto da node.
    expect(ACTION_RAW).toContain('node-cache-${RUNNER_OS}-${arch}-npm-${LOCK_HASH}');
    expect(ACTION_RAW).toContain("hashFiles('package-lock.json')");
    expect(ACTION_RAW).toContain("node -p 'process.arch'");
    // Il path è la cache GLOBALE di npm, non node_modules.
    expect(ACTION_RAW).toContain('npm config get cache');
  });

  it('nessuna restore-key di prefisso (setup-node non ne usa: riporterebbe un altro lockfile)', () => {
    const [restore] = stepUsing(actionSteps, 'actions/cache/restore@');
    expect(restore.with?.['restore-keys']).toBeUndefined();
  });
});

describe('classe: nessun percorso `pull_request` salva una cache npm per-ref', () => {
  const workflowFiles = readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(WORKFLOWS_DIR, f));

  it('ogni workflow su `pull_request`, composite incluse, è privo di `cache: npm`', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles) {
      const raw = readFileSync(file, 'utf-8');
      let doc: unknown;
      try {
        doc = YAML.parse(raw);
      } catch {
        continue; // la validità YAML è un altro gate (validate-modified-workflows)
      }
      if (!triggersOf(doc).some((t) => t === 'pull_request' || t === 'pull_request_target')) continue;
      for (const dep of localDependencies(file)) {
        if (declaresNpmCache(readFileSync(dep, 'utf-8'))) {
          offenders.push(`${file.slice(ROOT.length + 1)} → ${dep.slice(ROOT.length + 1)}`);
        }
      }
    }
    expect(
      offenders,
      'un `cache: npm` raggiunto da un evento pull_request scrive una copia della cache npm per ogni refs/pull/<n>/merge',
    ).toEqual([]);
  });
});

describe('deploy.yml: un manifest incrementale mancante è visibile', () => {
  const stashStep = (() => {
    const start = DEPLOY_RAW.indexOf('Stash previous incremental manifest before build overwrites it');
    expect(start, 'lo step di stash del manifest incrementale non esiste più').toBeGreaterThan(-1);
    const rest = DEPLOY_RAW.slice(start);
    const end = rest.indexOf('\n      - name:', 1);
    return end > -1 ? rest.slice(0, end) : rest;
  })();

  it('emette un `::warning::` quando il manifest precedente non c’è', () => {
    expect(stashStep).toContain('::warning title=Incremental manifest assente');
  });

  it('l’annotazione porta il locale e la chiave cercata', () => {
    expect(stashStep).toContain('MANIFEST_RESTORE_KEY: incremental-manifest-${{ matrix.locale }}-');
    expect(stashStep).toContain('${MANIFEST_LOCALE}');
    expect(stashStep).toContain('${MANIFEST_RESTORE_KEY}');
  });

  it('distingue «nessuna cache» da «cache ripristinata senza questo locale»', () => {
    expect(stashStep).toContain(
      'MANIFEST_MATCHED_KEY: ${{ steps.incremental-manifest-cache.outputs.cache-matched-key }}',
    );
    expect(stashStep).toContain('::warning title=Incremental manifest incompleto');
  });

  it('il warning è limitato alle run di main, dove il riuso è atteso', () => {
    expect(stashStep).toContain("MANIFEST_ON_MAIN: ${{ github.ref == 'refs/heads/main' }}");
    expect(stashStep).toContain('if [ "${MANIFEST_ON_MAIN}" = "true" ]; then');
  });

  // Stesso file, stessa cache evictabile, stesso difetto: lo stash del
  // content manifest IT alimenta `deploy-file-delta` e spariva in silenzio
  // esattamente come quello incrementale.
  const contentStashStep = (() => {
    const start = DEPLOY_RAW.indexOf('Stash previous content manifest before build overwrites it');
    expect(start, 'lo step di stash del content manifest non esiste più').toBeGreaterThan(-1);
    const rest = DEPLOY_RAW.slice(start);
    const end = rest.indexOf('\n      - name:', 1);
    return end > -1 ? rest.slice(0, end) : rest;
  })();

  it('anche il content manifest IT mancante produce un `::warning::` su main', () => {
    expect(contentStashStep).toContain('::warning title=Content manifest assente');
    expect(contentStashStep).toContain('CONTENT_MANIFEST_RESTORE_KEY: deploy-content-manifest-');
    expect(contentStashStep).toContain("CONTENT_MANIFEST_ON_MAIN: ${{ github.ref == 'refs/heads/main' }}");
    expect(contentStashStep).toContain('${CONTENT_MANIFEST_RESTORE_KEY}');
  });
});
