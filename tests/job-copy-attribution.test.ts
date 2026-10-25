// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildJobCopyAttribution,
  buildJobCopyAttributionFromSelection,
  buildJobCopyAttributionUrl,
  shouldAttributeCopy,
  COPY_ATTRIBUTION_MIN_CHARS,
  isSelectionWithinScope,
  JOB_COPY_UTM_CAMPAIGN,
  JOB_COPY_UTM_MEDIUM,
  JOB_COPY_UTM_SOURCE,
} from '../services/jobCopyAttribution';

const LEAD = 'Annuncio completo e candidatura su Frontaliere Ticino:';
const URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/radiologo-ospedale-x/';
const ATTRIBUTED_URL = buildJobCopyAttributionUrl(URL);

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('shouldAttributeCopy', () => {
  it('skips selections shorter than the minimum', () => {
    expect(shouldAttributeCopy('short')).toBe(false);
    expect(shouldAttributeCopy('   ')).toBe(false);
    expect(shouldAttributeCopy('a'.repeat(COPY_ATTRIBUTION_MIN_CHARS - 1))).toBe(false);
  });

  it('attributes selections at or above the minimum length', () => {
    expect(shouldAttributeCopy('a'.repeat(COPY_ATTRIBUTION_MIN_CHARS))).toBe(true);
    expect(
      shouldAttributeCopy('Cerchiamo un radiologo per il nostro ospedale a Lugano'),
    ).toBe(true);
  });

  it('trims before measuring', () => {
    expect(shouldAttributeCopy(`   ${'x'.repeat(COPY_ATTRIBUTION_MIN_CHARS)}   `)).toBe(true);
  });

  it('attributes a short selection that IS the job title', () => {
    // "Cuoco" is below the floor but is exactly what users paste into search.
    expect(shouldAttributeCopy('Cuoco')).toBe(false);
    expect(shouldAttributeCopy('Cuoco', 'Cuoco')).toBe(true);
  });

  it('matches the title case- and whitespace-insensitively', () => {
    expect(shouldAttributeCopy('  cUoCo   80-100%  ', 'Cuoco 80-100%')).toBe(true);
  });

  it('does not attribute a short non-title selection even with a title given', () => {
    expect(shouldAttributeCopy('CHF 90k', 'Radiologo/a')).toBe(false);
  });
});

describe('buildJobCopyAttribution', () => {
  it('appends lead, title line and canonical URL to plain text', () => {
    const { text } = buildJobCopyAttribution({
      selectionText: 'Cerchiamo un radiologo esperto.',
      jobTitle: 'Radiologo/a',
      company: 'Ospedale X',
      url: URL,
      lead: LEAD,
    });
    expect(text).toBe(
      `Cerchiamo un radiologo esperto.\n\n${LEAD}\nRadiologo/a – Ospedale X\n${ATTRIBUTED_URL}`,
    );
  });

  it('omits the company separator when no company is given', () => {
    const { text, html } = buildJobCopyAttribution({
      selectionText: 'x'.repeat(30),
      jobTitle: 'Radiologo/a',
      url: URL,
      lead: LEAD,
    });
    expect(text).toContain('\nRadiologo/a\n');
    expect(text).not.toContain('–');
    expect(html).toContain('>Radiologo/a</a>');
  });

  it('emits a real backlink anchor in the HTML payload', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'Cerchiamo un radiologo esperto.',
      jobTitle: 'Radiologo/a',
      company: 'Ospedale X',
      url: URL,
      lead: LEAD,
    });
    expect(html).toContain(`<a href="${ATTRIBUTED_URL}">Radiologo/a – Ospedale X</a>`);
    expect(html).toContain(LEAD);
  });

  it('prefers the rich selection HTML over the plain text when present', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'plain fallback text here',
      selectionHtml: '<p>rich <strong>selection</strong></p>',
      jobTitle: 'Radiologo/a',
      url: URL,
      lead: LEAD,
    });
    expect(html.startsWith('<p>rich <strong>selection</strong></p>')).toBe(true);
    expect(html).not.toContain('plain fallback text here');
  });

  it('escapes HTML-significant characters in injected fields', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'safe selection text long enough',
      jobTitle: 'Dev & "Ops" <lead>',
      company: 'A&B',
      url: 'https://frontaliereticino.ch/q/?a=1&b=2',
      lead: LEAD,
    });
    expect(html).toContain('Dev &amp; &quot;Ops&quot; &lt;lead&gt; – A&amp;B');
    expect(html).toContain(
      'href="https://frontaliereticino.ch/q/?a=1&amp;b=2&amp;utm_source=frontaliereticino&amp;utm_medium=referral&amp;utm_campaign=job_copy_attribution"',
    );
    expect(html).not.toContain('<lead>');
  });

  it('falls back to escaped plain text when no selection HTML is provided', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'a <b> & c selection long enough',
      jobTitle: 'Radiologo/a',
      url: URL,
      lead: LEAD,
    });
    expect(html.startsWith('a &lt;b&gt; &amp; c selection long enough<br><br>')).toBe(true);
  });
});

describe('buildJobCopyAttributionUrl', () => {
  it('adds first-party UTM dimensions while preserving existing query parameters', () => {
    const attributed = buildJobCopyAttributionUrl(`${URL}?source=search`);
    const parsed = new URL(attributed);

    expect(parsed.searchParams.get('source')).toBe('search');
    expect(parsed.searchParams.get('utm_source')).toBe(JOB_COPY_UTM_SOURCE);
    expect(parsed.searchParams.get('utm_medium')).toBe(JOB_COPY_UTM_MEDIUM);
    expect(parsed.searchParams.get('utm_campaign')).toBe(JOB_COPY_UTM_CAMPAIGN);
  });

  it('leaves external or malformed URLs untouched', () => {
    expect(buildJobCopyAttributionUrl('https://example.com/jobs/radiologo')).toBe(
      'https://example.com/jobs/radiologo',
    );
    expect(buildJobCopyAttributionUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('buildJobCopyAttributionFromSelection', () => {
  it('attributes a selection inside the owning job card', () => {
    const scope = document.createElement('article');
    const selectedContent = document.createElement('p');
    selectedContent.textContent = 'Cerchiamo un radiologo esperto a Lugano.';
    scope.appendChild(selectedContent);
    document.body.appendChild(scope);

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(selectedContent);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(isSelectionWithinScope(selection, scope)).toBe(true);
    const clipboard = buildJobCopyAttributionFromSelection(selection, scope, {
      jobTitle: 'Radiologo/a',
      company: 'Ospedale X',
      url: URL,
      lead: LEAD,
    });

    expect(clipboard?.text).toContain(ATTRIBUTED_URL);
    expect(clipboard?.html).toContain('<br><br>');
  });

  it('does not attribute a qualifying selection outside the owning card', () => {
    const scope = document.createElement('article');
    const outside = document.createElement('p');
    outside.textContent = 'Cerchiamo un radiologo esperto a Lugano.';
    document.body.append(scope, outside);

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(outside);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(isSelectionWithinScope(selection, scope)).toBe(false);
    expect(
      buildJobCopyAttributionFromSelection(selection, scope, {
        jobTitle: 'Radiologo/a',
        url: URL,
        lead: LEAD,
      }),
    ).toBeNull();
  });
});
