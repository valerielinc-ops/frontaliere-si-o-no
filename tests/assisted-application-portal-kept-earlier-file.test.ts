import { describe, expect, it } from 'vitest';
import { ownEarlierFileShown, removalsOf } from '../scripts/assisted-application/lib/portal/portal.mjs';

// SuccessFactors «My Documents» (Damiani, career55.sapsf.eu, 2026-11-10): the CV
// an earlier run of the order uploaded stays in its slot under the run's own
// file name, with «Edit document» and no remove control. The runner handed the
// page over as `previous_file_not_removable`. Synthetic names, no candidate data.
const CV = 'CV_Example_Candidate.pdf';
const LETTER = 'Lettera_di_presentazione_Example_Candidate.pdf';
const myDocuments = [
  { id: 'b1', text: 'GROUP', chrome: true },
  { id: 'b2', text: 'My Documents' },
  { id: 'b3', text: `${CV} (11/10/2026)` },
  { id: 'b4', text: `* Curriculum Vitae Edit document ${CV} Opens a dialog` },
  { id: 'b5', text: 'Other attachments Add a Document Opens a dialog' },
  { id: 'b6', text: 'Apply' },
];

describe('an earlier run’s file in a slot that cannot be emptied', () => {
  it('is our document when a file control of the page carries this run’s own name', () => {
    expect(removalsOf(myDocuments, [CV])).toEqual([]);
    expect(ownEarlierFileShown(myDocuments, [CV])).toBe(true);
  });

  it('is not ours by a name quoted in the page chrome, another file, or no name at all', () => {
    expect(ownEarlierFileShown(myDocuments, [LETTER])).toBe(false);
    expect(ownEarlierFileShown(myDocuments, [''])).toBe(false);
    expect(ownEarlierFileShown([{ id: 'c', text: `Recently viewed ${CV}`, chrome: true }], [CV])).toBe(false);
    expect(ownEarlierFileShown(undefined as any, [CV])).toBe(false);
  });

  it('leaves a removable earlier file to the removal path', () => {
    const removable = [...myDocuments, { id: 'b7', text: `Remove ${CV}` }];
    expect(removalsOf(removable, [CV]).map((button: any) => button.id)).toEqual(['b7']);
  });
});
