import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeJobPostingUrl,
  canonicalJobQuestionCacheKey,
  JOB_QUESTION_CACHE_TTL_MS,
  loadCachedJobQuestions,
  mergePreharvestedQuestions,
  parsePublicAtsPosting,
  preharvestPublicAtsQuestions,
  sanitizeQuestionsForCache,
  saveCachedJobQuestions,
} from '../scripts/assisted-application/lib/preharvest.mjs';
import { platformCandidateFacts } from '../functions/src/assistedApplicationPlatformDefaults.js';

describe('preharvest ATS questions & job question cache', () => {
  it('canonicalizes job URLs by stripping tracking query params and hash', () => {
    const a = canonicalizeJobPostingUrl('https://boards.greenhouse.io/acme/jobs/12345?utm_source=linkedin&gh_jid=99#apply');
    const b = canonicalizeJobPostingUrl('https://boards.greenhouse.io/acme/jobs/12345?gh_jid=99');
    expect(a).toBe('https://boards.greenhouse.io/acme/jobs/12345?gh_jid=99');
    expect(a).toBe(b);
    expect(canonicalJobQuestionCacheKey(a)).toBe(canonicalJobQuestionCacheKey(b));
  });

  it('recognizes Greenhouse, Lever, and SmartRecruiters public ATS endpoints', () => {
    expect(parsePublicAtsPosting('https://boards.greenhouse.io/sonarsource/jobs/4421999')).toEqual({
      provider: 'greenhouse',
      apiUrl: 'https://boards-api.greenhouse.io/v1/boards/sonarsource/jobs/4421999?questions=true',
    });
    expect(parsePublicAtsPosting('https://jobs.lever.co/acme/abc-123')).toEqual({
      provider: 'lever',
      apiUrl: 'https://api.lever.co/v0/postings/acme/abc-123',
    });
    expect(parsePublicAtsPosting('https://jobs.smartrecruiters.com/Roche/744000123')).toEqual({
      provider: 'smartrecruiters',
      apiUrl: 'https://api.smartrecruiters.com/v1/companies/Roche/postings/744000123',
    });
  });

  it('extracts custom Greenhouse questions while skipping standard identity/resume fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        questions: [
          { label: 'First Name', required: true, fields: [{ type: 'input_text' }] },
          { label: 'Email', required: true, fields: [{ type: 'input_text' }] },
          {
            label: 'Are you authorized to work in Switzerland?',
            required: true,
            fields: [{ type: 'multi_value_single_select', values: [{ label: 'Yes' }, { label: 'No' }] }],
          },
          {
            label: 'Notice period',
            required: true,
            fields: [{ type: 'input_text' }],
          },
        ],
      }),
    });
    const questions = await preharvestPublicAtsQuestions('https://boards.greenhouse.io/acme/jobs/12345', { fetchImpl });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      question: 'Are you authorized to work in Switzerland?',
      type: 'choice',
      options: ['Yes', 'No'],
      required: true,
    });
    expect(questions[1]).toMatchObject({
      question: 'Notice period',
      type: 'text',
      required: true,
    });
  });

  it('excludes security/password/captcha questions from cache and deduplicates merged questions', async () => {
    const sanitized = sanitizeQuestionsForCache([
      { id: 'q1', question: 'Do you speak French?', type: 'choice', options: ['Yes', 'No'] },
      { id: 'sec1', question: 'Question 1 Answer', section: 'Security questions', type: 'text' },
      { id: 'cap1', question: 'Digita il testo sotto l immagine captcha', type: 'text' },
    ]);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].question).toBe('Do you speak French?');

    const store = new Map();
    const fakeDb = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
          set: async (val: unknown) => { store.set(id, val); },
        }),
      }),
    };
    const saved = await saveCachedJobQuestions(fakeDb, 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420', sanitized);
    expect(saved).toBe(true);
    const loaded = await loadCachedJobQuestions(fakeDb, 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420');
    expect(loaded).toHaveLength(1);

    const stale = await loadCachedJobQuestions(
      {
        collection: () => ({
          doc: () => ({
            get: async () => ({
              exists: true,
              data: () => ({ questions: sanitized, updatedAt: 1_000 }),
            }),
          }),
        }),
      },
      'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420',
      { nowMs: 1_000 + JOB_QUESTION_CACHE_TTL_MS + 1 },
    );
    expect(stale).toEqual([]);

    const merged = mergePreharvestedQuestions(
      [{ id: 'existing', question: 'Do you speak French?' }],
      [...loaded, { id: 'new_q', question: 'Available start date?' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((q) => q.question)).toEqual(['Do you speak French?', 'Available start date?']);
  });

  it('preserves portal metadata in cache and deduplicates duplicate question ids across cached and live portal entries', async () => {
    const cached = sanitizeQuestionsForCache([
      {
        id: 'portal_what_is_your_marital_status_b4j4zh_19o61vi',
        source: 'portal',
        question: 'Qual è il tuo stato civile?*',
        applicationQuestion: 'What is your Marital Status?*',
        type: 'choice',
        options: ['Celibe/nubile (Svizzera)', 'Coniugato/a (Svizzera)'],
        applicationOptions: ['Single (Switzerland)', 'Married (Switzerland)'],
        context: 'Marital Status · What is your Marital Status?*',
        addressContext: { section: 'Marital Status', owners: ['Marital Status'], unknown: false },
      },
    ]);
    expect(cached[0]).toMatchObject({
      source: 'portal',
      context: 'Marital Status · What is your Marital Status?*',
      addressContext: { section: 'Marital Status', owners: ['Marital Status'], unknown: false },
    });

    const { dedupePortalQuestions } = await import('../scripts/assisted-application/lib/portal/portal.mjs');
    const deduped = dedupePortalQuestions([
      { id: 'portal_q1', question: 'Stato civile', options: ['Coniugato/a'] },
      { id: 'portal_q1', source: 'portal', question: 'Qual è il tuo stato civile?*', options: ['Sposato/a'], optionMap: [{ candidate: 'Sposato/a', application: 'Married' }] },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ id: 'portal_q1', source: 'portal', options: ['Sposato/a'] });
  });

  it('applies uploaded candidateFacts noticePeriod and salaryExpectation to platformCandidateFacts', () => {
    const defaults = platformCandidateFacts({
      order: {
        orderId: 'testOrder1',
        candidateFacts: {
          workPermit: 'permit_g',
          passport: 'eu_efta',
          nationality: 'italiana',
          criminalRecord: 'no',
          debtRecord: 'no',
          noticePeriod: '1_month',
          salaryExpectation: '85,000 CHF',
        },
      },
      profile: { location: 'Como, IT' },
      identity: { name: 'Mario Rossi', firstName: 'Mario' },
      locale: 'it',
    });
    expect(defaults.noticeMonths).toBe(1);
    expect(defaults.salary?.annual).toBe(85000);
  });

  it('recognizes PinpointHQ postings and extracts unconditional screening questions from HTML', async () => {
    const postingUrl = 'https://example-hotel.pinpointhq.com/en/postings/c570608c-e27d-47f1-8e91-1e9b6d16a27e';
    expect(parsePublicAtsPosting(postingUrl)).toEqual({
      provider: 'pinpoint',
      apiUrl: `${postingUrl}/applications/new`,
    });

    const q1 = JSON.stringify({
      questionDetails: { title: 'What is your level of German?', questionType: 'multiple_choice', required: true },
      options: [{ label: 'Elementary (A1/A2)' }, { label: 'Intermediate (B1/B2)' }],
      conditionalQuestionParentQuestionId: null,
    }).replace(/"/g, '&quot;');
    const q2 = JSON.stringify({
      questionDetails: { title: 'Are you currently an employee?', questionType: 'boolean', required: true },
      options: [],
      conditionalQuestionParentQuestionId: null,
    }).replace(/"/g, '&quot;');
    const q3Conditional = JSON.stringify({
      questionDetails: { title: 'Have you informed your HR representative?', questionType: 'multiple_choice', required: true },
      options: [{ label: 'Yes' }, { label: 'No' }],
      conditionalQuestionParentQuestionId: 1127735,
    }).replace(/"/g, '&quot;');

    const html = `
      <div data-component-name="Shared::Form::Questions::Singleselect">${q1}</div>
      <div data-component-name="Shared::Form::Questions::Boolean">${q2}</div>
      <div data-component-name="Shared::Form::Questions::Singleselect">${q3Conditional}</div>
    `;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => html });
    const questions = await preharvestPublicAtsQuestions(postingUrl, { fetchImpl });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      question: 'What is your level of German?',
      type: 'choice',
      options: ['Elementary (A1/A2)', 'Intermediate (B1/B2)'],
      required: true,
    });
    expect(questions[1]).toMatchObject({
      question: 'Are you currently an employee?',
      type: 'boolean',
      required: true,
    });
  });
});
