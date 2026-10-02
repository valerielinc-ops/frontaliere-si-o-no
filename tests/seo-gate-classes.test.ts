/**
 * Una sola classificazione dei gate SEO post-deploy (owner, 2026-10-02:
 * «quei tipi di check non sono opzionali»).
 *
 * Prima di questo file lo stesso gate aveva due modalità: cathedral-seo-gates-check
 * falliva e apriva una issue su ogni regressione di `max-bfs-depth`, mentre
 * validate-dist lo teneva in `QUALITY_GATES` e lasciava partire `publish`.
 * Qui si fissano:
 *   1. la classe e la modalità di OGNI gate, per nome — un cambio di modalità
 *      deve passare da questo file, cioè da una review esplicita;
 *   2. la coerenza fra i due posti: per ogni gate di cathedral la modalità che
 *      cathedral riporta è quella che validate-dist applica a `publish`;
 *   3. le regole che impediscono alla tabella di diventare un silenziatore:
 *      A e B citano una fonte, un override può solo rendere un gate PIÙ severo,
 *      ogni sotto-auditor di audit-all è classificato.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  CLASS_ISSUE_PRIORITY,
  CLASS_MODE,
  SEO_GATE_CLASSES,
  advisoryGateRationales,
  effectiveMode,
} from '../scripts/ci/lib/seo-gate-classes.mjs';
import {
  QUALITY_GATES,
  evaluateIntegrity,
} from '../scripts/ci/classify-validate-dist-failures.mjs';
import { GATES, gateClassification } from '../scripts/cathedral-seo-gates-check.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('classe e modalità di ogni gate (cambiarle è una decisione da review)', () => {
  it('fissa la tabella per nome', () => {
    const table = Object.fromEntries(
      Object.keys(SEO_GATE_CLASSES).map((key) => [key, `${SEO_GATE_CLASSES[key].class}/${effectiveMode(key)}`]),
    );
    expect(table).toEqual({
      // A — bloccante assoluto
      'gate:seo-source': 'A/blocking',
      'validate:jobposting-schema': 'A/blocking',
      'validate:sitemap-pages': 'A/blocking',
      'validate:sitemap-links': 'A/blocking',
      'audit:canonical-trailing-slash': 'A/blocking',
      'audit:news-sitemap': 'A/blocking',
      'audit:no-dotfile-html': 'A/blocking',
      'audit:spa-bundle-injection': 'A/blocking',
      'audit:all/footer-root-presence': 'A/blocking',
      'audit:all/jsonld-no-nested-scripts': 'A/blocking',
      'audit:all/image-object-license': 'A/blocking',
      // Evidenza C, resta bloccante finché il proprietario non decide (override).
      'audit:all/faqpage-validity': 'C/blocking',
      // B — bloccante sulla regressione (fino al 2026-10-01 erano QUALITY_GATES)
      'audit:max-bfs-depth': 'B/blocking-on-regression',
      'audit:orphan-sitemap-pages': 'B/blocking-on-regression',
      'audit:hreflang': 'B/blocking-on-regression',
      'audit:all/information-gain': 'B/blocking-on-regression',
      'audit:all/page-weight': 'B/blocking-on-regression',
      // C — advisory
      'audit:all/text-html-ratio': 'C/advisory',
      'audit:all/title-length': 'C/advisory',
      'audit:all/title-no-disambig-hash': 'C/advisory',
      'audit:all/h1-title-duplicates': 'C/advisory',
      'audit:all/single-h1-per-page': 'C/advisory',
      'audit:all/content-duplicates': 'C/advisory',
      'audit:all/duplicate-meta-description': 'C/advisory',
      'audit:all/duplicate-structured-data': 'C/advisory',
      'audit:all/link-anchor-text': 'C/advisory',
      'audit:all/breadcrumb-coverage': 'C/advisory',
      'audit:all/no-literal-markdown': 'C/advisory',
      'audit:all/salary-landing-template': 'C/advisory',
      'validate:jobs-quality': 'C/advisory',
      'dist:quality-tests': 'C/advisory',
    });
  });

  it('QUALITY_GATES di validate-dist è esattamente l\'insieme advisory della tabella', () => {
    expect(QUALITY_GATES).toEqual(advisoryGateRationales());
    for (const key of Object.keys(SEO_GATE_CLASSES)) {
      const advisory = effectiveMode(key) === 'advisory';
      expect(evaluateIntegrity([key]).integrityOk, `${key}: publish ${advisory ? 'procede' : 'sequestrato'}`)
        .toBe(advisory);
    }
  });

  it('un gate B blocca publish anche quando fallisce insieme a un C', () => {
    const v = evaluateIntegrity(['audit:all/text-html-ratio', 'audit:max-bfs-depth']);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['audit:max-bfs-depth']);
    expect(v.quality).toEqual(['audit:all/text-html-ratio']);
  });
});

describe('cathedral e validate-dist danno a ogni gate la stessa modalità', () => {
  it('ogni gate di cathedral dichiara una gateKey classificata', () => {
    for (const gate of GATES) {
      expect(SEO_GATE_CLASSES, `${gate.name} → ${gate.gateKey}`).toHaveProperty([gate.gateKey]);
      // La chiave è il nome che validate-dist scrive in failed_gates per lo
      // stesso audit: termina con il nome del gate di cathedral.
      expect(gate.gateKey.endsWith(gate.name), gate.name).toBe(true);
    }
  });

  it('la modalità riportata da cathedral è quella che validate-dist applica a publish', () => {
    for (const gate of GATES) {
      const c = gateClassification(gate);
      expect(c.mode).toBe(effectiveMode(gate.gateKey));
      expect(c.issuePriority).toBe(CLASS_ISSUE_PRIORITY[SEO_GATE_CLASSES[gate.gateKey].class]);
      expect(evaluateIntegrity([gate.gateKey]).integrityOk).toBe(c.mode === 'advisory');
    }
  });

  it('un gate di cathedral non classificato non può sembrare advisory', () => {
    const c = gateClassification({ ...GATES[0], gateKey: 'audit:all/not-in-the-table' });
    expect(c).toMatchObject({ class: '?', mode: 'blocking', issuePriority: 1 });
  });

  it('la issue di regressione prende la priorità dalla classe', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/cathedral-seo-gates-check.yml'), 'utf8');
    const failgate = wf.slice(wf.indexOf('- name: Open issue + fail workflow on regression'));
    expect(failgate).toContain(".issuePriority // 1'");
    expect(failgate).toContain('--priority "$priority"');
    expect(failgate).not.toMatch(/--label regression[\s\S]{0,40}--priority 2/);
  });
});

describe('la tabella non può diventare un silenziatore', () => {
  it('A e B citano almeno una fonte https; ogni gate ha una motivazione', () => {
    for (const [key, entry] of Object.entries(SEO_GATE_CLASSES)) {
      expect(entry.why.length, `${key} senza motivazione`).toBeGreaterThan(20);
      for (const url of entry.evidence) expect(url, key).toMatch(/^https:\/\//);
      if (entry.class !== 'C') expect(entry.evidence.length, `${key} (${entry.class}) senza fonte`).toBeGreaterThan(0);
    }
  });

  it('un override può solo rendere un gate più severo della sua classe', () => {
    const severity: Record<string, number> = { advisory: 0, 'blocking-on-regression': 1, blocking: 2 };
    for (const [key, entry] of Object.entries(SEO_GATE_CLASSES)) {
      if (!('modeOverride' in entry) || !entry.modeOverride) continue;
      expect(severity[entry.modeOverride.mode], key).toBeGreaterThan(severity[CLASS_MODE[entry.class]]);
      expect(entry.modeOverride.reason.length, key).toBeGreaterThan(20);
    }
  });

  it('ogni sotto-auditor registrato in audit-all è classificato', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/audit-all.mjs'), 'utf8');
    const block = src.slice(src.indexOf('const REGISTRY = ['), src.indexOf('];', src.indexOf('const REGISTRY = [')));
    const names = [...block.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(18);
    for (const name of names) {
      expect(SEO_GATE_CLASSES, `audit:all/${name} non classificato`).toHaveProperty([`audit:all/${name}`]);
    }
  });
});
