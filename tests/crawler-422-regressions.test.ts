import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
const withoutComments = (value: string) => value
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('HTTP 422 crawler regressions', () => {
  it('keeps jobs.ch pagination 1-indexed so the API never receives page=0', () => {
    const jobsCh = source('scripts/lib/jobs-ch-search-common.mjs');
    expect(jobsCh).toMatch(/let page = 1;/);
    expect(jobsCh).not.toMatch(/let page = 0;/);
  });

  it('keeps Constellium on the SAP SuccessFactors board, not the retired Workday CXS endpoint', () => {
    const constellium = source('scripts/lib/constellium-job-parser.mjs');
    expect(constellium).toContain('const CAREER_URL = `https://${CAREER_HOST}/search/`;');
    expect(withoutComments(constellium)).not.toMatch(/constellium\.wd\d+\.myworkdayjobs\.com\/wday\/cxs/);
  });

  it('keeps Novelis on iCIMS, not the retired Workday API/site', () => {
    const novelis = source('scripts/lib/novelis-job-parser.mjs');
    expect(novelis).toContain('https://jobs-novelis.icims.com/jobs/search');
    expect(withoutComments(novelis)).not.toMatch(/novelis\.wd\d+\.myworkdayjobs\.com\/wday\/cxs/);
  });

  it('keeps the retired Groq 422 model out of the active AI-first chain', () => {
    const aiModels = source('scripts/lib/ai-models.mjs');
    const transientFetch = source('scripts/lib/transient-fetch.mjs');
    const defaultChain = aiModels.slice(aiModels.indexOf('export const DEFAULT_CHAIN'), aiModels.indexOf('];', aiModels.indexOf('export const DEFAULT_CHAIN')));
    expect(defaultChain).toContain('AI_MODELS.CODEX_CLI_PRIMARY');
    expect(defaultChain).not.toMatch(/^\s*AI_MODELS\.GROQ_LLAMA_3_1_70B\b/m);
    expect(transientFetch).toContain('new Set([408, 425, 429, 500, 502, 503, 504])');
    expect(transientFetch).toContain('new Set([403, 406, 415, 451])');
    expect(transientFetch).not.toMatch(/new Set\([^)]*\b422\b/);
  });

  it('treats Workday 400 and literal 422 facet responses as validation, then discovers the tenant facet', () => {
    const workday = source('scripts/lib/workday-swiss-job-parser-common.mjs');
    expect(workday).toContain('![400, 422].includes(err?.statusCode)');
    expect(workday).toContain('fetchWorkdayBoardSummary(API_BASE)');
    expect(withoutComments(workday)).not.toMatch(/quarantine.*422/i);
  });
});
