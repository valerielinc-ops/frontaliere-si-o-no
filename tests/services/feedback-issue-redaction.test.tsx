/**
 * The feedback form must not publish personal data to a PUBLIC GitHub issue
 * (issue #5196, sink missed by the original eleven-destination inventory).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `redact-pii.test.ts`.
 *
 * That file proves the redactor recognises personal data. This one proves the
 * redactor is actually WIRED to this sink — which is the failure mode #5196 is
 * made of. `redactPersonalData` existed and was correct for months while this
 * form kept posting raw text, because nothing connected the two and no test
 * looked at the payload. So the assertions here are on the bytes handed to
 * `fetch`, not on the redactor's return value.
 *
 * The destination is what makes it worth its own file: `createFeedbackIssue`
 * opens an issue on a public repository. Unlike an analytics event, that cannot
 * be un-published — it is readable, indexed and mirrored from the moment it is
 * created.
 *
 * Every fixture is invented. The shapes (Italian full name, `gg/mm/aaaa` date
 * of birth, Italian street-first address) are the ones the incident had.
 */
import React from 'react';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import { FeedbackSection } from '@/components/community/FeedbackSection';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'it' as const }),
}));

vi.mock('../../services/recaptchaService', () => ({
  default: { executeRecaptcha: vi.fn(async () => 'test-recaptcha-token') },
}));

/** Records every request body sent to the public issue-creation endpoint. */
const issuePayloads: Array<{ title: string; description: string }> = [];
/** Records every prompt sent to the Gemini rewrite endpoint. */
const geminiPrompts: string[] = [];

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  issuePayloads.length = 0;
  geminiPrompts.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Mount-time read of the public issue list.
    if (url.includes('api.github.com')) return jsonResponse([]);
    if (url.includes('geminiGenerate')) {
      geminiPrompts.push(JSON.parse(String(init?.body ?? '{}')).userPrompt ?? '');
      return jsonResponse({ ok: true, text: 'riscrittura' });
    }
    if (url.includes('createFeedbackIssue')) {
      issuePayloads.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonResponse({
        ok: true,
        issue: { id: '1', title: 't', body: 'b', author: 'a', url: 'https://example.test/1' },
      });
    }
    return jsonResponse({});
  }));
  vi.stubGlobal('alert', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** The incident shape, invented: full name + date of birth + street address. */
const RAW_TITLE = 'Errore nel calcolo per Marco Bernasconi';
const RAW_BODY =
  'Mi chiamo Marco Bernasconi, sono nato il 22/02/1988 e abito in Via alla Stampa 11B, 6965 Cadro. ' +
  'Scrivetemi a marco.bernasconi@example.com oppure allo 091/123 45 67. Il calcolatore mi dà un netto sbagliato.';

async function fillAndSubmit() {
  await act(async () => {
    render(<FeedbackSection />);
  });
  const titleField = document.getElementById('feedback-title') as HTMLInputElement;
  const bodyField = document.getElementById('feedback-details') as HTMLTextAreaElement;
  expect(titleField, 'title field not found').toBeTruthy();
  expect(bodyField, 'description field not found').toBeTruthy();

  await act(async () => {
    fireEvent.change(titleField, { target: { value: RAW_TITLE } });
    fireEvent.change(bodyField, { target: { value: RAW_BODY } });
  });
  const form = document.querySelector('form') as HTMLFormElement;
  await act(async () => {
    fireEvent.submit(form);
  });
  await waitFor(() => expect(issuePayloads.length).toBe(1));
  return issuePayloads[0];
}

describe('the feedback form redacts before opening a public issue', () => {
  it('publishes no fragment of the name, date of birth, address, email or phone', async () => {
    const sent = await fillAndSubmit();
    const wire = `${sent.title}\n${sent.description}`;

    for (const leak of [
      'Bernasconi',
      '22/02/1988',
      'Via alla Stampa',
      '11B',
      'Cadro',
      'marco.bernasconi@example.com',
      '091/123 45 67',
    ]) {
      expect(wire, `published "${leak}" to a public issue`).not.toContain(leak);
    }
  });

  it('redacts the TITLE as well as the body', async () => {
    // The title is the part that shows in the issue list, in search engine
    // results and in every notification email — redacting only the body would
    // leave the most visible copy in clear.
    const sent = await fillAndSubmit();
    expect(sent.title).not.toContain('Bernasconi');
    expect(sent.title).toContain('[name]');
  });

  it('keeps the report readable — the actual defect survives', async () => {
    // Over-redaction is the safe direction, but a report that says nothing is
    // not a report. The sentence describing the bug must come through.
    const sent = await fillAndSubmit();
    expect(sent.description).toContain('calcolatore');
    expect(sent.description).toContain('netto sbagliato');
  });

  it('redacts before the Gemini rewrite too, not only before publication', async () => {
    // The rewrite is cosmetic, so it costs nothing to run it on redacted text —
    // and doing so removes one more third-party copy of the raw report.
    await act(async () => {
      render(<FeedbackSection />);
    });
    const bodyField = document.getElementById('feedback-details') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(bodyField, { target: { value: RAW_BODY } });
    });
    const target = screen
      .getAllByRole('button')
      .find((b) => /AI Help/i.test(b.textContent || ''));
    expect(target, 'AI optimise button not found').toBeTruthy();

    await act(async () => {
      fireEvent.click(target as HTMLElement);
    });
    await waitFor(() => expect(geminiPrompts.length).toBe(1));
    expect(geminiPrompts[0]).not.toContain('Bernasconi');
    expect(geminiPrompts[0]).not.toContain('22/02/1988');
    expect(geminiPrompts[0]).toContain('[name]');
  });
});
