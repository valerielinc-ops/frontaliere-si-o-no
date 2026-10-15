import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import { hasRecordedJobIdentity, unverifiedJobCopy } from '../build-plugins/shared/jobArchiveEvidence';

describe('recorded versus URL-inferred job identity', () => {
  it('retains the whole verified record when a stronger same-slug GSC-only row follows', () => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    const start = source.indexOf('for (const entry of enrichedArr)');
    const end = source.indexOf('if (orphanGscData.size > 0)', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(`const orphanGscData = new Map(); let withQueries = 0; let withContent = 0; ${source.slice(start, end)} return orphanGscData;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const run = new Function('enrichedArr', 'hasRecordedJobIdentity', code);
    const original = { slug: 'same-slug', title: 'Original title', titleByLocale: { en: 'Original title' }, descriptionByLocale: { en: 'Original description' }, company: 'Original employer', source: ['translation-cache:exact'] };
    const signalOnly = { slug: original.slug, title: 'Inferred title', titleByLocale: { en: 'Inferred locale title' }, descriptionByLocale: { en: 'Unverified description' }, company: 'Inferred employer', source: ['slug-parsing'], queries: ['original query'], totalImpressions: 12, totalClicks: 2 };
    const saved = run([original, signalOnly], hasRecordedJobIdentity).get(original.slug);
    expect(saved.recordedIdentity).toBe(true);
    expect(saved.title).toBe(original.title);
    expect(saved.titleByLocale).toEqual(original.titleByLocale);
    expect(saved.descriptionByLocale).toEqual(original.descriptionByLocale);
    expect(saved.company).toBe(original.company);
    expect(saved.queries).toEqual(signalOnly.queries);
    expect(saved.totalImpressions).toBe(12);
  });
  it.each([false, true])('gates localized hydration fields on recorded identity (%s)', (hasRealTitle) => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    const start = source.indexOf('const pickLocaleEntry =');
    const end = source.indexOf('const expiredWindowData =', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(`${source.slice(start, end)} return expiredDataObj;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const run = new Function('hasRealTitle', 'ejData', 'gscInfo', 'slugInfo', 'locale', 'relPath', 'slug', 'jobCompany', 'jobLocation', code);
    const info = { title: 'Locale role', titleByLocale: { en: 'Locale role' }, descriptionByLocale: { en: 'Locale description' }, slugByLocale: { fr: 'another-reference' }, sector: 'Unverified sector' };
    const seed = run(hasRealTitle, null, info, { companyKey: 'url-employer' }, 'en', '/en/find-jobs-zurich/own-route/', 'tracking-key', 'URL employer', 'URL place');
    if (hasRealTitle) {
      expect(seed.titleByLocale).toEqual(info.titleByLocale);
      expect(seed.descriptionByLocale).toEqual(info.descriptionByLocale);
    } else {
      expect(seed).not.toHaveProperty('titleByLocale');
      expect(seed).not.toHaveProperty('descriptionByLocale');
      expect(seed).not.toHaveProperty('slugByLocale');
      expect(seed).not.toHaveProperty('sector');
      expect(seed.slug).toBe('own-route');
    }
  });
  it('uses the generic unverified title in every safety-writer title output', () => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    const start = source.indexOf('const buildHistoricalArchiveHtml =');
    const end = source.indexOf('for (const [slug, paths] of Object.entries(tracking)', start);
    const safety = source.slice(start, end);
    const titleExpression = safety.match(/const titleRaw = ([^\n]+);/)?.[1];
    expect(titleExpression).toBeTruthy();
    const title = new Function('recordedIdentity', 'archive', 'slugInfo', 'copy', 'unknownCopy', 'stripLiteralMarkdownFromTitle', `return ${titleExpression};`)(false, { title: 'Unverified record title' }, { title: 'Nurse' }, { original: 'Original details' }, unverifiedJobCopy.en, (value: string) => value);
    expect(title).toBe(unverifiedJobCopy.en.title);
    for (const binding of ['composeSerpJobTitle(titleRaw,', 'historicalArchiveHeading(titleRaw,', '${esc(titleRaw)}', '${titleRaw}', 'name: titleRaw']) expect(safety).toContain(binding);
  });
  it('uses only the literal URL reference for the normal unverified heading', () => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    const block = source.slice(source.indexOf('const unknownCopy = unverifiedJobCopy[locale as'));
    const expression = block.match(/const jobTitle = ([^\n]+);/)?.[1];
    expect(expression).toBeTruthy();
    const title = new Function('hasRealTitle', 'ejData', 'gscInfo', 'slugInfo', 'locale', 'copy', 'stripLiteralMarkdownFromTitle', `return ${expression};`)(false, { title: 'Partial record title' }, { titleByLocale: { en: 'Wrong GSC role' } }, { title: 'URL reference' }, 'en', unverifiedJobCopy.en, (value: string) => value);
    expect(title).toBe('URL reference');
  });
  it('accepts exact archive records without inventing an id or source URL requirement', () => {
    expect(hasRecordedJobIdentity({ title: 'Hotelfachassistentin 60-100%' })).toBe(true);
    expect(hasRecordedJobIdentity({ titleByLocale: { en: 'Head physician oncology' } })).toBe(true);
  });
  it.each(['translation-cache', 'translation-cache:exact', 'wayback'])('preserves documented localized titles from %s', (source) => {
    expect(hasRecordedJobIdentity(null, { titleByLocale: { en: 'Original title' }, source: [source] })).toBe(true);
  });
  it.each(['slug-parsing', 'slug-registry', 'all-known-slugs', 'url-inspection', 'translation-cache:prefix', 'translation-cache:unknown', 'translation-cache-dubious'])('does not treat %s as original listing content', (source) => {
    expect(hasRecordedJobIdentity(null, { title: 'Title derived from URL', source: [source] })).toBe(false);
    expect(hasRecordedJobIdentity(null, { titleByLocale: { en: 'Inferred' }, source: [source] })).toBe(false);
  });
  it('requires actual localized title content even when a cache source is named', () => {
    expect(hasRecordedJobIdentity(null, { title: 'Derived fallback', titleByLocale: { en: ' ' }, source: ['translation-cache'] })).toBe(false);
    expect(hasRecordedJobIdentity(null, { titleByLocale: { en: 'Unknown provenance' } })).toBe(false);
    expect(hasRecordedJobIdentity()).toBe(false);
  });
  it('uses the same evidence guard in normal and safety writers, without promoting inferred payload titles', () => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    expect(source).toContain('if (hasRecordedJobIdentity(null, entry)) data.recordedIdentity = true');
    expect(source).toContain('const hasRealTitle = hasRecordedJobIdentity(ejData) || gscInfo?.recordedIdentity === true');
    expect(source).toContain('recordedIdentity: hasRealTitle');
    expect(source).toContain('const recordedIdentity = archive?.recordedIdentity === true');
    expect(source).toContain('title: recordedIdentity ? titleRaw : undefined');
    expect(source).toContain('slug: hasRealTitle ? slug : routeSlug');
    expect(source).toContain('recordedIdentity && countHtmlBodyWords(staticBody) >= MIN_INDEXABLE_WORDS ? ROBOTS_INDEX_ENHANCED : ROBOTS_NOINDEX_FOLLOW');
  });
  it.each(['it', 'en', 'de', 'fr'])('forces unverified %s pages out of the index regardless of generic word count', (locale) => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    const start = source.indexOf('let expiredRobotsTag: string;');
    const end = source.indexOf("recordPhase('ejp:wc-robots'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(source.slice(start, end) + '\nreturn { tag: expiredRobotsTag, words: itBodyWordCount };', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const execute = new Function('hasRealTitle', 'locale', 'countHtmlBodyWords', 'robotsMetaForContent', 'staticBody', 'MIN_INDEXABLE_WORDS', 'ROBOTS_INDEX_ENHANCED', 'ROBOTS_NOINDEX_FOLLOW', 'itBodyWordCount', code);
    const run = (known: boolean) => execute(known, locale, () => 500, () => 'index', 'generic text', 50, 'index', 'noindex', 0);
    expect(run(false)).toEqual({ tag: 'noindex', words: 0 });
    expect(run(true).tag).toBe('index');
  });
  it('provides the explicit unknown state in all four locales', () => {
    expect(Object.keys(unverifiedJobCopy)).toEqual(['it', 'en', 'de', 'fr']);
    for (const copy of Object.values(unverifiedJobCopy)) {
      expect(copy.banner).toContain('URL');
      expect(copy.title).not.toBe('');
      expect(copy.details).not.toBe('');
    }
  });
  it('does not promote dates or JobPosting from an unverified partial archive record', () => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    expect(source).toContain("const expiredAt = hasRealTitle ? ejData?.expiredAt || '' : ''");
    expect(source).toContain('if (hasRealTitle && jobDatePosted) detailItems.push(');
    expect(source).toContain('if (hasRealTitle && jobExpiredAt) detailItems.push(');
    const start = source.indexOf('const jobPostingLd = (() => {');
    const end = source.indexOf('const realTitle =', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("if (!hasRealTitle) return '';");
    const search = source.slice(source.indexOf('// --- Search suggestions ---'), source.indexOf('// --- Frontalier info section:'));
    expect(search.match(/hasRealTitle && jobLocation/g)).toHaveLength(4);
    expect(source).toContain("${recordedIdentity ? `${copy.nextBody} ` : ''}");
  });
});
