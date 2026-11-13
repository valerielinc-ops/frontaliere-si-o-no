/**
 * Reviewer subagent for the Assisted Application drafting pipeline,
 * ported from the ai-job-search drafter-reviewer architecture (MIT).
 * Copyright (c) 2026 Mads Lorentzen.
 *
 * Runs an isolated review pass on the drafted application materials:
 * 1. Checks alignment with the target Swiss posting requirements.
 * 2. Enforces company angles from companyResearchService.
 * 3. Formulates Part A structured edits (JSON array of exact search-and-replace patches).
 * 4. Produces Part B narrative suggestions for tone and register.
 * 5. Applies valid patches deterministically via applyStructuredEdits.
 */

import { applyStructuredEdits } from './lib/applyStructuredEdits.js';
import { formatCompanyPromptContext } from './services/companyResearchService.js';

export const REVIEWER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    fitScore: {
      type: 'integer',
      description: 'Overall suitability score between 0 and 100 based on posting requirements',
    },
    structuredEdits: {
      type: 'array',
      description: 'Part A: Concrete search-and-replace edits the drafter can apply deterministically',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', enum: ['letter', 'cv'] },
          old_string: { type: 'string', description: 'Exact verbatim substring currently in the draft' },
          new_string: { type: 'string', description: 'Replacement string tailored to the posting/company' },
          reason: {
            type: 'string',
            enum: ['keyword_match', 'company_angle', 'action_reframing', 'style_fix', 'grounding_fix'],
          },
        },
        required: ['file', 'old_string', 'new_string', 'reason'],
        additionalProperties: false,
      },
    },
    narrativeSuggestions: {
      type: 'object',
      properties: {
        missedKeywords: { type: 'array', items: { type: 'string' } },
        companyAngles: { type: 'string', description: 'Strategic alignments identified with this Swiss company' },
        actionReframing: { type: 'string', description: 'Suggestions to make passive phrasing active and impact-focused' },
        toneAndStyle: { type: 'string', description: 'Feedback on formality, clarity, and cultural appropriateness' },
      },
      required: ['missedKeywords', 'companyAngles', 'actionReframing', 'toneAndStyle'],
      additionalProperties: false,
    },
    groundingAuditWarnings: {
      type: 'array',
      description: 'Any claims, metrics, or tools in the draft not supported by the candidate profile',
      items: { type: 'string' },
    },
  },
  required: ['fitScore', 'structuredEdits', 'narrativeSuggestions', 'groundingAuditWarnings'],
  additionalProperties: false,
};

/**
 * Builds the prompt for the Reviewer subagent.
 * @param {object} params
 * @param {object} params.profile - candidate profile
 * @param {string} params.postingText - cleaned posting text
 * @param {string} params.letterDraft - current cover letter draft
 * @param {string} [params.cvDraft] - current CV draft text
 * @param {object} [params.companyResearch] - company intelligence facts
 * @returns {{ systemPrompt: string, userText: string }}
 */
export function buildReviewerPrompt({
  profile,
  postingText,
  letterDraft,
  cvDraft = '',
  companyResearch = null,
}) {
  const companyContext = formatCompanyPromptContext(companyResearch);

  const systemPrompt = `You are a meticulous Swiss hiring manager proxy and executive career reviewer.
Your mission is to critique and refine a tailored job application (cover letter and CV) for a candidate applying in Switzerland.

Core Rules:
1. Grounding Rule (NON-NEGOTIABLE): Every date, title, tool, and metric MUST come from the candidate profile. NEVER suggest fabricating skills or experiences. If a requirement is missing, suggest honest gap-bridging ("competenza adiacente"), not false claims.
2. Part A Structured Edits: Propose concrete search-and-replace patches. "old_string" MUST be quoted verbatim from the drafts and MUST be unique in the text (include enough surrounding context).
3. Swiss Quality Standard: Tone must be professional, direct, active, and respectful of Swiss workplace standards. Avoid boastful buzzwords, passive cliches, or self-deprecating hedging.
4. Output MUST conform strictly to the specified JSON schema.`;

  const userText = `Candidate Profile:
${JSON.stringify({
  headline: profile?.headline,
  summary: profile?.summary,
  skills: profile?.skills,
  experience: profile?.experience?.map((e) => ({
    role: e.role,
    employer: e.employer,
    start: e.start,
    end: e.end,
    highlights: e.highlights,
  })),
  languages: profile?.languages,
}, null, 2)}

${companyContext ? `${companyContext}\n` : ''}
Job Posting:
${postingText}

--- CURRENT COVER LETTER DRAFT ---
${letterDraft}

${cvDraft ? `--- CURRENT CV DRAFT ---\n${cvDraft}\n` : ''}

Review the draft against the posting requirements and company intelligence.
Return the structured review with fitScore, Part A structuredEdits, narrativeSuggestions, and groundingAuditWarnings.`;

  return { systemPrompt, userText };
}

/**
 * Applies reviewer feedback to refine document drafts.
 * @param {object} params
 * @param {string} params.letterDraft
 * @param {string} [params.cvDraft='']
 * @param {object} params.reviewerOutput - output conforming to REVIEWER_OUTPUT_SCHEMA
 * @returns {{
 *   revisedLetter: string,
 *   revisedCv: string,
 *   appliedCount: number,
 *   rejectedCount: number,
 *   reviewSummary: object,
 * }}
 */
export function applyReviewerRefinement({
  letterDraft,
  cvDraft = '',
  reviewerOutput,
}) {
  const letterEdits = (reviewerOutput?.structuredEdits || []).filter((e) => e.file === 'letter');
  const cvEdits = (reviewerOutput?.structuredEdits || []).filter((e) => e.file === 'cv');

  const letterResult = applyStructuredEdits(letterDraft, letterEdits);
  const cvResult = cvDraft ? applyStructuredEdits(cvDraft, cvEdits) : { updatedText: cvDraft, applied: [], rejected: [] };

  return {
    revisedLetter: letterResult.updatedText,
    revisedCv: cvResult.updatedText,
    appliedCount: letterResult.applied.length + cvResult.applied.length,
    rejectedCount: letterResult.rejected.length + cvResult.rejected.length,
    reviewSummary: {
      fitScore: reviewerOutput?.fitScore || 0,
      appliedEdits: [...letterResult.applied, ...cvResult.applied],
      rejectedEdits: [...letterResult.rejected, ...cvResult.rejected],
      narrativeSuggestions: reviewerOutput?.narrativeSuggestions || null,
      groundingAuditWarnings: reviewerOutput?.groundingAuditWarnings || [],
    },
  };
}
