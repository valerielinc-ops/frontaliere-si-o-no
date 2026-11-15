// @vitest-environment node
/**
 * The GSC job monitor feeds `job-rich-missing` to the Indexing API job.
 *
 * From 2026-10-24 to 2026-11-10 the monitor called two functions that were
 * never defined (`isJobPageUrl`, `jobPostingRichResultRegression`, added by
 * #15046). Every run logged "Monitor error: isJobPageUrl is not defined",
 * exited 0 and stayed green; the file was never produced. The source parsed,
 * the module imported fine, and no test executed that line — so the guard
 * below is static: no script of the indexing chain may reference a name that
 * is declared nowhere.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { jobRichResultRegression } from '../scripts/monitor-gsc-job-indexation.mjs';

const S = 'https://frontaliereticino.ch';

describe('jobRichResultRegression', () => {
  const live = `${S}/cerca-lavoro-ticino/farmacista-chiasso/`;
  it('flags a live job page URL Inspection reports without Job postings', () => {
    expect(jobRichResultRegression({ pageUrl: live, liveJob: true, result: { verdict: 'PASS', hasJobs: false } })).toMatch(/no Job postings/);
  });
  it('does not flag an unindexed live page or a page that has the rich result', () => {
    expect(jobRichResultRegression({ pageUrl: live, liveJob: true, result: { verdict: 'NEUTRAL', hasJobs: false } })).toBeNull();
    expect(jobRichResultRegression({ pageUrl: live, liveJob: true, result: { verdict: 'PASS', hasJobs: true } })).toBeNull();
  });
  it('does not flag a page that is not live, was not inspected, or is not a job detail', () => {
    expect(jobRichResultRegression({ pageUrl: live, liveJob: true, result: { verdict: 'PASS', hasJobs: true } })).toBeNull();
    expect(jobRichResultRegression({ pageUrl: live, liveJob: false, result: { hasJobs: false } })).toBeNull();
    expect(jobRichResultRegression({ pageUrl: live, liveJob: true, result: { error: 'quota' } })).toBeNull();
    expect(jobRichResultRegression({ pageUrl: `${S}/cerca-lavoro-ticino/`, liveJob: true, result: { hasJobs: false } })).toBeNull();
  });
});

/** Scripts whose failure silently stops job pages from reaching Google. */
const INDEXING_CHAIN = [
  'scripts/monitor-gsc-job-indexation.mjs',
  'scripts/submit-google-indexing-jobs.js',
  'scripts/notify-article-search-engines.mjs',
  'scripts/lib/indexing-jobs-planner.mjs',
  'scripts/lib/indexing-ledger-store.mjs',
  'scripts/lib/indexing-api-quota.mjs',
  'scripts/lib/indexing-api.mjs',
  'scripts/lib/indexing-owner.mjs',
  'scripts/lib/job-rich-result-guard.mjs',
].map((f) => resolve(f));

describe('indexing chain scripts reference only declared names', () => {
  it('has no "Cannot find name" (the class of isJobPageUrl is not defined)', () => {
    // checkJs without module resolution: imported bindings are still
    // declarations; Node globals (process, Buffer) report a different code
    // (2580/2591), so only 2304/2552 — a name declared nowhere — fail here.
    const program = ts.createProgram(INDEXING_CHAIN, {
      allowJs: true, checkJs: true, noEmit: true, noResolve: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    });
    const undeclared: string[] = [];
    for (const file of INDEXING_CHAIN) {
      const sf = program.getSourceFile(file);
      expect(sf, file).toBeDefined();
      for (const d of program.getSemanticDiagnostics(sf)) {
        if (d.code !== 2304 && d.code !== 2552) continue;
        const { line } = sf!.getLineAndCharacterOfPosition(d.start ?? 0);
        undeclared.push(`${file.slice(process.cwd().length + 1)}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('the guard is real: it reports the identifiers the monitor used to call', () => {
    const src = readFileSync(resolve('scripts/monitor-gsc-job-indexation.mjs'), 'utf8')
      .replace(
        'const jobRichResultRegressionReason = jobRichResultRegression({ pageUrl, liveJob, result });',
        'const jobRichResultRegressionReason = isJobPageUrl(pageUrl) ? jobPostingRichResultRegression(result) : null;',
      );
    expect(src).toContain('isJobPageUrl(pageUrl)');
    const host = ts.createCompilerHost({});
    const orig = host.getSourceFile;
    host.getSourceFile = (name, lang, ...rest) => (name === '/virtual/monitor.mjs'
      ? ts.createSourceFile(name, src, lang)
      : orig.call(host, name, lang, ...rest));
    const program = ts.createProgram(['/virtual/monitor.mjs'], {
      allowJs: true, checkJs: true, noEmit: true, noResolve: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    }, host);
    const names = program.getSemanticDiagnostics(program.getSourceFile('/virtual/monitor.mjs'))
      .filter((d) => d.code === 2304 || d.code === 2552)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
    expect(names.join('\n')).toContain("'isJobPageUrl'");
    expect(names.join('\n')).toContain("'jobPostingRichResultRegression'");
  });
});

describe('monitor-gsc-seo.yml hands job-rich-missing to the indexing job', () => {
  const wf = readFileSync(resolve('.github/workflows/monitor-gsc-seo.yml'), 'utf8');
  it('produces the file, uploads it, and the indexing job consumes it as --priority-file', () => {
    expect(wf).toContain('--rich-missing-out /tmp/job-rich-missing.json');
    expect(wf).toMatch(/name: job-rich-missing\n\s+path: \/tmp\/job-rich-missing\.json/);
    expect(wf).toContain('--priority-file /tmp/job-rich-missing/job-rich-missing.json');
  });
});
