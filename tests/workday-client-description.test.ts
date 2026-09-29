import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  fetchWorkdayJobDescriptionText,
  fetchWorkdaySidebarText,
  formatWorkdaySidebarText,
} from '../scripts/lib/ats-clients/workday-client.mjs';
import { stripHtml } from '../scripts/lib/crawler-template.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('fetchWorkdayJobDescriptionText', () => {
  it('returns the whole posting body — no default length cap', async () => {
    // The former 4000-character default cut the tail (profile, benefits,
    // application notes) of every long Workday posting (issue 5253).
    const items = Array.from({ length: 80 }, (_, i) => `<li>Aufgabe ${i + 1}: Planung und Koordination der Abläufe im Team</li>`).join('');
    const html = `<p>Einleitung</p><ul>${items}</ul><p>Schlusssatz der Ausschreibung.</p>`;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jobPostingInfo: { jobDescription: html } })));
    const text = await fetchWorkdayJobDescriptionText('https://t.wd3.myworkdayjobs.com/wday/cxs/t/site', '/job/X_R1', stripHtml);
    expect(text.length).toBeGreaterThan(4000);
    expect(text).toContain('Schlusssatz der Ausschreibung.');
    expect(text).toMatch(/^• Aufgabe 80:/m);
  });

  it('still honours an explicit cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jobPostingInfo: { jobDescription: `<p>${'x'.repeat(500)}</p>` } })));
    const text = await fetchWorkdayJobDescriptionText('https://t.wd3.myworkdayjobs.com/wday/cxs/t/site', '/job/X_R2', stripHtml, { maxChars: 100 });
    expect(text.length).toBe(100);
  });
});

// Shapes minimised from the live `/sidebar` endpoints (2026-09-29):
// kantonsspitalbaden ksb-careers (one IMAGE "About us") and medbase
// Medbase_jobs (a VIDEO caption plus TEXT blocks). Workday folds these blocks
// into every posting's JSON-LD description; the CXS job payload never carries
// them.
describe('Workday career-site sidebar', () => {
  const KSB_SIDEBAR = [{
    type: 'IMAGE',
    title: 'About us',
    src: '/wday/cxs/kantonsspitalbaden/ksb-careers/sidebarimage/x',
    text: '<p>The KSB provides safe and close to home healthcare for more than 300,000 residents in the eastern part of the canton of Argovia.</p><p></p><p>More than 2000 employees care every day for the well-being of our patients.</p>',
  }];
  const MEDBASE_SIDEBAR = [
    { type: 'VIDEO', title: 'Willkommen', text: '<p>Willkommen auf der Karriereseite der Medbase Gruppe</p>' },
    { type: 'TEXT', title: 'Über uns', text: '<p>Die Medbase Gruppe betreibt über 150 medizinische, pharmazeutische und zahnärztliche Standorte in der Schweiz.</p>' },
    { type: 'TEXT', title: 'Leer', text: '' },
  ];

  it('formats text blocks under their title', () => {
    const text = formatWorkdaySidebarText(KSB_SIDEBAR, stripHtml);
    expect(text.startsWith('About us\n\nThe KSB provides safe')).toBe(true);
    expect(text).toContain('More than 2000 employees');
  });

  it('skips video captions and empty entries', () => {
    const text = formatWorkdaySidebarText(MEDBASE_SIDEBAR, stripHtml);
    expect(text).not.toContain('Willkommen');
    expect(text).not.toContain('Leer');
    expect(text).toBe('Über uns\n\nDie Medbase Gruppe betreibt über 150 medizinische, pharmazeutische und zahnärztliche Standorte in der Schweiz.');
    expect(formatWorkdaySidebarText(null, stripHtml)).toBe('');
  });

  it('reads the sidebar once per site and degrades to empty on failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(KSB_SIDEBAR));
    vi.stubGlobal('fetch', fetchMock);
    const base = 'https://ksbtest.wd3.myworkdayjobs.com/wday/cxs/ksbtest/site';
    const first = await fetchWorkdaySidebarText(base, stripHtml);
    const second = await fetchWorkdaySidebarText(base, stripHtml);
    expect(first).toContain('About us');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${base}/sidebar`);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) })));
    expect(await fetchWorkdaySidebarText('https://none.wd3.myworkdayjobs.com/wday/cxs/none/site', stripHtml)).toBe('');
  });
});
