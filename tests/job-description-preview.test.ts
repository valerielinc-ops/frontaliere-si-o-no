// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { jobDescriptionPreview, JOB_DESCRIPTION_PREVIEW_LENGTH } from '../services/jobs/descriptionPreview';
import { renderJobDescriptionGate } from '../build-plugins/shared/jobDescriptionGate';

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
  it.each(['it', 'en', 'de', 'fr'] as const)('emits the same limited preview in static %s pages, without a hidden full-body copy', (locale) => {
    const html = renderJobDescriptionGate(body + privateTail, locale);
    document.body.innerHTML = html;
    const preview = document.querySelector('[data-job-description-preview]');
    expect(preview?.textContent).toBe(jobDescriptionPreview(body + privateTail));
    expect(document.querySelector('#job-auth-gate')?.textContent).toBeTruthy();
    expect(html).not.toContain(privateTail);
  });
  it('uses the gate in active, expired and historical static emitters and both mobile action paths', () => {
    const source = readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    expect(source).toContain('renderJobDescriptionGate(localizedDescriptionRaw, locale)');
    expect(source).toContain('renderJobDescriptionGate(jobDescription, locale)');
    expect(source).toContain('renderJobDescriptionGate(description, locale)');
    expect(source.match(/referralUrl: \(\) => '#job-auth-gate'/g)).toHaveLength(2);
    const template = source.slice(source.indexOf('<main class="seo-static-content static-job-page">'), source.indexOf('const cSlugBanner'));
    expect(template).not.toContain('${summaryHtml}');
    expect(template).not.toContain('${timelineHtml');
    expect(template).not.toContain('renderHighlightsChips');
    expect(template).toContain('canonicalKeywords: []');
  });
});
