#!/usr/bin/env node
/**
 * Eval harness — issue #3656 (local LLM for the amplificazione/rewrite step)
 *
 * Measures wall-clock + fact-check pass rate for candidate local Ollama
 * models on a REWRITE-ONLY task (paraphrase/expand an existing article body
 * back toward its original length, adding ZERO new facts), using real
 * production article samples and the real blocking `llmFactCheck` gate
 * (re-exported from create-article.mjs for this purpose).
 *
 * Prior attempt (documented in issue #3090, GH run 28371401498): qwen2.5:7b
 * via the *expansion* prompt that asks the model to ADD new concrete
 * examples/dates/amounts — too slow (>55min budget) AND hallucinated tax law.
 * This eval deliberately narrows the task to pure rewrite (owner's stated
 * fix per #3656) and tests smaller/faster models.
 *
 * Usage:
 *   node scripts/eval-local-rewrite-llm.mjs [--models=qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b] [--samples=5]
 *
 * Requires: `ollama serve` running locally with the candidate models pulled,
 * and GEMINI_API_KEY set (only verifier model available without a
 * GH_MODELS_PAT in this environment — llmFactCheck degrades gracefully to
 * single-model consensus, same as a GitHub Models outage in production).
 */
import fs from 'node:fs';
import path from 'node:path';
import { callLLM, AI_MODELS, flushScoresBeforeExit } from './lib/ai-models.mjs';
import { llmFactCheck } from './create-article.mjs';

const SAMPLE_DIR = 'services/locales/blog-body/it';
// Diverse real published articles incl. one squarely in the domain that
// hallucinated last time (frontaliere tax law: 730-precompilato).
const SAMPLE_FILES = [
  '730-precompilato-frontalieri-ticino-2026.ts',       // frontaliere tax (prior failure domain)
  'accordi-svizzera-ue-parmelin-bruxelles.ts',          // national/EU relations
  'assicurazione-dentaria-obbligatoria-ticino-2026.ts', // health insurance/law
  'autostrada-a9-disagi-frontalieri.ts',                // infrastructure/frontaliere
  'adulti-genitori-sostegno-finanziario-ticino-2026.ts',// social/financial support
];

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const MODELS = (args.models || 'qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b').split(',');
const N_SAMPLES = Number(args.samples || SAMPLE_FILES.length);

function extractField(txt, field) {
  const re = new RegExp(`'blog\\.article\\.[^']*\\.${field}'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`);
  const m = txt.match(re);
  if (!m) return null;
  return m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'");
}
function wc(s) { return (s || '').split(/\s+/).filter(Boolean).length; }

// Truncate at a paragraph boundary to ~targetRatio of the original, so the
// "draft" looks like a real too-short article body, not a mid-sentence cut.
function truncateToRatio(text, targetRatio) {
  const paras = text.split(/\n\n+/);
  const targetWords = Math.round(wc(text) * targetRatio);
  let out = [];
  let acc = 0;
  for (const p of paras) {
    if (acc >= targetWords && out.length > 0) break;
    out.push(p);
    acc += wc(p);
  }
  return out.join('\n\n');
}

// Number/date/currency tokens — the concrete "facts" a pure-rewrite must not
// invent. Deliberately broad (catches CHF amounts, %, years, plain numbers).
function extractFactTokens(text) {
  const tokens = new Set();
  const re = /(?:CHF\s?[\d'.,]+|\d+[.,]?\d*\s?%|\b(?:19|20)\d{2}\b|\bart\.\s?\d+[a-z]?\b|\b\d+[.,]\d+\b|\b\d{2,}\b)/gi;
  let m;
  while ((m = re.exec(text)) !== null) tokens.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  return tokens;
}

function buildRewritePrompt(currentText, currentWords, targetWords) {
  return `Sei un editor che RISCRIVE un testo giornalistico italiano SENZA aggiungere alcun fatto, numero, data, nome o cifra nuovi.

TESTO DA RISCRIVERE (${currentWords} parole):
"""
${currentText}
"""

REGOLE FERREE:
1. Riformula le frasi con parole diverse, MA ogni numero/data/nome/cifra/percentuale DEVE comparire ESATTAMENTE come nel testo sopra (stessi valori — nessuna aggiunta, nessuna modifica, nessun arrotondamento diverso).
2. NON introdurre nessun fatto, esempio, statistica, legge, istituzione, citazione o nome che non sia GIA' presente nel testo sopra.
3. Puoi allungare le frasi con connettivi, spiegazioni, riformulazioni, transizioni, sinonimi — SOLO se non aggiungono informazione nuova.
4. Obiettivo lunghezza: circa ${targetWords} parole.
5. Mantieni la formattazione Markdown esistente (titoli, elenchi, tabelle) e la lingua italiana.

Rispondi SOLO col testo riscritto, nessun commento, nessuna premessa.`;
}

async function callLocalOllama(model, prompt) {
  process.env.LOCAL_LLM_ENABLED = '1';
  process.env.LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://127.0.0.1:11434/v1/chat/completions';
  process.env.LOCAL_LLM_MODEL = model;
  process.env.LOCAL_LLM_TIMEOUT_MS = String(15 * 60_000); // 15min ceiling per call for this eval
  const t0 = Date.now();
  // NOTE: reuses the REAL production call shape verbatim (_callOpenAICompatible
  // builds a fixed { model, messages, temperature, max_tokens } body — no
  // pass-through for Ollama-specific fields like `options.num_gpu`), so a
  // --cpu-only flag can't be wired through this path with production fidelity.
  // This sandbox's Ollama runs Metal-accelerated (Apple Silicon); the
  // self-hosted runner in docs/SELFHOSTED-RUNNER.md is CPU-only — see the
  // GPU-vs-CPU caveat in the written eval before treating these numbers as
  // representative of prod wall-clock.
  const text = await callLLM(
    [{ role: 'user', content: prompt }],
    {
      model: AI_MODELS.LOCAL_FALLBACK,
      // Pin the chain to ONLY the local model — without this, a local
      // timeout/error would silently fall through to a remote model later
      // in DEFAULT_CHAIN, which would corrupt this eval's wall-clock/verdict
      // attribution (looking like a fast local pass when a remote model
      // actually answered).
      chain: [AI_MODELS.LOCAL_FALLBACK],
      temperature: 0.4,
      maxTokens: 3000,
    },
  );
  const elapsedMs = Date.now() - t0;
  // Unset immediately — llmFactCheck() runs its own callLLM() cascade right
  // after this, and LOCAL_LLM_ENABLED must not leak into that call (its
  // internal guard already refuses local-self-verification, but this keeps
  // the fact-check cascade on remote models by construction, not by relying
  // on that guard as the only line of defense).
  delete process.env.LOCAL_LLM_ENABLED;
  return { text, elapsedMs };
}

async function main() {
  console.log(`Models: ${MODELS.join(', ')} | Samples: ${N_SAMPLES}\n`);
  const results = [];

  const files = SAMPLE_FILES.slice(0, N_SAMPLES);
  for (const file of files) {
    const slug = file.replace(/\.ts$/, '');
    const txt = fs.readFileSync(path.join(SAMPLE_DIR, file), 'utf8');
    const body1 = extractField(txt, 'body1');
    if (!body1) { console.warn(`  skip ${file}: no body1 found`); continue; }
    const originalWords = wc(body1);
    const truncated = truncateToRatio(body1, 0.58);
    const truncatedWords = wc(truncated);
    const targetWords = originalWords; // expand back toward original length

    console.log(`=== ${slug} (${originalWords}w → truncated ${truncatedWords}w, target ${targetWords}w) ===`);
    const prompt = buildRewritePrompt(truncated, truncatedWords, targetWords);
    const inputFactTokens = extractFactTokens(truncated);

    // CONTROL: run the fact-check gate on the truncated input verbatim (zero
    // rewriting), to separate "checker is inherently strict on this domain
    // (e.g. specific future dates outside its verified-facts baseline)" from
    // "the candidate model introduced a new hallucination." Without this,
    // a FAIL on tax-law content could be wrongly blamed on the local model
    // when the same source text would also fail through the identical gate.
    let controlFactCheck = null;
    try {
      const contentIt = { title: slug, excerpt: '', body1: truncated, body2: '', body3: '' };
      controlFactCheck = await llmFactCheck(contentIt, truncated, `https://frontaliereticino.ch/blog/${slug}/`);
    } catch (e) {
      controlFactCheck = { error: e.message };
    }
    const controlLabel = controlFactCheck?.error
      ? `ERROR: ${controlFactCheck.error}`
      : controlFactCheck?.unverified ? 'UNVERIFIED' : controlFactCheck?.passed === true ? 'PASS' : 'FAIL';
    console.log(`  [CONTROL: unmodified truncated input] fact-check: ${controlLabel}${controlFactCheck?.issues?.length ? ` (${controlFactCheck.issues.length} issue(s))` : ''}`);
    results.push({
      slug, model: '__CONTROL_UNMODIFIED__', elapsedMs: null,
      factCheckVerdict: controlLabel, factCheckPassed: controlFactCheck?.passed ?? null,
      factCheckUnverified: !!controlFactCheck?.unverified, factCheckIssues: controlFactCheck?.issues ?? [],
    });

    for (const model of MODELS) {
      process.stdout.write(`  [${model}] generating... `);
      let text, elapsedMs, error;
      try {
        ({ text, elapsedMs } = await callLocalOllama(model, prompt));
      } catch (e) {
        error = e.message;
        console.log(`FAILED (${(Date.now())}): ${error}`);
        results.push({ slug, model, error, elapsedMs: null });
        continue;
      }
      const outWords = wc(text);
      const outFactTokens = extractFactTokens(text);
      const newTokens = [...outFactTokens].filter(t => !inputFactTokens.has(t));
      console.log(`${(elapsedMs / 1000).toFixed(1)}s, ${outWords}w, ${newTokens.length} new-fact-token(s)`);
      if (newTokens.length > 0) console.log(`    new tokens: ${newTokens.slice(0, 10).join(', ')}`);

      let factCheck = null;
      try {
        const contentIt = { title: slug, excerpt: '', body1: text, body2: '', body3: '' };
        factCheck = await llmFactCheck(contentIt, truncated, `https://frontaliereticino.ch/blog/${slug}/`);
      } catch (e) {
        factCheck = { error: e.message };
      }

      // Real return shape is { passed: boolean, issues: [...], unverified?: boolean }
      // (NOT { verdict, issues } — that shape is per-model, internal to
      // _runSingleFactCheck). See scripts/create-article.mjs:3102/3112/3127/3135/3144.
      const verdictLabel = factCheck?.error
        ? `ERROR: ${factCheck.error}`
        : factCheck?.unverified
          ? 'UNVERIFIED (infra outage, treated as pass per prod behavior)'
          : factCheck?.passed === true ? 'PASS' : factCheck?.passed === false ? 'FAIL' : 'unknown';
      console.log(`    fact-check: ${verdictLabel}${factCheck?.issues?.length ? ` (${factCheck.issues.length} issue(s))` : ''}`);

      results.push({
        slug, model, elapsedMs, outWords, targetWords, truncatedWords, originalWords,
        newFactTokenCount: newTokens.length, newFactTokens: newTokens,
        factCheckVerdict: verdictLabel,
        factCheckPassed: factCheck?.passed ?? null,
        factCheckUnverified: !!factCheck?.unverified,
        factCheckIssues: factCheck?.issues ?? [],
      });
    }
    console.log('');
  }

  const outPath = `/tmp/eval-local-rewrite-llm-results-${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${outPath}`);

  // Summary table
  console.log('\n=== SUMMARY ===');
  const controlRows = results.filter(r => r.model === '__CONTROL_UNMODIFIED__');
  const controlPass = controlRows.filter(r => r.factCheckPassed === true).length;
  console.log(`[CONTROL: unmodified truncated input, zero rewriting] fact-check ${controlPass}/${controlRows.length} PASS`);
  console.log('(any FAIL here = checker is inherently strict on that sample regardless of model — discount matching model FAILs accordingly)\n');

  const byModel = {};
  for (const r of results) {
    if (r.model === '__CONTROL_UNMODIFIED__') continue;
    if (!byModel[r.model]) byModel[r.model] = { n: 0, totalMs: 0, pass: 0, fail: 0, newFacts: 0, errors: 0 };
    const b = byModel[r.model];
    b.n++;
    if (r.error) { b.errors++; continue; }
    b.totalMs += r.elapsedMs;
    b.newFacts += r.newFactTokenCount;
    if (r.factCheckPassed === true) b.pass++;
    else b.fail++;
  }
  for (const [model, b] of Object.entries(byModel)) {
    const avgS = b.n > b.errors ? (b.totalMs / (b.n - b.errors) / 1000).toFixed(1) : 'n/a';
    console.log(`${model}: avg ${avgS}s/call | fact-check ${b.pass}/${b.n - b.errors} PASS | ${b.newFacts} total new-fact-tokens across samples | ${b.errors} errors`);
  }
}

main().catch(async (e) => {
  // `process.exit()` salta `beforeExit`: senza questa attesa il ramo di
  // errore butta via gli esiti dei modelli accumulati dalla run — per lo
  // piu' fallimenti, cioe' il segnale che serve al ledger. Bounded e
  // non-throwing (vedi flushScoresBeforeExit).
  await flushScoresBeforeExit();
  console.error(e);
  process.exit(1);
});
