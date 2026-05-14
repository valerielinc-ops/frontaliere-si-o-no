/**
 * Tests for the pre-spend topic gate in scripts/create-article.mjs.
 *
 * 2026-05-15 incident (run 25878332289): REGOLA #0 (the frontaliere-angle
 * gate inside the article-gen prompt) was correctly aborting off-topic
 * news (cronaca nera, abbandono rifiuti), but only AFTER paying ~5-7k
 * tokens per headline on full article generation. Pattern in the log:
 *
 *   Tentativo 1 fallito: JSON non valido
 *   Tentativo 2 fallito: Topic-gate abort: smaltimento illecito rifiuti
 *   Tentativo 3 fallito: Topic-gate abort: abbandono rifiuti a Cantello
 *   Tentativo 4 fallito: Topic-gate abort: caso di abbandono rifiuti
 *   Tentativo 5 fallito: All AI models failed (quote esauste)
 *
 * Fix: a cheap pre-spend gate (anchor-regex fast-path + tiny-LLM
 * classifier) fires BEFORE the Tentativo loop, so off-topic headlines
 * never reach the expensive article-gen call.
 *
 * The tests here validate:
 *   1) the anchor-regex list contains the high-precision frontaliere
 *      tokens and rejects cronaca-nera fixtures (behavioural);
 *   2) the gate is wired into main() between the post-topic-filter and
 *      the quotaPools build (source-parse: importing the .mjs is unsafe
 *      because main() runs at top level);
 *   3) the gate honours the rollback env gate (PRESPEND_TOPIC_GATE=0);
 *   4) the gate fails OPEN — if the classifier itself errors, we DO NOT
 *      drop the headline (defense-in-depth: REGOLA #0 still catches it);
 *   5) REGOLA #0 stays in the article-gen prompt as defense-in-depth.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FRONTALIERE_STRICT_ANCHORS,
  matchesFrontaliereAnchor,
} from '../scripts/lib/discovery/frontaliereAnchor.mjs';

const SRC = readFileSync(
  resolve(__dirname, '..', 'scripts/create-article.mjs'),
  'utf8',
);

describe('pre-spend topic gate — anchor regex list (behavioural)', () => {
  it('exports a non-trivial number of anchor regexes', () => {
    expect(FRONTALIERE_STRICT_ANCHORS.length).toBeGreaterThanOrEqual(15);
    for (const re of FRONTALIERE_STRICT_ANCHORS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });

  it('matches frontaliere-specific headlines (high-precision accept path)', () => {
    const positives = [
      'Tassa salute frontalieri: blocco ristorni, cosa cambia nel 2026',
      'Permesso G, nuovo accordo fiscale: ecco cosa cambia in busta paga',
      'Imposta alla fonte: la circolare AFC chiarisce il calcolo per i pendolari',
      'Ristorni ai comuni italiani di confine, possibile sblocco a giugno',
      'LAMal 2026, premi in aumento del 6% in Ticino',
      'Cambio CHF-EUR sotto pressione: cosa significa per i frontalieri',
      'Telelavoro frontalieri: il nuovo limite del 25% spiegato',
      'Dogana di Chiasso, lunghe code per i pendolari al mattino',
      'Mercato del lavoro ticinese: 12.000 posti aperti per frontalieri',
      'Cassa malati: i premi LAMal salgono nel Cantone Ticino',
      'Doppia imposizione, chiarimenti per i lavoratori transfrontalieri',
    ];
    for (const h of positives) {
      const m = matchesFrontaliereAnchor(h);
      expect(m, `should match: ${h}`).not.toBeNull();
    }
  });

  it('does NOT match off-topic cronaca / sport / unrelated news', () => {
    // These mirror the exact pattern of headlines that caused run
    // #25878332289 to burn 5 article-gen attempts on REGOLA #0 aborts.
    const negatives = [
      'Rifiuti svizzeri abbandonati a Cantello, multata una società',
      'Smaltimento illecito di rifiuti a Cantello, indagini in corso',
      'Abbandono rifiuti a Cantello: il sindaco minaccia denunce',
      'Risotto bronzo nazionale a Gallarate, sfilata dei cuochi',
      'Chiesetta ortodossa macedone a Locarno, inaugurazione domenica',
      'Festival del cinema di Locarno: il programma di chiusura',
      'Asilo nido di Sesto Calende, nuova convenzione comunale',
      'Pala di sci a Sankt Moritz, gara annullata per maltempo',
    ];
    for (const h of negatives) {
      const m = matchesFrontaliereAnchor(h);
      expect(m, `should NOT match (off-topic): ${h}`).toBeNull();
    }
  });

  it('matchesFrontaliereAnchor handles null/empty input safely', () => {
    expect(matchesFrontaliereAnchor('')).toBeNull();
    expect(matchesFrontaliereAnchor(null as unknown as string)).toBeNull();
    expect(matchesFrontaliereAnchor(undefined as unknown as string)).toBeNull();
  });
});

describe('pre-spend topic gate — wiring into main()', () => {
  it('declares the gate function applyPreSpendTopicGate', () => {
    expect(SRC).toMatch(/async\s+function\s+applyPreSpendTopicGate\s*\(/);
  });

  it('imports the anchor helper from the dedicated module', () => {
    expect(SRC).toMatch(/from\s+'\.\/lib\/discovery\/frontaliereAnchor\.mjs'/);
  });

  it('invokes the gate BEFORE quotaPools/article-generation', () => {
    // The gate must run between the post-topic-filter and the build of
    // quotaPools (which feeds the Tentativo loop). If the order ever
    // gets reversed, REGOLA #0 aborts will start burning tokens again.
    const idxPreSpendCall = SRC.indexOf('headlines = await applyPreSpendTopicGate(headlines)');
    const idxQuotaPoolsBuild = SRC.indexOf('const quotaPools = buildSourceQuotaPools(headlines);');
    expect(idxPreSpendCall, 'gate call not found in main()').toBeGreaterThan(0);
    expect(idxQuotaPoolsBuild, 'quotaPools build not found in main()').toBeGreaterThan(0);
    expect(idxPreSpendCall).toBeLessThan(idxQuotaPoolsBuild);
  });

  it('honors the PRESPEND_TOPIC_GATE=0 rollback env gate', () => {
    expect(SRC).toMatch(/process\.env\.PRESPEND_TOPIC_GATE\s*\?\?\s*'1'/);
  });

  it('memoises classifier results per-run', () => {
    expect(SRC).toMatch(/_preSpendGateCache\s*=\s*new Map\(\)/);
    expect(SRC).toMatch(/_preSpendGateCache\.has\(cacheKey\)/);
    expect(SRC).toMatch(/_preSpendGateCache\.set\(cacheKey,/);
  });

  it('uses a cheap classifier model by default (no full GPT-4o burn)', () => {
    expect(SRC).toMatch(/AI_MODELS\.GEMINI_FLASH_LITE/);
    // The classifier call must NOT use jsonMode (avoids schema-mode bugs).
    const classifierBlock = SRC.match(
      /async function classifyFrontaliereRelevance[\s\S]*?\n\}\n/,
    );
    expect(classifierBlock, 'classifyFrontaliereRelevance block not found').toBeTruthy();
    expect(classifierBlock![0]).toMatch(/jsonMode:\s*false/);
    expect(classifierBlock![0]).toMatch(/maxTokens:\s*8[0-9]/);
  });

  it('fails OPEN on classifier error (keeps the headline)', () => {
    // If the classifier itself errors (network/quota/parse), we MUST NOT
    // drop the headline silently — REGOLA #0 stays as defense-in-depth.
    const classifierBlock = SRC.match(
      /async function classifyFrontaliereRelevance[\s\S]*?\n\}\n/,
    )![0];
    expect(classifierBlock).toMatch(/relevant:\s*true[\s\S]*classifier-error/);
  });

  it('keeps REGOLA #0 in the article-gen prompt as defense-in-depth', () => {
    // The whole point of the pre-spend gate is that it complements
    // REGOLA #0 — it does NOT replace it. If REGOLA #0 ever gets removed
    // by accident, this test catches it.
    expect(SRC).toMatch(/REGOLA #0 — GATE DI RILEVANZA TOPICA/);
    expect(SRC).toMatch(/abort_topical_relevance/);
  });
});
