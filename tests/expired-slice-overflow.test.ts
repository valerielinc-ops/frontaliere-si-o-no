import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { augmentExpiredSliceIndex, ExpiredSliceOverflow } from '../build-plugins/shared/expiredSliceOverflow';

describe('expired slice overflow', () => {
  it('wires overflow into both native consumers and closes it on build failure', () => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    expect(source).toContain('augmentExpiredSliceIndex(');
    expect(source).toContain('expiredBySlug.get(slug) ?? expiredSliceOverflow.get(slug)');
    const recency = source.slice(source.indexOf('const _expiredSlugRecency ='), source.indexOf('expiredSlugs.sort('));
    expect(recency).toContain('expiredSliceOverflow?.recency(s)');
    expect(recency).not.toContain('expiredSliceOverflow.get(');
    expect(source).toMatch(/finally\s*\{\s*\/\/[^\n]*\n\s*expiredSliceOverflow\?\.close\(\);/);
    expect(source).not.toContain('sliceAugmentCapped');
  });
  it.each([0, 1, 2])('retains late crawler content and primary winners with a RAM cap of %s', (cap) => {
    const primaryJob = { slug: 'shared', title: 'Recent primary', previousSlugs: [] as string[] };
    const first = { slug: 'early', title: 'Early crawler', previousSlugs: ['shared', 'collision', 'unrequested'] };
    const late = { slug: 'late', title: 'Original late content', previousSlugs: ['collision', 'late-en'] };
    const primary = new Map([['shared', primaryJob]]);
    const overflow = new ExpiredSliceOverflow<typeof first>();
    const emitted = new Set(['shared', 'early', 'collision', 'late', 'late-en']);
    try {
      expect(augmentExpiredSliceIndex([first, late], emitted, primary, overflow, cap, () => 0)).toBe(cap);
      expect(primary.size).toBe(1 + cap);
      const get = (slug: string) => primary.get(slug) ?? overflow.get(slug);
      expect(get('shared')).toBe(primaryJob);
      expect(get('collision')?.title).toBe(first.title);
      expect(get('late')).toEqual(late);
      expect(get('late-en')).toEqual(late);
      expect(get('unrequested')).toBeUndefined();
      expect(primary.size + overflow.size).toBe(emitted.size);
    } finally { overflow.close(); }
  });
  it('recovers every late alias with original Unicode content and first-owner identity', () => {
    const index = new ExpiredSliceOverflow<{ title: string; descriptionByLocale: { en: string } }>();
    const job = { title: 'Leitende Ärztin — Onkologie', descriptionByLocale: { en: 'Original archived vacancy' } };
    try {
      index.add(['late-en', 'late-de', 'late-en'], job, 17);
      index.add(['late-en', 'another'], { ...job, title: 'Different posting' }, 99);
      expect(index.size).toBe(3);
      expect(index.get('late-en')).toEqual(job);
      expect(index.get('late-de')).toEqual(job);
      expect(index.get('another')?.title).toBe('Different posting');
      expect(index.get('missing')).toBeUndefined();
      expect(index.recency('late-en')).toBe(17);
    } finally { index.close(); }
  });

  it('sorts using metadata without any record IO', () => {
    const index = new ExpiredSliceOverflow();
    try {
      index.add(['old'], { title: 'Older' }, 1);
      index.add(['new'], { title: 'Newer' }, 2);
      const read = vi.spyOn(fs, 'readSync');
      expect(['old', 'new'].sort((a, b) => index.recency(b)! - index.recency(a)!)).toEqual(['new', 'old']);
      expect(read).not.toHaveBeenCalled();
      read.mockRestore();
    } finally { vi.restoreAllMocks(); index.close(); }
  });

  it('fails closed on truncated data and removes only its private temporary directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-overflow-test-'));
    const index = new ExpiredSliceOverflow(parent);
    try {
      index.add(['late'], { title: 'Archive' }, 0);
      const owned = path.join(parent, fs.readdirSync(parent)[0]);
      fs.truncateSync(path.join(owned, 'records.jsonl'), 1);
      expect(() => index.get('late')).toThrow('Incomplete expired slice overflow read');
      index.close();
      index.close();
      expect(fs.readdirSync(parent)).toEqual([]);
      expect(() => index.add(['new'], {}, 0)).toThrow('closed');
    } finally { index.close(); fs.rmdirSync(parent); }
  });

  it('never creates a temporary file for empty or already-owned aliases', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-overflow-empty-'));
    const index = new ExpiredSliceOverflow(parent);
    try {
      index.add([], {}, 0);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally { index.close(); fs.rmdirSync(parent); }
  });
});
