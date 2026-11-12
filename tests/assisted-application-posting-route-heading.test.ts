import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { hasVacancySpecificPostingEvidence, isRoleHeading, postingMainHeading } from '../scripts/assisted-application/lib/portal/portal.mjs';

// The public Yellowshark posting of order 1EpmkrDu, rebuilt from its rendered
// text (2026-11-10). The contact person's name and number are left out: no person here.
const postingUrl = 'https://jobs.yellowshark.com/job/sa068838/';
const job = { title: 'IT Product Manager', company: 'yellowshark AG' };
const pageTitle = 'IT Product Manager | yellowshark | Jobs genau für Sie | Jetzt Traumjob finden';
const renderedPosting = (heading = 'IT Product Manager') => [
  'Zum Inhalt springen',
  'FÜR UNTERNEHMEN',
  'Job suchen',
  'Dienstleistungen',
  'Ratgeber',
  'Über uns',
  'Kontakt',
  '30.10.2026',
  heading,
  '6300 Zug (Hybrid)',
  'Development',
  'Festanstellung',
  'Hybrid',
  'Lohnband',
  "115'000 - 135'000 CHF",
  '01',
  'Zukünftiger Arbeitgeber',
  'Du hast Freude daran, komplexe Zusammenhänge zu verstehen.',
  'JETZT BEWERBEN',
  'Ansprechpartner',
  'Key Account Manager IT',
  'ZUM TEAM',
  '08.10.2026 / 8810 HORGEN',
  'Senior Software Developer .NET / C# (m/w) 100%',
  '10.10.2026 / 3250 LYSS',
  'Senior Software Engineer Java (m/w) 80-100%',
  'Job-Ticker',
  'Spontanbewerbung',
  'Future. Talent. Job.',
  'FAQ | IMPRESSUM | DATENSCHUTZ',
].join('\n');

describe('selected posting route whose rendered text starts with a skip link', () => {
  it('reproduces the stop: the skip link was read as the page title', () => {
    expect(hasVacancySpecificPostingEvidence(renderedPosting(), job, { pageUrl: postingUrl, pageTitle, postingUrl })).toBe(false);
  });

  it('binds the route when its own main heading is the role', () => {
    expect(hasVacancySpecificPostingEvidence(renderedPosting(), job, {
      pageUrl: postingUrl, pageTitle, pageHeading: 'IT Product Manager', postingUrl,
    })).toBe(true);
    // Gender markers and a workload around the role are still the role.
    expect(hasVacancySpecificPostingEvidence(renderedPosting('IT Product Manager (m/w/d) 80-100%'), job, {
      pageUrl: postingUrl, pageTitle, pageHeading: 'IT Product Manager (m/w/d) 80-100%', postingUrl,
    })).toBe(true);
  });

  it('keeps another posting on the same route a mismatch even when the role is in a related-jobs card', () => {
    const heading = 'Senior Software Engineer Java (m/w) 80-100%';
    const text = `${renderedPosting(heading)}\nWeitere Jobs\nIT Product Manager`;
    expect(hasVacancySpecificPostingEvidence(text, job, { pageUrl: postingUrl, pageTitle, pageHeading: heading, postingUrl })).toBe(false);
  });

  it('reads a role heading only with every word of the role (acceptance of the review of #18003)', () => {
    expect(isRoleHeading('Product Manager', 'IT Product Manager')).toBe(false);
    expect(isRoleHeading('IT Product Manager (m/w/d) 80-100%', 'IT Product Manager')).toBe(true);
    // Only a workload percentage is a number around the role (review of #18003).
    expect(isRoleHeading('Product Manager 999', 'Product Manager')).toBe(false);
    expect(isRoleHeading('Product Manager 100 %', 'Product Manager')).toBe(true);
  });

  it('keeps a heading with only part of the role a mismatch (review of #18003)', () => {
    expect(hasVacancySpecificPostingEvidence(renderedPosting('Product Manager'), job, {
      pageUrl: postingUrl, pageTitle, pageHeading: 'Product Manager', postingUrl,
      uniqueApplicationEntryProven: true,
    })).toBe(false);
  });

  it('keeps a heading that names a second employer a mismatch', () => {
    const heading = 'IT Product Manager bei Muster Bank';
    expect(hasVacancySpecificPostingEvidence(renderedPosting(heading), job, {
      pageUrl: postingUrl, pageTitle, pageHeading: heading, postingUrl,
    })).toBe(false);
  });

  it('does not bind another posting address through the heading', () => {
    const otherPosting = 'https://jobs.yellowshark.com/job/sa068001/';
    expect(hasVacancySpecificPostingEvidence(renderedPosting(), job, {
      pageUrl: otherPosting, pageTitle: 'Senior Software Engineer Java | yellowshark', pageHeading: 'IT Product Manager', postingUrl,
    })).toBe(false);
  });

  it('still refuses the route when the page names another employer next to the company', () => {
    const text = renderedPosting().replace('Zukünftiger Arbeitgeber', 'Zukünftiger Arbeitgeber: yellowshark Konkurrenz');
    expect(hasVacancySpecificPostingEvidence(text, job, {
      pageUrl: postingUrl, pageTitle, pageHeading: 'IT Product Manager', postingUrl,
    })).toBe(false);
  });
});

describe('postingMainHeading', () => {
  afterEach(() => vi.unstubAllGlobals());

  const pageOf = (html: string) => {
    const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: postingUrl });
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent || ''; },
    });
    window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const size = Number(this.getAttribute('data-size') || 20);
      return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    return { evaluate: async (fn: Function) => fn() };
  };

  it('reads the single visible main heading', async () => {
    expect(await postingMainHeading(pageOf('<a href="#main">Zum Inhalt springen</a><h1> IT Product\n Manager </h1>'))).toBe('IT Product Manager');
    expect(await postingMainHeading(pageOf('<h1>IT Product Manager</h1><h1 style="display:none">Other Role</h1>'))).toBe('IT Product Manager');
  });

  it('distinguishes no heading from ambiguous or unreadable heading evidence', async () => {
    expect(await postingMainHeading(pageOf('<h1>IT Product Manager</h1><h1>Senior Software Engineer Java</h1>'))).toBeNull();
    expect(await postingMainHeading(pageOf('<h2>IT Product Manager</h2>'))).toBe('');
    expect(await postingMainHeading({ evaluate: async () => { throw new Error('unavailable'); } })).toBeNull();
    expect(hasVacancySpecificPostingEvidence(renderedPosting(), job, {
      pageUrl: postingUrl,
      pageTitle: 'IT Product Manager | yellowshark AG',
      pageHeading: null,
      postingUrl,
      uniqueApplicationEntryProven: true,
    })).toBe(false);
    // A different heading after ten copies of the role is still a second heading (review of #18003).
    expect(await postingMainHeading(pageOf(`${'<h1>IT Product Manager</h1>'.repeat(10)}<h1>Apply now</h1>`))).toBeNull();
    // A long heading is returned whole, so the role check sees its suffix (review of #18003).
    const long = `Product Manager${'—'.repeat(190)} at Other Employer`;
    expect(isRoleHeading(await postingMainHeading(pageOf(`<h1>${long}</h1>`)), 'Product Manager')).toBe(false);
    // The review's acceptance case as a page: a unique visible h1 with a bare number is not the role (finding 7254076cf749).
    expect(isRoleHeading(await postingMainHeading(pageOf('<h1>Product Manager 999</h1>')), 'Product Manager')).toBe(false);
    expect(isRoleHeading(await postingMainHeading(pageOf('<h1>Product Manager 80-100%</h1>')), 'Product Manager')).toBe(true);
  });
});
