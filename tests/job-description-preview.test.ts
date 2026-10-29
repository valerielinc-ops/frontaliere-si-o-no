import { buildBridgeThinHtml } from '../build-plugins/shared/bridgeThinShell';
import { buildSoftLandingThinHtml } from '../build-plugins/shared/softLandingThinShell';
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { jobDescriptionPreview, JOB_DESCRIPTION_PREVIEW_LENGTH } from '../services/jobs/descriptionPreview';
import { renderJobDescriptionContent } from '../build-plugins/shared/jobDescriptionContent';

const body = 'La seguente posizione è rivolta ai candidati per uno Stage servizio infermieristico. '.repeat(20);
const privateTail = 'Requisiti necessari: iscrizione SUPSI o SSSCI.';

describe('anonymous job description budget', () => {
  it('limits a single enormous paragraph, including EOC-style requirements embedded in prose', () => {
    const preview = jobDescriptionPreview(`<p>${body}${privateTail}</p>`);
    expect(preview.length).toBeLessThanOrEqual(JOB_DESCRIPTION_PREVIEW_LENGTH + 1);
    expect(preview).toContain('Stage servizio infermieristico');
    expect(preview).not.toContain(privateTail);
    expect(preview.endsWith('…')).toBe(true);
  });
  it('handles HTML and markdown safely without truncating short text unnecessarily', () => {
    expect(jobDescriptionPreview('## Profilo\n<p>**Cure** &amp; assistenza</p>')).toBe('Profilo Cure & assistenza');
    expect(jobDescriptionPreview('<p>## Profilo</p><p>**Cure**</p>')).toBe('Profilo Cure');
    expect(jobDescriptionPreview('<p>Qualit&agrave; &lt;SQL&gt; List<T> &amp;eacute;</p>')).toBe('Qualità <SQL> List<T> &eacute;');
    expect(jobDescriptionPreview('')).toBe('');
    expect(jobDescriptionPreview('<script>alert(1)</script>Descrizione')).toBe('Descrizione');
  });
  it.each(['it', 'en', 'de', 'fr'] as const)('keeps the entire static %s description, with semantic markup and no access gate', (locale) => {
    const html = renderJobDescriptionContent(`## Mansioni\n${body}\n\n## Requisiti\n- ${privateTail}\n- **Esperienza clinica**`, locale);
    document.body.innerHTML = html;
    expect(document.querySelector('[data-job-description-full]')?.textContent).toContain(privateTail);
    expect(document.querySelectorAll('h2').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('li')?.textContent).toContain(privateTail);
    expect(document.querySelector('strong')?.textContent).toBe('Esperienza clinica');
    expect(document.querySelector('#job-auth-gate')).toBeNull();
    expect(document.querySelector('[data-job-description-preview]')).toBeNull();
  });
  it('sanitizes full ATS HTML without losing its tail or introducing another H1', () => {
    document.body.innerHTML = renderJobDescriptionContent(`<h1>Mansioni</h1><p>${body}</p><ul><li>${privateTail}</li></ul><img src=x onerror=alert(1)><script>alert(1)</script>`, 'it');
    expect(document.querySelector('h1')).toBeNull();
    expect(document.querySelector('script, [onerror]')).toBeNull();
    expect(document.querySelector('li')?.textContent).toContain(privateTail);
  });
  it('protects full source content even if an alias or archive is offered to the thinning helpers', () => {
    const content = renderJobDescriptionContent(`${body}${privateTail}`, 'it');
    const page = `<html><head></head><body><main class="seo-static-content"><article class="ft-static-article"><h1>Offerta originale</h1>${content}</article></main></body></html>`;
    expect(buildBridgeThinHtml(page, 'current-job', 'it')).toBe(page);
    expect(buildSoftLandingThinHtml(page, 'it')).toBe(page);
  });
  it('uses the complete renderer in all static detail writers and keeps application links functional', () => {
    const source = readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    expect(source).toContain('renderJobDescriptionContent(localizedDescriptionRaw, locale, fullRequirements)');
    expect(source).toContain('renderJobDescriptionContent(jobDescription, locale)');
    expect(source).toContain('renderJobDescriptionContent(description, locale)');
    expect(source).not.toContain("'#job-auth-gate'");
    expect(source).not.toContain('buildBridgeThinHtml(');
    expect(source).toContain("hasRealTitle ? 'full' : __slDecision.action");
  });
});
