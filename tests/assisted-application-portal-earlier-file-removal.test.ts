import { describe, expect, it } from 'vitest';
import {
  confirmRemovalInPage,
  isFileRemovalConfirmation,
  MAX_REMOVAL_CONFIRMATIONS,
  noSecondUploadPlace,
  ownEarlierFileShown,
  removalsOf,
  removeEarlierFile,
  successFactorsDocumentSlotKind,
  uploadButtonCandidatesFor,
} from '../scripts/assisted-application/lib/portal/portal.mjs';

// SuccessFactors «My Documents» (Damiani, career55.sapsf.eu, run 42849689238, 2026-11-10): the CV of an earlier
// run of the order sits in its slot with «Edit document», the cover letter of that run with «Delete document …
// Opens a dialog». The runner took the delete slot for the letter's upload slot (three clicks), then clicked it as
// a removal: SuccessFactors asked for confirmation, no browser-dialog listener answered (Playwright dismisses), the
// letter stayed and the run stopped as `previous_file_removal_unconfirmed`. Synthetic names, no candidate data.
const CV = 'CV_Example_Candidate.pdf';
const LETTER = 'Lettera_di_presentazione_Example_Candidate.pdf';
const OTHER = 'Certificate_Someone_Else.pdf';
const myDocuments = [
  { id: 'b1', text: 'GROUP', chrome: true },
  { id: 'b2', text: 'My Documents' },
  { id: 'b3', text: `${CV} (11/10/2026)` },
  { id: 'b4', text: `* Curriculum Vitae Edit document ${CV} Opens a dialog` },
  { id: 'b5', text: `${LETTER} (11/10/2026)` },
  { id: 'b6', text: `Cover Letter Delete document ${LETTER} Opens a dialog` },
  { id: 'b7', text: 'Other attachments Add a Document Opens a dialog' },
  { id: 'b8', text: 'Apply' },
];
const fields = [
  { id: 'f1', label: '* First Name', kind: 'text' },
  { id: 'f2', label: '* Education Level', kind: 'combobox' },
];

type Dialog = { text: string; buttons: string[]; reopen?: boolean };

/** A page that holds files by name, raises browser dialogs on demand and draws in-page dialogs. */
function fakePage({ files = [LETTER], dom = null as Dialog | null } = {}) {
  const present = new Set(files);
  const listeners = new Set<(dialog: any) => void>();
  const state = { dom, domClicks: 0, escapes: 0, onAccept: () => {} };
  const page: any = {
    state,
    present,
    on: (event: string, listener: any) => event === 'dialog' && listeners.add(listener),
    off: (event: string, listener: any) => event === 'dialog' && listeners.delete(listener),
    listeners,
    raise(type: string, message: string, onAccept: () => void) {
      const dialog = {
        type: () => type,
        message: () => message,
        accept: async () => { dialog.answer = 'accept'; onAccept(); },
        dismiss: async () => { dialog.answer = 'dismiss'; },
        answer: '',
      };
      for (const listener of listeners) listener(dialog);
      return dialog;
    },
    getByText: (name: string) => ({
      first: () => ({
        waitFor: async () => { if (present.has(name)) throw new Error('timeout'); },
      }),
    }),
    keyboard: { press: async (key: string) => { if (key === 'Escape') { state.escapes += 1; state.dom = null; } } },
    locator: () => ({
      count: async () => (state.dom ? 1 : 0),
      nth: () => ({
        isVisible: async () => Boolean(state.dom),
        innerText: async () => state.dom?.text || '',
        getByRole: (_role: string, { name }: { name: RegExp }) => {
          const matching = (state.dom?.buttons || []).filter((label) => name.test(label));
          return {
            count: async () => matching.length,
            first: () => ({
              click: async () => {
                state.domClicks += 1;
                const reopen = state.dom?.reopen;
                state.onAccept();
                if (!reopen) state.dom = null;
              },
            }),
          };
        },
      }),
    }),
  };
  return page;
}

const fast = { shortTimeout: 1, longTimeout: 1 };
const deleteButton = myDocuments[5];

describe('the earlier run’s file behind a removal control that asks first', () => {
  it('is a removal, never the letter’s upload slot (the real Damiani page, synthetic names)', () => {
    expect(successFactorsDocumentSlotKind(deleteButton)).toBe('');
    expect(uploadButtonCandidatesFor({ buttons: myDocuments, fields }, 'cover_letter')).toEqual([]);
    expect(uploadButtonCandidatesFor({ buttons: myDocuments, fields }, 'cv')).toEqual([]);
    expect(removalsOf(myDocuments, [LETTER]).map((button: any) => button.id)).toEqual(['b6']);
    expect(removalsOf(myDocuments, [CV])).toEqual([]);
    // An empty slot is still the letter's upload slot.
    expect(successFactorsDocumentSlotKind({ text: 'Cover Letter Add document Opens a dialog' })).toBe('cover_letter');
  });

  it('answers yes to the browser confirm() of its own removal click, and the file goes', async () => {
    const page = fakePage();
    let raised: any;
    const click = async () => { raised = page.raise('confirm', 'Are you sure you want to delete this document?', () => page.present.delete(LETTER)); };
    const result = await removeEarlierFile(page, deleteButton, [LETTER], { click, ...fast });
    expect(result.status).toBe('removed');
    expect(raised.answer).toBe('accept');
    expect(result.confirmations).toEqual([{ source: 'browser', type: 'confirm', accepted: true }]);
    // The listener lives only while the click is in flight; nothing records the dialog's text.
    expect(page.listeners.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('sure');
  });

  it('answers the in-page confirmation once and the file goes', async () => {
    const page = fakePage({ dom: null });
    page.state.onAccept = () => page.present.delete(LETTER);
    const click = async () => { page.state.dom = { text: 'Delete document? Do you really want to delete this file?', buttons: ['Yes', 'No'] }; };
    const result = await removeEarlierFile(page, deleteButton, [LETTER], { click, ...fast });
    expect(result.status).toBe('removed');
    expect(page.state.domClicks).toBe(1);
    expect(result.confirmations).toEqual([{ source: 'page', result: 'clicked' }]);
  });

  it('confirms at most MAX_REMOVAL_CONFIRMATIONS times and calls the outcome unknown when the file stays', async () => {
    const page = fakePage();
    const click = async () => { page.state.dom = { text: 'Möchten Sie das Dokument wirklich löschen?', buttons: ['Ja', 'Abbrechen'], reopen: true }; };
    const result = await removeEarlierFile(page, deleteButton, [LETTER], { click, ...fast });
    expect(page.state.domClicks).toBe(MAX_REMOVAL_CONFIRMATIONS);
    expect(result.status).toBe('unconfirmed');
    expect(page.state.escapes).toBe(1);
  });

  it('a confirmed browser removal that does not show is unknown, not kept', async () => {
    const page = fakePage();
    const click = async () => { page.raise('confirm', 'Vuoi eliminare il documento?', () => {}); };
    const result = await removeEarlierFile(page, deleteButton, [LETTER], { click, ...fast });
    expect(result.status).toBe('unconfirmed');
  });

  it('dismisses a confirm() that asks for anything but the file, and leaves the file untouched', async () => {
    const page = fakePage();
    let raised: any;
    const click = async () => { raised = page.raise('confirm', 'Do you want to withdraw your application?', () => page.present.delete(LETTER)); };
    const result = await removeEarlierFile(page, deleteButton, [LETTER], { click, ...fast });
    expect(raised.answer).toBe('dismiss');
    expect(result.status).toBe('untouched');
    expect(page.present.has(LETTER)).toBe(true);
  });

  it('never presses an in-page button for a question about the application or the account', async () => {
    const page = fakePage({ dom: { text: 'Delete your account and all applications?', buttons: ['Delete', 'Cancel'] } });
    page.state.onAccept = () => page.present.delete(LETTER);
    expect(await confirmRemovalInPage(page)).toBe('refused');
    expect(page.state.domClicks).toBe(0);
    const ambiguous = fakePage({ dom: { text: 'Remove this file?', buttons: ['OK', 'Yes', 'Cancel'] } });
    expect(await confirmRemovalInPage(ambiguous)).toBe('ambiguous');
    expect(await confirmRemovalInPage(fakePage())).toBe('none');
  });

  it('reads an accented affirmative label as one word («Sì», review of #17996)', async () => {
    const page = fakePage({ dom: { text: 'Vuoi eliminare il documento?', buttons: ['Sì', 'Annulla'] } });
    page.state.onAccept = () => page.present.delete(LETTER);
    expect(await confirmRemovalInPage(page)).toBe('clicked');
    expect(page.state.domClicks).toBe(1);
    // A longer word that only starts like an affirmative is no answer.
    const prefixed = fakePage({ dom: { text: 'Vuoi eliminare il documento?', buttons: ['Sìcuro di no', 'Annulla'] } });
    expect(await confirmRemovalInPage(prefixed)).not.toBe('clicked');
  });

  it('reports a click that never landed', async () => {
    const page = fakePage();
    const result = await removeEarlierFile(page, deleteButton, [LETTER], { click: async () => { throw new Error('detached'); }, ...fast });
    expect(result.status).toBe('click_failed');
    expect(page.listeners.size).toBe(0);
  });

  it('reads the confirmation texts of a file removal, and nothing else', () => {
    expect(isFileRemovalConfirmation('Are you sure you want to delete this document?')).toBe(true);
    expect(isFileRemovalConfirmation('Voulez-vous vraiment supprimer ce fichier ?')).toBe(true);
    expect(isFileRemovalConfirmation('Sei sicuro di voler rimuovere l’allegato?')).toBe(true);
    expect(isFileRemovalConfirmation('Do you want to withdraw your application?')).toBe(false);
    expect(isFileRemovalConfirmation('Delete your profile?')).toBe(false);
    expect(isFileRemovalConfirmation('Leave this page? Changes you made may not be saved.')).toBe(false);
    expect(isFileRemovalConfirmation('')).toBe(false);
  });
});

describe('an untouched earlier file of ours stays only where no second copy can go', () => {
  it('stays on the Damiani page: no file input, no upload control for the letter', () => {
    expect(ownEarlierFileShown(myDocuments, [LETTER])).toBe(true);
    expect(noSecondUploadPlace({ buttons: myDocuments, fields }, 'cover_letter')).toBe(true);
  });

  it('does not stay where the page could take the document a second time', () => {
    const withInput = { buttons: myDocuments, fields: [...fields, { id: 'f9', label: 'Cover letter', kind: 'file', inputType: 'file' }] };
    expect(noSecondUploadPlace(withInput, 'cover_letter')).toBe(false);
    const withSlot = { buttons: [...myDocuments, { id: 'b9', text: 'Cover Letter Add document Opens a dialog' }], fields };
    expect(noSecondUploadPlace(withSlot, 'cover_letter')).toBe(false);
  });

  it('is never someone else’s file: another name has no removal and is not ours', () => {
    const page = [...myDocuments, { id: 'b10', text: `Delete ${OTHER}` }];
    expect(removalsOf(page, [LETTER]).map((button: any) => button.id)).toEqual(['b6']);
    expect(removalsOf(page, [CV])).toEqual([]);
    expect(ownEarlierFileShown([{ id: 'c', text: `Recently viewed ${LETTER}`, chrome: true }], [LETTER])).toBe(false);
  });
});
