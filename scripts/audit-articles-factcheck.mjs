#!/usr/bin/env node
/**
 * Batch LLM fact-check audit for all existing blog articles.
 * Uses GitHub Models (GPT-4.1-nano via GITHUB_TOKEN) for free, high-throughput verification.
 * Falls back to Gemini if GH Models unavailable.
 * 
 * Usage: node scripts/audit-articles-factcheck.mjs
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Get GitHub token from gh CLI
let GH_TOKEN;
try {
  GH_TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
} catch {
  console.error('❌ gh auth token failed — run "gh auth login" first');
  process.exit(1);
}

const BATCH_SIZE = 8; // articles per LLM call
const GH_MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const MODEL = 'openai/gpt-4.1-mini';
const CONCURRENCY = 3; // parallel batches

// Load all Italian article bodies
function loadArticles() {
  const dir = 'services/locales/blog-body/it';
  const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
  const articles = [];

  for (const file of files) {
    const id = file.replace(/\.ts$/, '');
    const content = readFileSync(join(dir, file), 'utf8');
    
    // Extract body1, body2, body3 text from the TS file
    const bodies = [];
    for (const key of ['body1', 'body2', 'body3']) {
      const pattern = new RegExp(`\\.${key}':\\s*'((?:[^'\\\\]|\\\\.)*)`, 's');
      const match = content.match(pattern);
      if (match) {
        bodies.push(match[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").slice(0, 1500));
      }
    }
    
    if (bodies.length > 0) {
      articles.push({ id, text: bodies.join('\n\n').slice(0, 3000) });
    }
  }
  return articles;
}

async function callLLM(prompt) {
  const resp = await fetch(GH_MODELS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GH_TOKEN}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  });
  
  if (!resp.ok) {
    const err = await resp.text();
    if (resp.status === 429) {
      // Rate limited — wait and retry
      const retryAfter = parseInt(resp.headers.get('retry-after') || '10');
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return callLLM(prompt); // retry once
    }
    throw new Error(`GH Models ${resp.status}: ${err.slice(0, 200)}`);
  }
  
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function auditBatch(batch, batchNum, totalBatches) {
  const articlesText = batch.map((a, i) => 
    `--- ARTICOLO ${i + 1}: ${a.id} ---\n${a.text}`
  ).join('\n\n');

  const prompt = `Sei un auditor specializzato in rilevamento di ALLUCINAZIONI AI in articoli su frontalieri svizzero-italiani.

COMPITO: Analizza questi ${batch.length} articoli e segnala SOLO quelli con ALLUCINAZIONI CERTE — informazioni che sei SICURO al 100% siano inventate dall'AI.

⚠️ ATTENZIONE: questi articoli sono basati su notizie reali. Date specifiche, cifre da comunicati stampa, e dettagli operativi di cantieri/progetti NON sono allucinazioni — provengono dalla fonte. NON segnalarli.

SEGNALA SOLO:
1. **LEGGI INESISTENTI**: Decreti, leggi con numeri specifici che NON ESISTONO (es. "D.Lgs 147/2015 sulla tassa salute" — NON esiste). NB: DPR 917/1986, D.Lgs 241/1997, DL 78/2010, D.Lgs 81/2008 ESISTONO.
2. **ISTITUZIONI INVENTATE**: Enti/commissioni/uffici che NON esistono. Acronimi inventati (CFL, UFOL, ONSLL, UBSP, CCFL, UFML). NB: SECO, SEM, SUVA, USTAT, BAG, SUPSI, INPS ESISTONO.
3. **FATTI NOTORIAMENTE FALSI**: "tassa sulla salute del 10%", "Convenzione del 9 marzo 1976" (è 3 ottobre 1974), Ticino descritto come "regione d'Italia" (è un cantone svizzero).
4. **EVENTI MAI AVVENUTI**: Referendum, votazioni, conferenze, proteste che sicuramente non sono mai avvenuti e NON possono provenire da una fonte giornalistica.
5. **CONTRADDIZIONI GEOGRAFICHE**: Città svizzere in Italia o viceversa, confini sbagliati, istituzioni attribuite al paese sbagliato.

NON SEGNALARE:
- Date specifiche di cantieri, interventi, scadenze (vengono dalla fonte)
- Prezzi, tariffe, costi operativi (vengono dalla fonte)
- Statistiche con fonte citata (provengono da comunicati)
- Informazioni che non puoi verificare con certezza

ARTICOLI:
${articlesText}

Rispondi SOLO con JSON array. Includi SOLO articoli con problemi CERTI:
[{"id":"article-id","verdict":"FAIL","issues":[{"claim":"testo","reason":"perché è falso","severity":"critical"}]}]
Array vuoto se tutti OK: []`;

  try {
    console.error(`  📋 Batch ${batchNum}/${totalBatches} (${batch.length} articoli)...`);
    const raw = await callLLM(prompt);
    
    // Extract JSON array
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    
    try {
      const results = JSON.parse(jsonMatch[0]);
      return Array.isArray(results) ? results : [];
    } catch {
      console.error(`  ⚠️  Batch ${batchNum}: JSON parse error`);
      return [];
    }
  } catch (err) {
    console.error(`  ❌ Batch ${batchNum}: ${err.message}`);
    return [];
  }
}

async function main() {
  console.error('🔍 Loading all Italian blog articles...');
  const articles = loadArticles();
  console.error(`📊 Found ${articles.length} articles\n`);

  const allIssues = [];
  const totalBatches = Math.ceil(articles.length / BATCH_SIZE);
  let completed = 0;

  // Process batches with concurrency
  const batches = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const promises = chunk.map((batch, j) => 
      auditBatch(batch, i + j + 1, totalBatches)
    );
    
    const results = await Promise.all(promises);
    for (const batchResults of results) {
      for (const result of batchResults) {
        if (result.verdict === 'FAIL' && result.issues?.length > 0) {
          allIssues.push(result);
          console.error(`  🚨 ${result.id}: ${result.issues.length} problemi`);
          for (const issue of result.issues) {
            console.error(`     ${issue.severity === 'critical' ? '🚨' : '⚠️'} "${(issue.claim || '').slice(0, 80)}" — ${(issue.reason || '').slice(0, 100)}`);
          }
        }
      }
    }
    completed += chunk.length;
    
    // Small delay between concurrent chunks
    if (i + CONCURRENCY < batches.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.error(`\n${'='.repeat(60)}`);
  console.error(`📊 RISULTATI AUDIT: ${allIssues.length} articoli con problemi su ${articles.length} totali`);
  
  if (allIssues.length > 0) {
    console.error('\n🚨 ARTICOLI CON PROBLEMI:');
    for (const a of allIssues) {
      console.error(`\n  📰 ${a.id}:`);
      for (const issue of a.issues) {
        console.error(`     ${issue.severity === 'critical' ? '🚨' : '⚠️'} [${issue.severity}] ${issue.claim?.slice(0, 100)}`);
        console.error(`        → ${issue.reason?.slice(0, 150)}`);
      }
    }
  }

  // Write JSON report
  const report = {
    timestamp: new Date().toISOString(),
    totalArticles: articles.length,
    articlesWithIssues: allIssues.length,
    issues: allIssues,
  };
  writeFileSync('/tmp/article-audit-report.json', JSON.stringify(report, null, 2));
  console.error(`\n📄 Report salvato in /tmp/article-audit-report.json`);
}

main().catch(err => {
  console.error(`❌ Fatal: ${err.message}`);
  process.exit(1);
});
