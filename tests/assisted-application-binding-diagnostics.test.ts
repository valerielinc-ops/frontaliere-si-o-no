import { describe, expect, it } from 'vitest';
import { bindingDiagnosticInputs, formPostingMatch, stopReportFrom } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { redactStopReport, stopIssue } from '../scripts/assisted-application/lib/portal/stop-report.mjs';

// Synthetic SuccessFactors session form of a city posting (public posting data, no candidate data).
const applyUrl = 'https://career2.successfactors.eu/career?company=EXAMPLE&career_job_req_id=52113&lang=de_DE&career_ns=job_application';
const postingUrl = 'https://jobs.example-city.test/job/Vermessungsassistentin/1376278557/';
const pageUrl = 'https://career2.successfactors.eu/portalcareer?_s.crb=synthetictoken&clientId=jobs2web';
const job = { title: 'Vermessungsassistent*in', company: 'Stadt Beispiel' };
const page = (heading: string, ...extra: string[]) => ['Stadt Beispiel', 'Abmelden', heading, 'Meine Bewerbungsunterlagen', 'Speichern', 'Bewerben', ...extra, pageUrl].join('\n');
const run = (heading: string, headings: string[], extra: Record<string, unknown> = {}, ...lines: string[]) => {
  const diagnostics: Record<string, any> = {};
  const verdict = formPostingMatch(page(heading, ...lines), job, {
    postingEntry: true, postingMatched: true, pageUrl, postingUrl, paidPostingUrl: postingUrl, pageHeadings: headings,
    pageHeading: '', formFieldLabels: [], applyUrl, postingRouteProof: { via: 'successfactors', applyUrl, postingUrl },
    diagnostics, ...extra,
  });
  return { verdict, diagnostics };
};

describe('binding diagnostics of a form mismatch', () => {
  it('records nothing when the form matches', () => {
    const { verdict, diagnostics } = run('Vermessungsassistent*in (52113)', ['Vermessungsassistent*in (52113)']);
    expect(verdict).toBe('match');
    expect(diagnostics).toEqual({});
  });

  it('names the requisition guard with the normalized inputs', () => {
    const { verdict, diagnostics } = run('Vermessungsassistent*in (52114)', ['Vermessungsassistent*in (52114)']);
    expect(verdict).toBe('mismatch');
    expect(diagnostics.guard).toBe('requisition_mismatch');
    expect(diagnostics.inputs.headings).toEqual(['Vermessungsassistent*in (52114)']);
    expect(diagnostics.inputs.expectedTitles).toEqual(['vermessungsassistent in']);
    expect(diagnostics.inputs.firstLines[0]).toBe('Stadt Beispiel');
  });

  it('names the heading guard and the headings that conflicted', () => {
    const { verdict, diagnostics } = run('Vermessungsassistent*in (52113)', ['Vermessungsassistent*in (52113)', 'Bewerbung bei Siemens AG']);
    expect(verdict).toBe('mismatch');
    expect(diagnostics.guard).toMatch(/heading_conflict|direct_match_employer_conflict|employer_text_conflict/);
    expect(diagnostics.inputs.conflictHeadings).toEqual(['Bewerbung bei Siemens AG']);
    expect(diagnostics.inputs.flags).toMatchObject({ headingConflict: true });
  });

  it('keeps the URL to its path and parameter names, never their values', () => {
    const { diagnostics } = run('Vermessungsassistent*in (52114)', ['Vermessungsassistent*in (52114)']);
    expect(diagnostics.inputs.url).toEqual({ host: 'career2.successfactors.eu', path: '/portalcareer', params: ['_s.crb', 'clientId'] });
    expect(JSON.stringify(diagnostics.inputs)).not.toContain('synthetictoken');
  });

  it('bounds the lines to 12 of 160 characters and survives values that do not exist yet', () => {
    const long = 'x'.repeat(400);
    const inputs = bindingDiagnosticInputs({
      headings: () => Array.from({ length: 40 }, () => long),
      firstLines: () => { throw new ReferenceError('not yet'); },
      pageUrl: () => 'not a url',
      flags: () => ({ bound: true, roleHeading: 'unknown' }),
    });
    expect(inputs.headings).toHaveLength(12);
    expect(inputs.headings[0]).toHaveLength(160);
    expect(inputs.firstLines).toEqual([]);
    expect(inputs.url).toBeNull();
    expect(inputs.flags).toEqual({ bound: true, roleHeading: 'unknown' });
  });

  it('does not change the verdict when no diagnostics object is given', () => {
    expect(formPostingMatch(page('Vermessungsassistent*in (52114)'), job, {
      postingEntry: true, postingMatched: true, pageUrl, postingUrl, paidPostingUrl: postingUrl,
      pageHeadings: ['Vermessungsassistent*in (52114)'], applyUrl, postingRouteProof: { via: 'successfactors', applyUrl, postingUrl },
    })).toBe('mismatch');
  });
});

describe('public stop report', () => {
  const seen = { buttons: [{ text: 'Bewerben' }], fields: [], errors: [] };

  it('carries only the stable guard name', () => {
    const report = stopReportFrom({ url: pageUrl, reason: 'posting_unbound', step: 4, seen, bindingGuard: 'heading_conflict' });
    expect(redactStopReport(report)).toMatchObject({ bindingGuard: 'heading_conflict' });
    expect(stopIssue(redactStopReport(report) as any).description).toContain('**Guardia del binding:** `heading_conflict`');
  });

  it('drops anything that is not a guard name, such as a page text', () => {
    for (const text of ['Vermessungsassistent*in (52113)', 'Heading Conflict', '', 'x']) {
      const report = stopReportFrom({ url: pageUrl, reason: 'posting_unbound', step: 4, seen, bindingGuard: text });
      expect(redactStopReport(report)).not.toHaveProperty('bindingGuard');
    }
  });
});
