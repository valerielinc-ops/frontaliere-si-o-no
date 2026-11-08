import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JOB_EMPLOYMENT_LABELS_BY_LOCALE } from '../../scripts/lib/job-employment-type.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
const CARD_SOURCE = fs.readFileSync(path.join(ROOT, 'build-plugins/jobOgImagesPlugin.ts'), 'utf8');
const ACTIVE_JOB_HEAD_START = SOURCE.indexOf('<meta property="og:type" content="article">');
const ACTIVE_JOB_HEAD_END = SOURCE.indexOf('<link rel="canonical" href="${effectiveCanonicalUrl}">', ACTIVE_JOB_HEAD_START);
const ACTIVE_JOB_HEAD = SOURCE.slice(ACTIVE_JOB_HEAD_START, ACTIVE_JOB_HEAD_END);

describe('active job social image metadata', () => {
  it('uses the vertical job image only when the Italian title is usable', () => {
    expect(SOURCE).toContain('const italianJobTitle = getItalianJobTitle(job)');
    expect(SOURCE).toContain('const italianJobPhoto = italianJobTitle');
    expect(SOURCE).toContain('const italianJobImageUrl = italianJobPhoto');
    expect(SOURCE).toContain('versionedJobOgImageUrl(');
    expect(SOURCE).toContain('jobOgLogoFingerprint(job.companyKey)');
    expect(SOURCE).toContain('const socialImage = italianJobImageUrl || `${BASE_URL}/og-image.png`');
    expect(ACTIVE_JOB_HEAD).toContain('<meta property="og:image" content="${socialImage}">');
    expect(ACTIVE_JOB_HEAD).toContain('<meta property="og:image:width" content="${italianJobImageUrl ? \'1080\' : \'1200\'}">');
    expect(ACTIVE_JOB_HEAD).toContain('<meta property="og:image:height" content="${italianJobImageUrl ? \'1350\' : \'630\'}">');
  });

  it('uses a verified Italian title in the Italian link preview', () => {
    expect(SOURCE).toContain("const socialTitle = locale === 'it'");
    expect(SOURCE).toContain("stripLiteralMarkdownFromTitle(getItalianJobTitle(job)) || 'Offerta di lavoro'");
    expect(SOURCE).toContain("const socialTitleProbe = locale === 'it'");
    expect(SOURCE).toContain('const ogTitle = truncateHeadline(socialTitleProbe, OG_TITLE_MAX_CHARS)');
    expect(ACTIVE_JOB_HEAD).toContain('<meta property="og:title" content="${esc(ogTitle)}">');
  });

  it('includes the chosen social image in the incremental page input', () => {
    const start = SOURCE.indexOf('const activeJobManifestInput = incrementalManifests');
    const end = SOURCE.indexOf('const activeJobReuseInput =', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(SOURCE.slice(start, end)).toContain('socialImage,');
  });

  it('renders only the verified Italian title into the image', () => {
    expect(CARD_SOURCE).toContain('const italianTitle = getItalianJobTitle(job)');
    expect(CARD_SOURCE).toContain('if (!slug || !italianTitle)');
    expect(CARD_SOURCE).toContain('title: truncateText(italianTitle, 82)');
  });

  it('renders the card with Italian employment labels', () => {
    expect(CARD_SOURCE).toContain('const EMPLOYMENT_LABEL_IT: Record<string, string> = JOB_EMPLOYMENT_LABELS_BY_LOCALE.it');
    expect(JOB_EMPLOYMENT_LABELS_BY_LOCALE.it.PART_TIME).toBe('Tempo parziale');
    expect(JOB_EMPLOYMENT_LABELS_BY_LOCALE.it.INTERN).toBe('Tirocinio');
    expect(Object.values(JOB_EMPLOYMENT_LABELS_BY_LOCALE.it)).not.toContain('Part-time');
  });
});
