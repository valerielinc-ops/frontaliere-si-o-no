import { describe, it, expect } from 'vitest';
import {
  sanitizeExpiredKey,
  makeExpiredKeyAssigner,
  buildSlimExpiredEntry,
} from '../build-plugins/shared/slimExpiredIndex';

describe('slimExpiredIndex — sanitizeExpiredKey', () => {
  it('keeps URL-safe slugs intact', () => {
    expect(sanitizeExpiredKey('sales-assistant-cambiavalute-ch-ticino')).toBe(
      'sales-assistant-cambiavalute-ch-ticino',
    );
  });

  it('lowercases and replaces unsafe characters', () => {
    expect(sanitizeExpiredKey('Foo Bar/Baz?x=1')).toBe('foo-bar-baz-x-1');
  });

  it('trims leading/trailing separators', () => {
    expect(sanitizeExpiredKey('--edge--')).toBe('edge');
  });

  it('caps length to a filesystem-safe bound', () => {
    const key = sanitizeExpiredKey('a'.repeat(500));
    expect(key.length).toBeLessThanOrEqual(180);
  });

  it('falls back to "unknown" for empty/nullish slugs', () => {
    expect(sanitizeExpiredKey('')).toBe('unknown');
    expect(sanitizeExpiredKey(undefined)).toBe('unknown');
    expect(sanitizeExpiredKey('???')).toBe('unknown');
  });
});

describe('slimExpiredIndex — makeExpiredKeyAssigner', () => {
  it('returns the base key on first use', () => {
    const assign = makeExpiredKeyAssigner();
    expect(assign('alpha')).toBe('alpha');
  });

  it('suffixes colliding keys so detail filenames stay unique', () => {
    const assign = makeExpiredKeyAssigner();
    expect(assign('dup')).toBe('dup');
    expect(assign('dup')).toBe('dup-1');
    expect(assign('dup')).toBe('dup-2');
  });

  it('treats slugs that sanitise to the same value as collisions', () => {
    const assign = makeExpiredKeyAssigner();
    expect(assign('Foo Bar')).toBe('foo-bar');
    expect(assign('foo/bar')).toBe('foo-bar-1');
  });
});

describe('slimExpiredIndex — buildSlimExpiredEntry', () => {
  const entry = {
    slug: 'job-x',
    title: 'Job X',
    titleByLocale: { it: 'Lavoro X' },
    company: 'Acme',
    descriptionByLocale: { it: 'long prose...', en: 'more prose...' },
    slugByLocale: { it: 'job-x', en: 'job-x-en' },
    previousSlugs: ['old-job-x'],
    previousSlugsByLocale: { it: ['vecchio-job-x'] },
    sector: 'finance',
    expiredAt: '2026-01-01',
  };

  it('drops descriptionByLocale (the heavy field) from the slim index', () => {
    const slim = buildSlimExpiredEntry(entry, 'job-x');
    expect(slim).not.toHaveProperty('descriptionByLocale');
  });

  it('attaches the detail-file key', () => {
    const slim = buildSlimExpiredEntry(entry, 'job-x');
    expect(slim.key).toBe('job-x');
  });

  it('preserves every slug-variant field needed for runtime matching', () => {
    const slim = buildSlimExpiredEntry(entry, 'job-x');
    expect(slim.slug).toBe('job-x');
    expect(slim.slugByLocale).toEqual({ it: 'job-x', en: 'job-x-en' });
    expect(slim.previousSlugs).toEqual(['old-job-x']);
    expect(slim.previousSlugsByLocale).toEqual({ it: ['vecchio-job-x'] });
  });

  it('preserves display fields (title, company, sector, expiredAt)', () => {
    const slim = buildSlimExpiredEntry(entry, 'job-x');
    expect(slim.title).toBe('Job X');
    expect(slim.titleByLocale).toEqual({ it: 'Lavoro X' });
    expect(slim.company).toBe('Acme');
    expect(slim.sector).toBe('finance');
    expect(slim.expiredAt).toBe('2026-01-01');
  });
});
