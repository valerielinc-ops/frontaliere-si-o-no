import { describe, expect, it } from 'vitest';
import {
  resetDocumentUploadState,
  successFactorsFilledSlotKind,
  uploadButtonCandidatesFor,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { optionFailureDiagnostics } from '../scripts/assisted-application/lib/portal/fill.mjs';

// SuccessFactors «My Documents» (Damiani, career55.sapsf.eu, 2026-11-28): the CV of an earlier run sits in its slot
// with «Edit document <file> Opens a dialog», the letter slot was emptied and reads «Attach a Cover Letter». The run
// stopped as `previous_file_replacement_unavailable` (the page's done mark and tries belonged to the file taken
// away) and `trigger_not_found` for the CV. Synthetic names, no candidate data.
const OLD_CV = 'CV_Draft_Example.pdf';
const page = [
  { id: 'b1', text: 'GROUP', chrome: true },
  { id: 'b2', text: 'My Documents' },
  { id: 'b3', text: `${OLD_CV} (11/27/2026)` },
  { id: 'b4', text: `* Curriculum Vitae Edit document ${OLD_CV} Opens a dialog` },
  { id: 'b5', text: 'Cover Letter Attach a Cover Letter Opens a dialog' },
];

describe('a document slot that already holds a file', () => {
  it('names the held slot by its caption, never an empty or removal slot', () => {
    expect(successFactorsFilledSlotKind(page[3])).toBe('cv');
    expect(successFactorsFilledSlotKind({ text: 'Cover Letter Edit document Letter.pdf Opens a dialog' })).toBe('cover_letter');
    expect(successFactorsFilledSlotKind(page[4])).toBe('');
    expect(successFactorsFilledSlotKind({ text: 'Cover Letter Delete document Letter.pdf Opens a dialog' })).toBe('');
    expect(successFactorsFilledSlotKind({ text: 'Other attachments Edit document x.pdf Opens a dialog' })).toBe('');
  });

  it('is an upload trigger only when the run asks to replace the held file', () => {
    const snapshot = { fields: [], buttons: page };
    expect(uploadButtonCandidatesFor(snapshot, 'cv')).toEqual([]);
    expect(uploadButtonCandidatesFor(snapshot, 'cv', { replaceHeld: true }).map((b: any) => b.id)).toEqual(['b4']);
  });

  it('finds the emptied letter slot as an ordinary upload trigger', () => {
    expect(uploadButtonCandidatesFor({ fields: [], buttons: page }, 'cover_letter').map((b: any) => b.id)).toEqual(['b5']);
  });

  it('clears the done mark and the spent tries of the replaced document only', () => {
    const url = 'https://career55.sapsf.eu/portalcareer?jobId=1';
    const deleted: string[] = [];
    const done: any = new Set<string>();
    const tries: any = new Map<string, number>();
    const origDone = done.delete.bind(done);
    done.delete = (key: string) => { deleted.push(`done:${key}`); return origDone(key); };
    const origTries = tries.delete.bind(tries);
    tries.delete = (key: string) => { deleted.push(`tries:${key}`); return origTries(key); };
    resetDocumentUploadState(url, ['cover_letter', 'unknown'], done, tries);
    expect(deleted).toHaveLength(2);
    expect(deleted.every((entry) => entry.includes('cover-letter|'))).toBe(true);
    deleted.length = 0;
    resetDocumentUploadState(url, ['cv'], done, tries);
    expect(deleted.every((entry) => entry.includes(':cv|'))).toBe(true);
    expect(deleted).toHaveLength(2);
  });
});

describe('a failed choice', () => {
  it('reports the control and what the page offered, not the answer', () => {
    const field = { id: 'f39', label: '* Education   Level', kind: 'combobox', options: [{ label: 'Bachelor' }, { label: 'Master' }] };
    expect(optionFailureDiagnostics(field)).toEqual({
      label: '* Education Level', kind: 'combobox', optionCount: 2, offered: ['Bachelor', 'Master'],
    });
    expect(optionFailureDiagnostics({ id: 'f1', label: 'State', kind: 'combobox' }).optionCount).toBe(0);
  });
});
