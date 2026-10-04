import { resolveReportedPostingDate } from '../scripts/lib/job-posting-date.mjs';
import { buildJobPostingSchema } from '../build-plugins/shared/jobPostingSchema';
import { resolveJobPostingPostalCode } from '../services/jobLocationSnapshot';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seededJobMatchesSlug } from '../services/seededExpiredJob';
import { parseSearchSlugFilter } from '../services/relatedSearchClusters';

// Execute the production effect's selected and no-selected-job paths without mounting the
// whole board or replacing its schema cleanup with a test implementation.
const source = ts.createSourceFile('JobBoard.tsx', readFileSync('components/community/JobBoard.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: ts.ArrowFunction[] = [];
const filterInitializers = new Map<string, string>();
let locationParser = '';
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
    const candidate = node.arguments[0];
    if (candidate && ts.isArrowFunction(candidate) && candidate.getText(source).includes('const jobsForSchema = [selectedJob]')) callbacks.push(candidate);
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
    && ['locationSlugFilter', 'searchSlugFilter'].includes(node.name.text)) {
    filterInitializers.set(node.name.text, node.initializer.getText(source));
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'parseLocationSlugFilter') locationParser = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
const callback = callbacks[0];
if (!callback) throw new Error('JobPosting production effect not found');
const effectCode = ts.transpileModule(`const effect = ${callback.getText(source)}; effect();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const executeEffect = new Function('document', 'isSeededExpiredDetail', 'selectedJob', 'initialJobSlug', 'searchSlugFilter', 'companySlugFilter', 'locationSlugFilter', 'editorialLandingDescriptor', 'window', 'hasSeededExpiredData', 'bridgeTargetSlug', 'buildJobPath', 'locale', 'sanitizeJobTitle', 'companyLogoUrl', 'resolveJobPostingPostalCode', 'buildJobPostingSchema', 'resolveReportedPostingDate', effectCode);
if (!locationParser || filterInitializers.size !== 2) throw new Error('Production slug filter declarations not found');
const filterCode = ts.transpileModule(`${locationParser}
  const useMemo = (read: () => unknown) => read();
  const search = ${filterInitializers.get('searchSlugFilter')};
  const location = ${filterInitializers.get('locationSlugFilter')};
  return { search, location };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const executeFilters = new Function('initialJobSlug', 'isSeededExpiredDetail', 'isBridgePage', 'parseSearchSlugFilter', filterCode);
const seededWindow = window as unknown as { __EXPIRED_JOB_DATA__?: { slug: string; title: string } };

function runEffect(slug?: string, locationFilter: string | null = null) {
  executeEffect(document, Boolean(slug && seededJobMatchesSlug(slug)), null, slug, parseSearchSlugFilter(slug), null, locationFilter, null);
}

beforeEach(() => {
  document.head.innerHTML = '<script id="archived-posting" type="application/ld+json">{"@type":"JobPosting","validThrough":"2026-09-24T00:00:00Z"}</script><script id="archive-page" type="application/ld+json">{"@type":"WebPage"}</script>';
});
afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete seededWindow.__EXPIRED_JOB_DATA__;
});

describe('archived JobPosting hydration and list navigation', () => {
  it.each([undefined, null, 'unknown'] as const)('removes stale static JobPosting for selected %s while preserving page and FAQ', (postingDateSource) => {
    const date = new Date(Date.now() - 86400000).toISOString();
    const selected = { id: 'active', slug: 'active', title: 'Infermiere', company: 'Example SA', location: 'Lugano', canton: 'TI', addressLocality: 'Lugano', postingDateSource, datePosted: date, postedDate: date, crawledAt: date, description: 'Assistenza infermieristica ai pazienti nel reparto clinico e collaborazione con il gruppo sanitario.' };
    document.head.insertAdjacentHTML('beforeend', '<script id="faq" type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>');
    document.body.innerHTML = '<h1>Infermiere</h1><a href="https://employer.test/apply/">Candidati</a>';
    const run = (job: typeof selected) => executeEffect(document, false, job, 'active', null, null, null, null, window, () => false, null, () => '/lavoro/active/', 'it', (title: string) => title, () => '', resolveJobPostingPostalCode, buildJobPostingSchema, resolveReportedPostingDate);
    run(selected);
    expect(document.getElementById('archived-posting')).toBeNull();
    expect(document.getElementById('jobposting-structured-data')).toBeNull();
    expect(document.getElementById('archive-page')).not.toBeNull();
    expect(document.getElementById('faq')).not.toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe('Infermiere');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://employer.test/apply/');
    // A subsequent genuine source date restores eligible schema without remounting.
    executeEffect(document, false, { ...selected, postingDateSource: 'reported' }, 'active', null, null, null, null, window, () => false, null, () => '/lavoro/active/', 'it', (title: string) => title, () => '', resolveJobPostingPostalCode, buildJobPostingSchema, resolveReportedPostingDate);
    expect(JSON.parse(document.getElementById('jobposting-structured-data')!.textContent!)['@graph'][0].datePosted).toBe(date);
    run(selected);
    expect(document.getElementById('jobposting-structured-data')).toBeNull();
    expect(document.getElementById('faq')).not.toBeNull();
  });

  it.each<[string, string | null]>([
    ['search-engineer-acme', null],
    ['location-manager-acme', 'manager-acme'],
  ])('preserves the current archived posting with a list-like slug: %s', (slug, locationFilter) => {
    seededWindow.__EXPIRED_JOB_DATA__ = { slug, title: 'Historical vacancy' };
    runEffect(slug, locationFilter);
    expect(document.getElementById('archived-posting')).not.toBeNull();
    expect(document.getElementById('archive-page')).not.toBeNull();
  });

  it.each([undefined, 'search-infermiere'])('removes stale posting markup when navigating to listing %s', (slug) => {
    seededWindow.__EXPIRED_JOB_DATA__ = { slug: 'search-engineer-acme', title: 'Historical vacancy' };
    runEffect(slug);
    expect(document.getElementById('archived-posting')).toBeNull();
    expect(document.getElementById('archive-page')).not.toBeNull();
  });

  it('preserves a normal detail while its data is still loading', () => {
    runEffect('infermiere-acme-lugano');
    expect(document.getElementById('archived-posting')).not.toBeNull();
  });

  it.each(['search-engineer-acme', 'location-manager-acme'])('treats matching archive %s as a detail instead of a filter landing', (slug) => {
    seededWindow.__EXPIRED_JOB_DATA__ = { slug, title: 'Historical vacancy' };
    expect(executeFilters(slug, seededJobMatchesSlug(slug), false, parseSearchSlugFilter)).toEqual({ search: null, location: null });
  });

  it('keeps real search and location filters available after leaving an archive', () => {
    seededWindow.__EXPIRED_JOB_DATA__ = { slug: 'search-engineer-acme', title: 'Historical vacancy' };
    for (const slug of ['search-infermiere', 'location-lugano']) {
      const filters = executeFilters(slug, seededJobMatchesSlug(slug), false, parseSearchSlugFilter);
      expect(filters.search || filters.location).toBeTruthy();
    }
  });
});
