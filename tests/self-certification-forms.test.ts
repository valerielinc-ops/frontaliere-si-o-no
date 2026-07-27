import { describe, it, expect } from 'vitest';
import {
  renderLandingHtml,
  generateSelfCertificationPdf,
  HEALTH_FORM,
  CRIMINAL_RECORD_FORM,
  LANDING_URL_PATH,
  HEALTH_PDF_PATH,
  CRIMINAL_RECORD_PDF_PATH,
} from '../build-plugins/selfCertificationFormsPlugin';

describe('selfCertificationFormsPlugin — landing page', () => {
  const { html, wordCount } = renderLandingHtml();

  it('meets the thin-content floor', () => {
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });

  it('emits BreadcrumbList JSON-LD (breadcrumb-coverage gate)', () => {
    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  it('emits FAQPage JSON-LD answering the two source questions', () => {
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('Dove trovo il modulo di autocertificazione');
  });

  it('links both downloadable PDFs', () => {
    expect(html).toContain(HEALTH_PDF_PATH);
    expect(html).toContain(CRIMINAL_RECORD_PDF_PATH);
  });

  it('uses trailing slash on the landing URL (site convention)', () => {
    expect(LANDING_URL_PATH.endsWith('/')).toBe(true);
  });

  it('includes the ad slot (never suppress ads)', () => {
    expect(html.toLowerCase()).toContain('advertisement');
  });
});

describe('selfCertificationFormsPlugin — PDF generation', () => {
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
