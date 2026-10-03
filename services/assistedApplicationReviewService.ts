/**
 * Client of the candidate review page of the automated assisted application
 * (functions/src/assistedApplicationReview.js). The signed token from the
 * review e-mail is the only credential: no Firebase login is involved.
 */

import { ASSISTED_APPLICATION_REVIEW_URL } from './functionsBase';

export type ReviewAction = 'approve' | 'reject' | 'answers' | 'confirm_submitted' | 'cv_choice' | 'edit' | 'followup_send' | 'followup_skip'
  | 'document_upload' | 'document_remove' | 'document_waive' | 'photo_upload' | 'photo_remove' | 'cv_lines';

/** The candidate's choice for one line of the tailored CV (functions/src/assistedApplicationReview.js cvChangesView). */
export interface ReviewCvLineChoice {
  use: 'adapted' | 'original' | 'own';
  text?: string;
}

/** What the tailored CV changed: the summary and each rewritten line beside the CV's own line. */
export interface ReviewCvChanges {
  summary: ReviewCvLine | null;
  roles: Array<{ title: string; employer: string; lines: ReviewCvLine[] }>;
}

export interface ReviewCvLine {
  id: string;
  adapted: string;
  /** The CV's own line it rewrites ('' when it rewrites none). */
  original: string;
  use: ReviewCvLineChoice['use'];
  text: string;
}

/** A document the posting asks for besides the CV and the letter (functions/src/assistedApplicationExtraDocuments.js). */
export interface ReviewDocument {
  id: string;
  /** As the posting names it. */
  label: string;
  kind: string;
  /** Words printed on such a document: the browser's check looks for them. */
  keywords: string[];
  required: boolean;
  /** The posting's own words asking for it. */
  quote: string;
  files: Array<{
    id: string;
    name: string;
    size: number;
    detectedType: string | null;
    uploadedAt: number | null;
    clientCheck: { verdict: 'match' | 'mismatch' | 'looks_like_cv' | 'unreadable'; matched: string };
  }>;
  /** The candidate chose to send without it. */
  waived: boolean;
}

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
  /** Proposed start date shown in the empty field (saved only by the candidate). */
  suggested?: string | null;
  /** The rule checked as the candidate types (functions/src/lib/answerRules.js). */
  validation?: {
    pattern: string;
    minLength: number;
    maxLength: number;
    min: number | null;
    max: number | null;
    minDate: '' | 'today';
    example: string;
    message: string;
  } | null;
}

/** A decisive requirement of the posting the CV does not show (functions/src/assistedApplicationFitNotice.js). */
export interface ReviewFitGap {
  /** Short, in Italian (the language of the analysis). */
  requirement: string;
  /** The posting’s own words ('' when the requirement was inferred). */
  quote: string;
  importance: 'critical' | 'high';
  status: 'missing' | 'partial';
}

export interface ReviewFitNotice {
  /** low: a must-have is clearly missing; partial: some requirements do not show. */
  level: 'low' | 'partial';
  gaps: ReviewFitGap[];
}

/** A proposed form field (functions/src/assistedApplicationCandidateEdits.js). */
export interface ReviewFormField {
  key: string;
  label: string;
  value: string;
  editable?: boolean;
  /** Why it cannot be changed here: the alias address, or a question that asks it. */
  locked?: 'alias' | 'question' | null;
  required?: boolean;
  /** Printed in the letter header (shown for e-mail applications too). */
  inLetter?: boolean;
  validation?: ReviewQuestion['validation'];
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
  formAnswers: ReviewFormField[];
  /** Letter and e-mail lengths accepted by an edit. */
  editLimits?: Record<'coverLetterText' | 'emailSubject' | 'emailBody', { min: number; max: number }>;
  /** When the candidate last saved their own changes. */
  editedAt?: number | null;
  questions: ReviewQuestion[];
  /** The posting’s decisive requirements the CV does not show, said above the questions (null: a full match). */
  fit?: ReviewFitNotice | null;
  answers: Record<string, string>;
  /** School reports, test results… the posting requires besides the CV and the letter. */
  documents?: ReviewDocument[];
  documentLimits?: { maxBytes: number; maxFiles: number };
  feedback: Array<{ round: number; text: string }>;
  /** The tailored ATS CV, sent unless the candidate chooses their original. */
  tailoredCv: {
    url: string | null;
    choice: 'tailored' | 'original' | 'inplace';
    /** The candidate's optional photo is on the tailored CV. */
    photo?: boolean;
    /** Customary in German-speaking Switzerland ("recommended"), optional elsewhere. */
    photoAdvice?: 'recommended' | 'optional';
    photoMaxBytes?: number;
    changes?: ReviewCvChanges | null;
    /** Phase 5: the candidate's own Word file with the adapted lines (null when there is none). */
    inplace?: { url: string | null; patched: number; kept: number } | null;
    /** The candidate's line choices changed the Word file: it comes back when they match the checked layout. */
    inplaceNeedsPageCheck?: boolean;
  } | null;
  ats: { original: ReviewAtsView | null; tailored: ReviewAtsView | null } | null;
  can: { approve: boolean; reject: boolean; answer: boolean; confirmSubmitted: boolean; chooseCv?: boolean; edit?: boolean; uploadDocuments?: boolean; uploadPhoto?: boolean; reviewCvLines?: boolean };
}

export interface ReviewAtsView {
  grade: string | null;
  keywordCoverage: number | null;
  missing: string[];
}

export class ReviewRequestError extends Error {
  constructor(public readonly code: string, public readonly fields: Record<string, string> = {}) {
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
  if (!response.ok || !data?.ok) {
    const fields = data?.fields && typeof data.fields === 'object' ? data.fields as Record<string, string> : {};
    throw new ReviewRequestError(String(data?.error || `http_${response.status}`), fields);
  }
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
  extra: {
    feedback?: string;
    answers?: Record<string, string>;
    cvChoice?: string;
    documentId?: string;
    fileName?: string;
    contentBase64?: string;
    clientCheck?: { verdict: string; matched: string };
    fileId?: string;
    waive?: boolean;
  } = {},
): Promise<{ ok: true; state: string }> {
  return parse(await fetch(ASSISTED_APPLICATION_REVIEW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: token, action, ...extra }),
  }));
}
