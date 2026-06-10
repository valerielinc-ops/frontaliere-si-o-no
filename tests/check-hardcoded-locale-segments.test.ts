/**
 * Lock test per il guard zero-Claude `scripts/ci/check-hardcoded-locale-segments.mjs`
 * (escalation lessons-harvester #1529, reviewer-finding/i18n-naming).
 *
 * Verifica:
 *  1. il predicato di rilevamento flagga l'antipattern reale (`${base}/de/job/...`)
 *     e NON i casi legittimi (prosa, branch per-locale, allowlist inline);
 *  2. l'albero corrente è PULITO contro la baseline committata (nessuna nuova
 *     violazione) — così la baseline non drifta e una nuova violazione fa rosso.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineHasViolation, collect } from '../scripts/ci/check-hardcoded-locale-segments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-hardcoded-locale-segments.mjs');

describe('check-hardcoded-locale-segments — detection predicate', () => {
  it('flagga il segmento lingua hardcoded in URL costruita dinamicamente', () => {
    // il bug esatto di #1498
    expect(lineHasViolation('const url = `${base}/de/job/${hash}`;')).toBe(true);
    expect(lineHasViolation('return `https://${host}/fr/emplois/${id}`;')).toBe(true);
    expect(lineHasViolation('href = `/it/jobs/${slug}`;')).toBe(true);
    expect(lineHasViolation('const u = `${BASE_URL}/en/find-jobs/${city}`;')).toBe(true);
  });

  it('NON flagga le costruzioni che usano la variabile locale', () => {
    expect(lineHasViolation('const url = `${base}/${locale}/job/${hash}`;')).toBe(false);
    expect(lineHasViolation('href = `/${locale}/jobs/${perLocaleSlug[locale]}`;')).toBe(false);
  });

  it('NON flagga prosa / log / testo naturale con /de/ incidentale', () => {
    expect(lineHasViolation('console.log(`Locale checks: ${n} (it/en/de/fr)`);')).toBe(false);
    expect(lineHasViolation('const msg = `Combine it/de filters with ${x} options`;')).toBe(false);
  });

  it('NON flagga una stringa statica senza interpolazione (nessuna costruzione dinamica)', () => {
    // un literal statico viene gestito altrove (portali esterni) — il guard mira
    // alle URL DINAMICHE per-locale, dove la variabile locale è il fix atteso.
    expect(lineHasViolation("const u = 'https://careers.example.com/en/vacancies/';")).toBe(false);
  });

  it('rispetta l\'allowlist inline `// locale-segment-ok:` sulla riga o precedente', () => {
    const line = 'const url = `${base}/de/job/${hash}`; // locale-segment-ok: portale solo-DE';
    expect(lineHasViolation(line)).toBe(false);
    const target = 'const url = `${base}/de/job/${hash}`;';
    expect(lineHasViolation(target, '// locale-segment-ok: legacy portal fixed at /de/')).toBe(false);
  });
});

describe('check-hardcoded-locale-segments — gate sull\'albero corrente', () => {
  it('non introduce nuove violazioni rispetto alla baseline (gate exit 0)', () => {
    // Se questo test fallisce: hai hardcodato un segmento lingua in una URL
    // dinamica. Usa `${locale}` / `perLocaleSlug[locale]`, oppure annota con
    // `// locale-segment-ok: <motivo>` se davvero legittimo.
    let exitCode = 0;
    try {
      execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' });
    } catch (e: any) {
      exitCode = typeof e.status === 'number' ? e.status : 1;
      // espone l'elenco delle violazioni nel messaggio di fallimento
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      expect(out, out).toBe('');
    }
    expect(exitCode).toBe(0);
  });

  it('la baseline copre solo occorrenze realmente presenti (collect è deterministico)', () => {
    const findings = collect();
    expect(Array.isArray(findings)).toBe(true);
    // determinismo: due chiamate identiche
    expect(collect()).toEqual(findings);
  });
});
