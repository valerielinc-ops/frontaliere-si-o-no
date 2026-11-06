import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
const ACTIVE_JOB_HEAD_START = SOURCE.indexOf('<meta property="og:type" content="article">');
const ACTIVE_JOB_HEAD_END = SOURCE.indexOf('<link rel="canonical" href="${effectiveCanonicalUrl}">', ACTIVE_JOB_HEAD_START);
const ACTIVE_JOB_HEAD = SOURCE.slice(ACTIVE_JOB_HEAD_START, ACTIVE_JOB_HEAD_END);

describe('active job social image metadata', () => {
  it('uses the vertical job image only when the Italian title is usable', () => {
    expect(SOURCE).toContain('const italianJobImageUrl = getItalianJobTitle(job)');
    expect(SOURCE).toContain('const socialImage = italianJobImageUrl || `${BASE_URL}/og-image.png`');
    expect(ACTIVE_JOB_HEAD).toContain('<meta property="og:image" content="${socialImage}">');
    expect(ACTIVE_JOB_HEAD).toContain('<meta property="og:image:width" content="${italianJobImageUrl ? \'1080\' : \'1200\'}">');
    expect(ACTIVE_JOB_HEAD).toContain('<meta property="og:image:height" content="${italianJobImageUrl ? \'1350\' : \'630\'}">');
  });

  it('includes the chosen social image in the incremental page input', () => {
    const start = SOURCE.indexOf('const activeJobManifestInput = incrementalManifests');
    const end = SOURCE.indexOf('const activeJobReuseInput =', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(SOURCE.slice(start, end)).toContain('socialImage,');
  });
});
