import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  jobsSeoHtmlCacheKey,
  readEmittedHtml,
} from '../../build-plugins/shared/jobsSeoHtmlCache';

describe('Jobs SEO HTML cache keys', () => {
  it('keeps equal localized slugs in different canton paths separate', () => {
    const zurich = jobsSeoHtmlCacheKey('it', '/cerca-lavoro-zurigo/shared-role/');
    const ticino = jobsSeoHtmlCacheKey('it', 'cerca-lavoro-ticino/shared-role/');
    expect(zurich).not.toBe(ticino);
  });

  it('normalizes leading and trailing slashes consistently', () => {
    expect(jobsSeoHtmlCacheKey('it', '/cerca-lavoro-ticino/role/'))
      .toBe(jobsSeoHtmlCacheKey('it', 'cerca-lavoro-ticino/role'));
  });

  it('treats a sitemap file target as a missing HTML page without leaking ENOTDIR', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-html-cache-file-'));
    const pdfPath = path.join(distDir, 'guides', 'guide.pdf');
    try {
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
      fs.writeFileSync(pdfPath, '%PDF-fixture', 'utf8');
      expect(readEmittedHtml(distDir, 'guides/guide.pdf')).toBeUndefined();
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });
});
