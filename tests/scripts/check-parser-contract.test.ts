// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  PARSER_PATH_RE,
  compareFile,
  formatRegression,
  scanParserFile,
  scanParserSource,
} from '../../scripts/ci/check-parser-contract.mjs';

/**
 * Lint a ratchet sui parser dei crawler (issue 11674): una fixture sintetica
 * per regola, positiva e negativa, piu' il confronto con la baseline.
 * Le fixture riproducono le righe che il revisore ha bocciato sulle PR citate.
 */
const rulesOf = (source: string, file = 'scripts/lib/demo-job-parser.mjs') =>
  scanParserSource(source, file).map((v: { rule: string }) => v.rule);

describe('perimetro', () => {
  it('copre i parser di scripts/lib e i runner di scripts/', () => {
    expect(PARSER_PATH_RE.test('scripts/lib/acme-job-parser.mjs')).toBe(true);
    expect(PARSER_PATH_RE.test('scripts/update-acme-jobs.mjs')).toBe(true);
    expect(PARSER_PATH_RE.test('scripts/lib/acme-common.mjs')).toBe(false);
    expect(PARSER_PATH_RE.test('scripts/lib/nested/acme-job-parser.mjs')).toBe(false);
  });
});

describe('R1 data di crawl come data di pubblicazione', () => {
  it('boccia il ripiego su oggi (PR 9452) e il normalizzatore che ripiega su oggi (PR 10186)', () => {
    const fallback = `const job = {\n  crawledAt: new Date().toISOString(),\n  postedDate: listing.postedDate || new Date().toISOString().split('T')[0],\n};\n`;
    expect(rulesOf(fallback)).toEqual(['R1']);
    const normalizer = `function normalizeDate(value = '') {\n  const candidate = String(value || '').trim();\n  if (!candidate) return new Date().toISOString().slice(0, 10);\n  return candidate;\n}\n`;
    expect(rulesOf(normalizer)).toEqual(['R1']);
    expect(rulesOf('const datePosted = Date.now();\n')).toEqual(['R1']);
  });

  it('lascia passare la data della sorgente e il `now` passato agli helper di provenienza', () => {
    const ok = `const job = {\n  crawledAt: new Date().toISOString(),\n  ...sourcePostingDateFields(detail.datePosted, new Date()),\n  postedDate: sourcePostingDateFields(raw, new Date()).postedDate,\n};\nfunction crawlTimestamp() { return new Date().toISOString(); }\n`;
    expect(rulesOf(ok)).toEqual([]);
  });
});

describe('R2 ritirata', () => {
  it("non segnala un indirizzo vuoto: lo completa buildJobPostingSchema", () => {
    expect(rulesOf(`const out = { postalCode: '', streetAddress: raw.street || '' };\n`)).toEqual([]);
  });
});

describe('R3 validThrough grezzo', () => {
  it('boccia il campo della sorgente copiato senza normalizzatore (PR 11281)', () => {
    expect(rulesOf(`const job = {\n  validThrough: detail.validThrough || listing.validThrough || '',\n};\n`)).toEqual(['R3']);
    expect(rulesOf(`const job = { validThrough: String(rawJob?.endDate || '').trim() };\n`)).toEqual(['R3']);
  });

  it('accetta un normalizzatore, un valore gia\' passato da un parser e il vuoto', () => {
    const ok = `const a = { validThrough: toIsoDate(detail.validThrough) };\n`
      + `const b = { validThrough: row.endDate ? row.endDate.slice(0, 10) : '' };\n`
      + `const c = { validThrough: parsed.validThrough || '' };\n`
      + `const d = { validThrough: '' };\n`;
    expect(rulesOf(ok)).toEqual([]);
  });
});

describe('R4 sourcePostingDateFields con candidati', () => {
  it('boccia una catena fra date e un campo start* (PR 11297, 11281)', () => {
    expect(rulesOf(`const p = sourcePostingDateFields(meta.postedDate || req.PostedDate);\n`)).toEqual(['R4']);
    expect(rulesOf(`const p = { ...sourcePostingDateFields(info.startDate) };\n`)).toEqual(['R4']);
    expect(rulesOf(`const p = { ...sourcePostingDateFields(toIsoDate(detail.postedDate || listing.postedDate)) };\n`)).toEqual(['R4']);
  });

  it('accetta la forma a candidati, un campo solo e un fallback vuoto', () => {
    const ok = `const a = sourcePostingDateCandidatesFields([meta.postedDate, req.PostedDate]);\n`
      + `const b = sourcePostingDateFields(detail.datePosted);\n`
      + `const c = sourcePostingDateFields(detail.datePosted || '');\n`
      + `const d = sourcePostingDateFields(parseSwissShortDate(value) || value);\n`;
    expect(rulesOf(ok)).toEqual([]);
  });
});

describe('R5 corpo senza soglia di parole', () => {
  const body = `export function parse(detail) {\n  const description = extractBody(detail.html);\n  return { description };\n}\n`;

  it('boccia un estrattore in un file che non passa da nessuna soglia (PR 10333)', () => {
    expect(rulesOf(body)).toEqual(['R5']);
  });

  it('accetta il file che importa la soglia o il cui runner usa la pipeline standard', () => {
    const imported = `import { meetsSourceBodyFloor } from './source-body-floor.mjs';\n${body}`;
    expect(rulesOf(imported)).toEqual([]);
    const runner = `await runStandardCrawlerPipeline({ fetchJobs });\n`;
    const read = (file: string) => {
      if (file === 'scripts/update-demo-jobs.mjs') return runner;
      throw Object.assign(new Error('assente'), { code: 'ENOENT' });
    };
    expect(scanParserFile('scripts/lib/demo-job-parser.mjs', body, read)).toEqual([]);
    expect(scanParserFile('scripts/lib/other-job-parser.mjs', body, read).map((v: { rule: string }) => v.rule)).toEqual(['R5']);
  });

  it('non conta un default di parametro ne\' un letterale', () => {
    const ok = `function build({\n  description = '',\n}) {\n  let description2 = '';\n  return description2;\n}\n`;
    expect(rulesOf(ok)).toEqual([]);
  });
});

describe('lexer ed eccezione', () => {
  it('ignora commenti e stringhe', () => {
    const src = `// postedDate: listing.postedDate || new Date()\nconst s = "validThrough: detail.validThrough";\n/* sourcePostingDateFields(a.date || b.date) */\n`;
    expect(rulesOf(src)).toEqual([]);
  });

  it('accetta l\'eccezione in linea con un motivo, non senza', () => {
    const line = `const p = sourcePostingDateFields(info.startDate);`;
    expect(rulesOf(`${line} // parser-contract-ok R4: startDate e' la data di pubblicazione di questa API\n`)).toEqual([]);
    expect(rulesOf(`// parser-contract-ok R4: startDate e' la data di pubblicazione di questa API\n${line}\n`)).toEqual([]);
    expect(rulesOf(`${line} // parser-contract-ok R4:\n`)).toEqual(['R4']);
    expect(rulesOf(`${line} // parser-contract-ok R3: motivo valido ma regola sbagliata\n`)).toEqual(['R4']);
  });
});

describe('ratchet', () => {
  const file = 'scripts/update-demo-jobs.mjs';
  const twoChains = `const a = sourcePostingDateFields(x.postedDate || y.datePublished);\nconst b = sourcePostingDateFields(info.startDate);\n`;

  it('un file nuovo con una violazione fallisce col messaggio parser-contract R<n>', () => {
    const violations = scanParserSource(twoChains, file);
    const { regressions } = compareFile(file, violations, undefined);
    expect(regressions.map((r: { rule: string }) => r.rule)).toEqual(['R4']);
    const message = formatRegression(regressions[0]);
    expect(message).toMatch(/^parser-contract R4 [^:]+: scripts\/update-demo-jobs\.mjs:1\b/m);
    expect(message).toMatch(/^parser-contract R4 [^:]+: scripts\/update-demo-jobs\.mjs:2\b/m);
  });

  it('un conteggio che sale fallisce, uguale passa, che scende va registrato', () => {
    const violations = scanParserSource(twoChains, file);
    const now = violations.length;
    expect(compareFile(file, violations, { R4: now - 1 }).regressions.map((r: { rule: string }) => r.rule)).toEqual(['R4']);
    expect(compareFile(file, violations, { R4: now })).toEqual({ regressions: [], improvements: [] });
    const lowered = compareFile(file, violations, { R4: now + 1 });
    expect(lowered.regressions).toEqual([]);
    expect(lowered.improvements.map((i: { rule: string }) => i.rule)).toEqual(['R4']);
  });
});
