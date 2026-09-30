/**
 * Client of the candidate review page of the automated assisted application
 * (functions/src/assistedApplicationReview.js). The signed token from the
 * review e-mail is the only credential: no Firebase login is involved.
 */

import { ASSISTED_APPLICATION_REVIEW_URL } from './functionsBase';

export type ReviewAction = 'approve' | 'reject' | 'answers' | 'confirm_submitted' | 'cv_choice' | 'followup_send' | 'followup_skip';

/** A follow-up to the employer waiting for the candidate (af1 link). */
export interface FollowupPayload {
  ok: true;
  kind: 'followup';
  n: number;
  of: number;
  state: 'awaiting_candidate' | 'sent' | 'stopped' | string;
  locale: string;
  deadlineAt: number | null;
  body: string;
  job: { title: string; company: string };
  can: { send: boolean; skip: boolean };
}

export interface ReviewQuestion {
  id: string;
  question: string;
  why: string;
  type: 'text' | 'yes_no' | 'choice' | 'number' | 'date';
  options: string[];
  required: boolean;
  /** Earliest accepted date (YYYY-MM-DD) for a start-date question, else null. */
  minDate?: string | null;
}

export interface ReviewPayload {
  ok: true;
  stale: boolean;
  /** The link's round was just sent back: its next version is being prepared. */
  preparingNext?: boolean;
  state: string;
  round: number;
  roundsLeft: number;
  deadlineAt: number | null;
  locale: string;
  job: {
    title: string;
    company: string;
    jobUrl: string;
    applyUrl: string;
    channel: string | null;
    channelLabel: string | null;
  };
  ready: boolean;
  coverLetter: { subject: string; text: string } | null;
  coverLetterUrl: string | null;
  applicationEmail: { to: string; subject: string; body: string } | null;
  formAnswers: Array<{ key: string; label: string; value: string }>;
  questions: ReviewQuestion[];
  answers: Record<string, string>;
  feedback: Array<{ round: number; text: string }>;
  /** The tailored ATS CV, sent unless the candidate chooses their original. */
  tailoredCv: { url: string | null; choice: 'tailored' | 'original' } | null;
  ats: { original: ReviewAtsView | null; tailored: ReviewAtsView | null } | null;
  can: { approve: boolean; reject: boolean; answer: boolean; confirmSubmitted: boolean; chooseCv?: boolean };
}

export interface ReviewAtsView {
  grade: string | null;
  keywordCoverage: number | null;
  missing: string[];
}

export class ReviewRequestError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// ar1 = review of the application, af1 = a follow-up to approve.
const TOKEN_RE = /^a[rf]1\.[A-Za-z0-9_-]{6,128}\.\d{1,2}\.[0-9a-z]{1,12}\.[0-9a-f]{32}$/;

/** The review token from the current URL, or null. */
export function readReviewToken(search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
  const value = new URLSearchParams(search).get('assisted_application_review');
  return value && TOKEN_RE.test(value) ? value : null;
}

async function parse(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new ReviewRequestError(String(data?.error || `http_${response.status}`));
  return data;
}

export async function fetchReview(token: string): Promise<ReviewPayload | FollowupPayload> {
  const url = new URL(ASSISTED_APPLICATION_REVIEW_URL);
  url.searchParams.set('t', token);
  return parse(await fetch(url.toString(), { method: 'GET' })) as Promise<ReviewPayload | FollowupPayload>;
}

export async function sendReviewAction(
  token: string,
  action: ReviewAction,
  extra: { feedback?: string; answers?: Record<string, string>; cvChoice?: string } = {},
): Promise<{ ok: true; state: string }> {
  return parse(await fetch(ASSISTED_APPLICATION_REVIEW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: token, action, ...extra }),
  }));
}
