import { describe, it, expect } from 'vitest';
import {
  renderLandingHtml,
  generateSelfCertificationPdf,
  generateSwissSelfCertificationPdf,
  HEALTH_FORM,
  CRIMINAL_RECORD_FORM,
  CH_HEALTH_FORM,
  CH_CRIMINAL_RECORD_FORM,
  LANDING_URL_PATH,
  HEALTH_PDF_PATH,
  CRIMINAL_RECORD_PDF_PATH,
  CH_HEALTH_PDF_PATH,
  CH_CRIMINAL_RECORD_PDF_PATH,
} from '../build-plugins/selfCertificationFormsPlugin';

describe('selfCertificationFormsPlugin — landing page', () => {
  const { html, wordCount } = renderLandingHtml();

  it('meets the thin-content floor', () => {
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });

  it('emits BreadcrumbList JSON-LD (breadcrumb-coverage gate)', () => {
    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  it('emits FAQPage JSON-LD answering the source questions', () => {
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('Dove trovo il modulo di autocertificazione');
  });

  it('links all four downloadable PDFs', () => {
    expect(html).toContain(HEALTH_PDF_PATH);
    expect(html).toContain(CRIMINAL_RECORD_PDF_PATH);
    expect(html).toContain(CH_HEALTH_PDF_PATH);
    expect(html).toContain(CH_CRIMINAL_RECORD_PDF_PATH);
  });

  it('gates all four downloads behind data-pdf-gate with distinct source slugs', () => {
    // buildSeoPageHtml minifies attributes, dropping quotes on values with no
    // whitespace — match both quoted and unquoted forms.
    expect(html).toMatch(/data-pdf-gate-source=["']?self_cert_health_it["']?/);
    expect(html).toMatch(/data-pdf-gate-source=["']?self_cert_criminal_record_it["']?/);
    expect(html).toMatch(/data-pdf-gate-source=["']?self_cert_health_ch["']?/);
    expect(html).toMatch(/data-pdf-gate-source=["']?self_cert_criminal_record_ch["']?/);
    // Bare marker attribute (not the -source/-label variants) appears once per gated anchor.
    expect(html.match(/data-pdf-gate(?!-)/g)?.length).toBe(4);
    // Every gated anchor still carries a real, crawlable href + download attr.
    const gatedAnchorTags = html.match(/<a [^>]*data-pdf-gate(?!-)[^>]*>/g) ?? [];
    expect(gatedAnchorTags).toHaveLength(4);
    expect(gatedAnchorTags.every((tag) => tag.includes('download'))).toBe(true);
  });

  it('explains the Swiss-style questionnaire and its legal framework', () => {
    expect(html).toContain('art. 328b');
    expect(html).toContain('LORD');
    expect(html).toContain('art. 369');
  });

  it('uses trailing slash on the landing URL (site convention)', () => {
    expect(LANDING_URL_PATH.endsWith('/')).toBe(true);
  });

  it('includes the ad slot (never suppress ads)', () => {
    expect(html.toLowerCase()).toContain('advertisement');
  });
});

describe('selfCertificationFormsPlugin — PDF generation (Italian, DPR 445/2000)', () => {
  it('generates a valid, non-trivial health self-certification PDF', async () => {
    const buf = await generateSelfCertificationPdf(HEALTH_FORM);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('generates a valid, non-trivial criminal-record self-certification PDF', async () => {
    const buf = await generateSelfCertificationPdf(CRIMINAL_RECORD_FORM);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('cites the correct legal basis per form', () => {
    expect(HEALTH_FORM.legalBasis).toContain('47');
    expect(CRIMINAL_RECORD_FORM.legalBasis).toContain('46');
  });
});

describe('selfCertificationFormsPlugin — PDF generation (Swiss-style)', () => {
  it('generates a valid, non-trivial Swiss-style health questionnaire PDF', async () => {
    const buf = await generateSwissSelfCertificationPdf(CH_HEALTH_FORM);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('generates a valid, non-trivial Swiss-style criminal-record self-certification PDF', async () => {
    const buf = await generateSwissSelfCertificationPdf(CH_CRIMINAL_RECORD_FORM);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('cites the correct legal basis per Swiss-style form', () => {
    expect(CH_HEALTH_FORM.legalBasis).toContain('328b');
    expect(CH_CRIMINAL_RECORD_FORM.legalBasis).toContain('369');
  });

  it('asks at least one yes/no question per form', () => {
    expect(CH_HEALTH_FORM.questions.length).toBeGreaterThan(0);
    expect(CH_CRIMINAL_RECORD_FORM.questions.length).toBeGreaterThan(0);
  });
});
