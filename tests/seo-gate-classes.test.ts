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
  MODE_ISSUE_PRIORITY,
  SEO_GATE_CLASSES,
  effectiveMode,
  isPublishBlocking,
  publishNonBlockingGateRationales,
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
      // B — issue P2 sulla regressione, publish non bloccato (owner 2026-10-02)
      'audit:max-bfs-depth': 'B/issue-on-regression',
      'audit:orphan-sitemap-pages': 'B/issue-on-regression',
      'audit:hreflang': 'B/issue-on-regression',
      'audit:all/information-gain': 'B/issue-on-regression',
      'audit:all/page-weight': 'B/issue-on-regression',
      // C — advisory (faqpage-validity declassato da A il 2026-10-02)
      'audit:all/faqpage-validity': 'C/advisory',
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

  it('QUALITY_GATES di validate-dist è esattamente l\'insieme non bloccante (B e C)', () => {
    expect(QUALITY_GATES).toEqual(publishNonBlockingGateRationales());
    for (const key of Object.keys(SEO_GATE_CLASSES)) {
      const blocking = SEO_GATE_CLASSES[key].class === 'A';
      expect(isPublishBlocking(key), key).toBe(blocking);
      expect(evaluateIntegrity([key]).integrityOk, `${key}: publish ${blocking ? 'sequestrato' : 'procede'}`)
        .toBe(!blocking);
    }
  });

  it('decisione del proprietario: nessun gate B o C blocca, nemmeno insieme', () => {
    const nonBlocking = Object.keys(SEO_GATE_CLASSES).filter((k) => SEO_GATE_CLASSES[k].class !== 'A');
    expect(nonBlocking.length).toBe(20);
    const v = evaluateIntegrity(nonBlocking);
    expect(v.integrityOk).toBe(true);
    expect(v.blocking).toEqual([]);
  });

  it('i gate A che già bloccavano restano bloccanti', () => {
    const v = evaluateIntegrity(['audit:all/text-html-ratio', 'audit:max-bfs-depth', 'gate:seo-source']);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['gate:seo-source']);
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
      expect(c.issuePriority).toBe(MODE_ISSUE_PRIORITY[c.mode as keyof typeof MODE_ISSUE_PRIORITY]);
      expect(evaluateIntegrity([gate.gateKey]).integrityOk).toBe(c.mode !== 'blocking');
    }
  });

  it('un gate di cathedral non classificato non può sembrare advisory', () => {
    const c = gateClassification({ ...GATES[0], gateKey: 'audit:all/not-in-the-table' });
    expect(c).toMatchObject({ class: '?', mode: 'blocking', issuePriority: 1 });
  });

  it('la issue di regressione prende la priorità dalla modalità (A=1, B=2, C=3)', () => {
    expect(MODE_ISSUE_PRIORITY).toEqual({ blocking: 1, 'issue-on-regression': 2, advisory: 3 });
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
