#!/usr/bin/env node
/**
 * shadow-guard-eval.mjs — PHASE 1, READ-ONLY. Replays the CANDIDATE side of the
 * proposed language-aware guard over reports already produced by
 * argos-reject-audit.mjs, so the pass rate costs no Argos run and no LLM call.
 *
 * For every case the current chain rejected with `skip:existing-good`, ask the
 * question the current guard never asks: is the candidate itself in the target
 * language? Uses titleLooksUntranslated(), the same detector that queued the
 * slot — no new predicate.
 *
 * usage: shadow-guard-eval.mjs <report.json> [...] --out <shadow.json>
 */
import fs from 'node:fs';
import { titleLooksUntranslated } from '../lib/job-locale-utils.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
const reports = args.filter((a, i) => a !== '--out' && i !== outIdx + 1);

const add = (o, k) => { o[k] = (o[k] || 0) + 1; };

const all = [];
for (const p of reports) {
  const r = JSON.parse(fs.readFileSync(p, 'utf-8'));
  for (const c of r.cases) all.push({ ...c, strategy: r.strategy, report: p });
}

const out = {
  reports,
  cases: all.length,
  byDecision: {},
  existingGood: {
    total: 0,
    // candidate passes the language check -> the new guard WRITES
    wouldWrite: 0,
    // candidate itself still looks source-language -> the new guard still SKIPS
    stillSkip: 0,
    stillSkipReason: {},
    writeByLocale: {},
    writeByStrategy: {},
    writeByCompany: {},
    skipByStrategy: {},
    // the "candidate much shorter" direction, measured not assumed
    writeShorterThanExisting: 0,
    writeShorterBy30pct: 0,
  },
  changed: [],
};

for (const c of all) {
  add(out.byDecision, c.decision);
  if (c.decision !== 'skip:existing-good') continue;
  out.existingGood.total++;
  // The company/location the detector needs are not in the case record; the
  // audit already stripped them when it judged the EXISTING text, and passing
  // '' only makes the detector MORE likely to call a candidate untranslated
  // (company names are not stripped), i.e. it is the conservative direction.
  const v = titleLooksUntranslated({
    title: c.finalized,
    sourceTitle: c.sourceText,
    sourceLang: c.sourceLang,
    targetLocale: c.locale,
    company: '',
    location: '',
  });
  if (v.untranslated) {
    out.existingGood.stillSkip++;
    add(out.existingGood.stillSkipReason, v.reason);
    add(out.existingGood.skipByStrategy, c.strategy);
    continue;
  }
  out.existingGood.wouldWrite++;
  add(out.existingGood.writeByLocale, c.locale);
  add(out.existingGood.writeByStrategy, c.strategy);
  add(out.existingGood.writeByCompany, c.company);
  const le = String(c.existing || '').length;
  const li = String(c.finalized || '').length;
  if (li < le) out.existingGood.writeShorterThanExisting++;
  if (li < le * 0.7) out.existingGood.writeShorterBy30pct++;
  out.changed.push({
    id: c.id, company: c.company, strategy: c.strategy, sourceLang: c.sourceLang,
    locale: c.locale, field: c.field, entryReason: c.entryReason,
    sourceText: c.sourceText, existing: c.existing, candidate: c.finalized,
    priorVerdict: c.verdict || null, priorWhy: c.verdictWhy || null,
  });
}

const eg = out.existingGood;
out.existingGood.writeCompaniesCount = Object.keys(eg.writeByCompany).length;
out.existingGood.topWriteCompanies = Object.entries(eg.writeByCompany).sort((a, b) => b[1] - a[1]).slice(0, 15);
delete out.existingGood.writeByCompany;

if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ ...out, changed: `${out.changed.length} cases` }, null, 1));
