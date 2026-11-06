#!/usr/bin/env node
// POC / validation harness for the local Opus-MT translation tier.
//
// Downloads the real Opus-MT ONNX models (once, cached under .cache/transformers)
// and translates a handful of representative job snippets across the funnel's
// directions, printing output + wall-time per call. Run manually to spot-check
// quality and latency before relying on the tier — NOT part of vitest (which uses
// the injectable seam and never downloads models).
//
// Usage:
//   MT_LOCAL_OPUSMT=1 node scripts/poc-local-opus-mt.mjs
//   MT_LOCAL_OPUSMT=1 MT_LOCAL_OPUSMT_DTYPE=fp32 node scripts/poc-local-opus-mt.mjs

import { translateWithLocalOpusMt, localOpusMtEnabled } from './lib/local-opus-mt.mjs';

if (!localOpusMtEnabled()) {
  process.env.MT_LOCAL_OPUSMT = '1'; // self-enable so the POC always runs
}

const SAMPLES = [
  { src: 'it', text: 'Cerchiamo un infermiere qualificato per la nostra clinica di Lugano. Esperienza minima di due anni richiesta. Contratto a tempo indeterminato.' },
  { src: 'it', text: 'Assistente amministrativo con ottima conoscenza del tedesco e del francese. Stipendio competitivo e orario flessibile.' },
  { src: 'en', text: 'We are looking for a senior software engineer to join our team in Zurich. Remote work is possible two days per week.' },
  { src: 'de', text: 'Wir suchen einen erfahrenen Elektriker für Projekte im Tessin. Führerschein Kategorie B erforderlich.' },
];

const TARGETS = { it: ['en', 'de', 'fr'], en: ['it', 'de', 'fr'], de: ['it', 'en', 'fr'] };

function now() { return Number(process.hrtime.bigint() / 1000000n); }

async function main() {
  console.log(`[poc] local Opus-MT tier — dtype=${process.env.MT_LOCAL_OPUSMT_DTYPE || 'q8'}\n`);
  let ok = 0;
  let fail = 0;
  for (const { src, text } of SAMPLES) {
    console.log(`\n=== [${src}] ${text.slice(0, 70)}…`);
    for (const tgt of TARGETS[src]) {
      const t0 = now();
      let out = '';
      try {
        out = await translateWithLocalOpusMt(text, src, tgt);
      } catch (err) {
        out = '';
        console.log(`  ${src}→${tgt}  THREW: ${err?.message || err}`);
        fail++;
        continue;
      }
      const ms = now() - t0;
      if (out) {
        ok++;
        console.log(`  ${src}→${tgt}  (${ms}ms)  ${out.slice(0, 90)}`);
      } else {
        fail++;
        console.log(`  ${src}→${tgt}  (${ms}ms)  <EMPTY — tier returned ''>`);
      }
    }
  }
  console.log(`\n[poc] done — ${ok} translated, ${fail} empty/failed`);
  if (ok === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[poc] fatal:', err);
  process.exitCode = 1;
});
