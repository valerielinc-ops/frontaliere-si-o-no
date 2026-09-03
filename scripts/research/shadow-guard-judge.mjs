#!/usr/bin/env node
/**
 * shadow-guard-judge.mjs — PHASE 1, READ-ONLY. The direction question: for every
 * field the language-aware guard would newly WRITE, is the candidate BETTER or
 * WORSE than the text already stored?
 *
 * The earlier judge (argos-reject-audit --judge) asked "was the rejection
 * right?", which conflates "is the candidate usable" with "is it an
 * improvement". This one asks the A/B directly and states the criterion in the
 * prompt, so the verdict is auditable.
 *
 * $0: claude -p on the subscription OAuth token, same as the audit's judge.
 *
 * usage: shadow-guard-judge.mjs <shadow.json> --out <judged.json> [--batch 40]
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const inPath = args[0];
const outPath = opt('--out', inPath.replace(/\.json$/, '-judged.json'));
const batchSize = Number(opt('--batch', 40));

const shadow = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const cases = shadow.changed;

const PROMPT = `You are auditing a proposed change to a machine-translation write gate on a Swiss cross-border job board.
Today the gate keeps EXISTING and throws the CANDIDATE away. The proposed gate would overwrite EXISTING with CANDIDATE.
For each numbered case you get SOURCE (with its language), the TARGET language, EXISTING (what is stored in the target slot today) and CANDIDATE (what the pipeline produced and discarded).

CRITERION, apply it in this order:
1. LANGUAGE: is the text in the TARGET language? A text still in the source language, or a mix, is worse than one that is not, whatever else is true of it.
2. MEANING: does it preserve the meaning of SOURCE? A fluent target-language text that says something else (wrong job, inverted sense, dropped qualifier) is worse than a clumsy one that is right.
3. USABILITY as a job-board title: no leftover gender codes, no truncation mid-word, no untranslated compound halves.

Verdict is about the SWAP, not about absolute quality:
"better"  = replacing EXISTING with CANDIDATE improves the slot.
"worse"   = replacing it degrades the slot. Keep EXISTING.
"equal"   = both are the same quality; the swap is churn with no gain.
"unclear" = you genuinely cannot tell.

Answer with one JSON object per line, no prose, no markdown fence:
{"n":<case number>,"verdict":"better"|"worse"|"equal"|"unclear","why":"<one short sentence>"}`;

const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + ' […]' : String(s || ''));

const verdicts = new Map();
for (let start = 0; start < cases.length; start += batchSize) {
  const chunk = cases.slice(start, start + batchSize);
  const body = chunk.map((c, i) => [
    `--- case ${start + i + 1} (${c.sourceLang} -> ${c.locale}) ---`,
    `SOURCE:    ${clip(c.sourceText, 400)}`,
    `EXISTING:  ${clip(c.existing, 400)}`,
    `CANDIDATE: ${clip(c.candidate, 400)}`,
  ].join('\n')).join('\n\n');
  process.stderr.write(`judging ${start + 1}-${start + chunk.length} of ${cases.length}\n`);
  const proc = spawnSync('claude', ['-p', '--output-format', 'text'], {
    input: `${PROMPT}\n\n${body}\n`,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (proc.error || proc.status !== 0) {
    console.error(`claude -p failed on batch at ${start}: ${proc.error?.message || proc.status}`);
    continue;
  }
  for (const line of (proc.stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { const v = JSON.parse(t); if (Number.isInteger(v.n)) verdicts.set(v.n, v); } catch { /* chatter */ }
  }
}

const tally = { judged: 0, byVerdict: {}, byLocale: {}, byCompany: {}, byStrategy: {} };
for (let i = 0; i < cases.length; i++) {
  const v = verdicts.get(i + 1);
  if (!v) continue;
  cases[i].abVerdict = v.verdict;
  cases[i].abWhy = v.why;
  tally.judged++;
  tally.byVerdict[v.verdict] = (tally.byVerdict[v.verdict] || 0) + 1;
  for (const [k, key] of [['byLocale', cases[i].locale], ['byCompany', cases[i].company], ['byStrategy', cases[i].strategy]]) {
    tally[k][key] = tally[k][key] || {};
    tally[k][key][v.verdict] = (tally[k][key][v.verdict] || 0) + 1;
  }
}
shadow.abJudgement = { judgedAt: new Date().toISOString(), ...tally, byCompany: undefined };
shadow.abByCompany = tally.byCompany;
fs.writeFileSync(outPath, JSON.stringify(shadow, null, 2) + '\n');
console.log(JSON.stringify({ judged: tally.judged, of: cases.length, byVerdict: tally.byVerdict, byLocale: tally.byLocale, byStrategy: tally.byStrategy }, null, 1));
