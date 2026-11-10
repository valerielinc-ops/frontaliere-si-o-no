import { describe, expect, it } from 'vitest';
import { earlierCvHeld, pageControls } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { applicationStage } from '../scripts/assisted-application/lib/portal/stages.mjs';

// SuccessFactors «/portalcareer» (Damiani, career55.sapsf.eu, run 42880830762, 2026-11-10): the complete
// application form, every required field filled and no error, «Save» and «Apply» at the bottom. The CV is the one
// an earlier run of the order left in «My Documents» (kept, `keptEarlier: ["cv"]`), the «Job-Specific Information»
// section asks nothing. The stage guard found no CV uploaded by this run and no job question: «unknown_apply»,
// handoff `application_stage_unknown` before the final Apply. Synthetic names, no candidate data.
const CV = 'CV_Example_Candidate.pdf';
const LETTER = 'Cover_Letter_Example_Candidate.pdf';
const URL = 'https://career.example-sf.test/portalcareer?_s.crb=abc123';
const APPLY_URL = 'https://career.example-sf.test/career?career_ns=job_listing&company=example&career_job_req_id=1745';
const FORM = 'applyForm';

const buttons = [
  { id: 'b1', text: 'GROUP', chrome: true },
  { id: 'b2', text: 'Options', chrome: true },
  { id: 'b3', text: 'My Documents', formId: FORM },
  { id: 'b4', text: `${CV} (11/10/2026)`, formId: FORM },
  { id: 'b5', text: `* Curriculum Vitae Edit document ${CV} Opens a dialog`, formId: FORM },
  { id: 'b6', text: `${LETTER} (11/10/2026)`, formId: FORM },
  { id: 'b7', text: `Cover Letter Delete document ${LETTER} Opens a dialog`, formId: FORM },
  { id: 'b8', text: 'Job-Specific Information', formId: FORM },
  { id: 'b9', text: 'View Profile', formId: FORM },
  { id: 'b10', text: 'Save', formId: FORM },
  { id: 'b11', text: 'Apply', formId: FORM },
];
const fields = [
  { id: 'f1', label: '* First Name', kind: 'text', inputType: 'text', formId: FORM, value: 'Ada' },
  { id: 'f2', label: '* Last Name', kind: 'text', inputType: 'text', formId: FORM, value: 'Example' },
  { id: 'f3', label: '* Email', kind: 'text', inputType: 'text', formId: FORM, value: 'ada@example.test' },
  { id: 'f4', label: '* Education Level', kind: 'combobox', formId: FORM, value: 'High School diploma' },
];
const text = 'IT Support Administrator (1745) My Documents Curriculum Vitae Cover Letter Profile Information '
  + 'Please complete your personal information. Education Work Experience Job-Specific Information View Profile Save Apply';
const form = (uploadedCv: boolean, formFields = fields) => ({ url: URL, buttons, fields: formFields, text, uploadedCv });
const context = { applyUrl: APPLY_URL, job: { title: 'IT Support Administrator' } };

describe('a complete SuccessFactors form whose CV an earlier run of the order left in its slot', () => {
  it('was an unknown stage without the kept CV (the stop of run 42880830762)', () => {
    expect(applicationStage(form(false), { ...context, url: URL }).kind).toBe('unknown_apply');
  });

  it('is the application form once the kept CV counts, and its Apply is the final send', () => {
    expect(earlierCvHeld(buttons, [CV], true)).toBe(true);
    const snapshot = form(earlierCvHeld(buttons, [CV], true));
    expect(applicationStage(snapshot, { ...context, url: URL }).kind).toBe('form');
    const controls = pageControls(buttons, {}, URL, { snapshot, ...context });
    expect(controls.submit?.id).toBe('b11');
    expect(controls.next).toBeFalsy();
  });

  it('never counts a CV this run did not keep on this page, another file, or a name in the page chrome', () => {
    expect(earlierCvHeld(buttons, [CV], false)).toBe(false);
    expect(earlierCvHeld(buttons, ['CV_Someone_Else.pdf'], true)).toBe(false);
    expect(earlierCvHeld(buttons, [], true)).toBe(false);
    expect(earlierCvHeld(buttons, [''], true)).toBe(false);
    expect(earlierCvHeld([{ id: 'c', text: `Recently viewed ${CV}`, chrome: true }], [CV], true)).toBe(false);
    // A cover letter kept under the CV's file name is no CV (review of #18007).
    const letterOnly = [{ id: 'l', text: 'Cover Letter Edit document resume.pdf Opens a dialog' }];
    expect(earlierCvHeld(letterOnly, ['resume.pdf'], true)).toBe(false);
    expect(applicationStage({ ...form(earlierCvHeld(letterOnly, ['resume.pdf'], true)), buttons: [...buttons.filter((b: any) => !/curriculum/i.test(b.text || '')), ...letterOnly] }, { ...context, url: URL }).kind).toBe('unknown_apply');
    expect(earlierCvHeld([{ id: 'r', text: 'Curriculum Vitae Edit document resume.pdf Opens a dialog' }], ['resume.pdf'], true)).toBe(true);
  });

  it('a kept CV alone does not make a page without the applicant’s own fields a form to send', () => {
    const profileSummary = form(true, [{ id: 'g1', label: 'Language', kind: 'combobox', formId: FORM, value: 'English' }]);
    expect(applicationStage(profileSummary, { ...context, url: URL }).kind).toBe('unknown_apply');
    const controls = pageControls(buttons, {}, URL, { snapshot: profileSummary, ...context });
    expect(controls.submit).toBeFalsy();
  });
});
