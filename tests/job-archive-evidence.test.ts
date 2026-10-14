import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import { hasRecordedJobIdentity, unverifiedJobCopy } from '../build-plugins/shared/jobArchiveEvidence';

describe('recorded versus URL-inferred job identity', () => {
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
  });
});
