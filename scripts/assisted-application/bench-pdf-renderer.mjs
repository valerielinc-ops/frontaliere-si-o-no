#!/usr/bin/env node
/**
 * Cost of the PDF renderer (functions/src/assistedApplicationPdfRenderer.js):
 * the same synthetic CV and letter through the standard-font writer used
 * before Typst (baseline) and through Typst (current). The candidate is the
 * invented developer of tests/assisted-application-pdf-ats.test.ts; no real data.
 *
 *   node scripts/assisted-application/bench-pdf-renderer.mjs [runs]
 *
 * Prints the median of `runs` (default 30) after one warm-up, and the first
 * Typst document of the process (compiler and fonts loaded) apart. Each run
 * changes one line (the headline, the date), as drafts differ: Typst would
 * otherwise return the identical document from its cache.
 */

import { performance } from 'node:perf_hooks';
import { letterPdfBlocks, sanitizeProfile } from '../../functions/src/assistedApplicationAiDraftCore.js';
import { buildCvDocument } from '../../functions/src/assistedApplicationCvDocument.js';
import { renderCvPdf, renderLetterPdf } from '../../functions/src/assistedApplicationPdfRenderer.js';
import { sanitizeTailoredCv } from '../../functions/src/assistedApplicationTailoredCv.js';

const RUNS = Math.max(1, Number(process.argv[2]) || 30);

const identity = { name: 'Marco Bianchi', email: 'candidatura-8h2m@frontaliereticino.ch', phone: '+39 333 555 0101' };
const profile = sanitizeProfile({
  headline: 'Sviluppatore full-stack', location: 'Como (I)', linkedin: 'linkedin.com/in/marco-bianchi-example', website: 'github.com/marcob-example',
  languages: [{ language: 'Italiano', level: 'madrelingua' }, { language: 'Inglese', level: 'C1' }, { language: 'Tedesco', level: 'B1' }],
  experience: [
    { role: 'Sviluppatore full-stack', employer: 'Esempio Software Srl', location: 'Milano', start: '03/2021', end: 'oggi', kind: 'job', highlights: ['Portale B2B in React e Node.js usato da 400 clienti', 'Tempo di build ridotto del 40% con Docker multi-stage'] },
    { role: 'Sviluppatore front-end', employer: 'Agenzia Web Esempio', location: 'Como', start: '09/2019', end: '02/2021', kind: 'job', highlights: ['Siti e-commerce per 15 clienti'] },
  ],
  education: [{ degree: 'Laurea in Informatica', institution: "Università degli Studi dell'Insubria", start: '2016', end: '2019' }],
  projects: [{ name: 'timesheet', url: 'github.com/marcob-example/timesheet', description: 'App open source per fogli ore in TypeScript' }],
});
const cv = sanitizeTailoredCv({
  headline: 'Sviluppatore full-stack', summary: 'Sviluppatore full-stack con 6 anni di esperienza su applicazioni web in TypeScript, React e Node.js.', competencies: [], experience: [], skills: [],
}, { profile, cvText: JSON.stringify(profile), language: 'it', type: 'qualified', sector: 'it', title: 'Sviluppatore full-stack' });
const document = buildCvDocument(cv, { identity, profile, language: 'it', type: 'qualified', sector: 'it' });
const letter = letterPdfBlocks({
  identity, profile, posting: { contactPerson: 'Signora Anna Esempio' }, companyName: 'Esempio Fintech SA', language: 'it', title: 'Sviluppatore full-stack', now: new Date(Date.UTC(2026, 9, 2)),
  letter: {
    salutation: 'Gentile signora Esempio,',
    paragraphs: [
      'Mi candido per il posto di sviluppatore full-stack pubblicato sul vostro sito.',
      'Da cinque anni sviluppo applicazioni web in React e Node.js; il portale B2B che ho realizzato serve oggi 400 clienti.',
      'Sarei lieto di presentarvi il mio lavoro in un colloquio.',
    ],
    closing: 'Cordiali saluti',
  },
});

async function time(fn, run) {
  const start = performance.now();
  await fn(run);
  return performance.now() - start;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function measure(label, fn) {
  const first = await time(fn, 0);
  const runs = [];
  for (let run = 1; run <= RUNS; run += 1) runs.push(await time(fn, run));
  return { label, first, median: median(runs) };
}

const cvOf = (run) => ({ ...document, headline: `${document.headline} ${run}` });
const letterOf = (run) => ({ ...letter, placeDate: `${letter.placeDate} ${run}` });

const results = [];
// The first Typst compile of the process loads the compiler and the fonts: measured first, on its own.
results.push(await measure('cv typst', async (run) => {
  const { renderer } = await renderCvPdf(cvOf(run), { mode: 'typst' });
  if (renderer !== 'typst') throw new Error('typst fell back to the standard-font writer');
}));
results.push(await measure('cv baseline', (run) => renderCvPdf(cvOf(run), { mode: 'legacy' })));
results.push(await measure('letter typst', (run) => renderLetterPdf(letterOf(run), { mode: 'typst' })));
results.push(await measure('letter baseline', (run) => renderLetterPdf(letterOf(run), { mode: 'legacy' })));

console.log(`node ${process.version}, ${RUNS} runs after one warm-up`);
for (const { label, first, median: value } of results) console.log(`${label.padEnd(16)} median ${value.toFixed(1)} ms   first ${first.toFixed(1)} ms`);
