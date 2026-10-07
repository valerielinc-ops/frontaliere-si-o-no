import { describe, it, expect } from 'vitest';
import { balanceMarkdownMarkers } from '@/scripts/lib/free-translate.mjs';

/**
 * Upstream root-cause guard for the literal-`**` bug we patched at render
 * time in PR #426. Translator outputs with unbalanced bold markers now get
 * sanitized before reaching `descriptionByLocale[lang]`, so the artifact
 * cannot propagate to the dataset and the rendered job page.
 *
 * The render-side parser (`build-plugins/shared/jobDescription/parser.ts`)
 * is the second line of defence — this test pins the FIRST line: at the
 * translator boundary the JSON we commit must never contain orphan `**`.
 */
describe('balanceMarkdownMarkers — translator-time defence', () => {
 it('returns input untouched when `**` count is even and bolds are non-empty', () => {
 const raw = 'Posizione **Senior Engineer** in **Lugano** con esperienza.';
 expect(balanceMarkdownMarkers(raw)).toBe(raw);
 });

 it('strips ALL `**` when count is odd (the orphan-bold case)', () => {
 const raw = 'Se è così **entrate a far parte di un\'organizzazione **dinamica** e crescere';
 const out = balanceMarkdownMarkers(raw);
 expect(out).not.toMatch(/\*\*/);
 });

 it('strips empty / whitespace-only / punctuation-only bolds (S1 casale repro)', () => {
 const raw = 'Compiti ** ** **  ** **:** Operativo.';
 expect(balanceMarkdownMarkers(raw)).toBe('Compiti Operativo.');
 });

 it('handles the exact casale "Lavora con noi" Italian artifact: drops empty pair, keeps balanced one', () => {
 const raw =
 "**Se è così - **entrate a far parte di un'organizzazione dinamica che offre percorsi di carriera diversificati e opportunità di crescita eccezionali** **";
 const out = balanceMarkdownMarkers(raw);
 // After empty-pair strip the remaining `**Se è così - **` is balanced (2
 // markers, non-empty content) and survives — the render-side parser will
 // convert it to <strong>. The trailing empty `** **` gets dropped here.
 const markerCount = (out.match(/\*\*/g) || []).length;
 expect(markerCount % 2).toBe(0);
 expect(out).not.toMatch(/\*\*\s*\*\*/); // no empty pair survived
 expect(out).toContain('Se è così');
 expect(out).toContain('crescita eccezionali');
 });

 it('strips standalone separator-only lines (`______`, `=====`, `----`)', () => {
 const raw = 'Para 1\n\n______\n\nPara 2\n\n=====\n\nPara 3';
 expect(balanceMarkdownMarkers(raw)).toBe('Para 1\n\nPara 2\n\nPara 3');
 });

 it('strips trailing inline separator runs at end of a line', () => {
 expect(balanceMarkdownMarkers('Be part of something. ______')).toBe('Be part of something.');
 expect(balanceMarkdownMarkers('Some text ----')).toBe('Some text');
 });

 it('returns empty / null / non-string inputs unchanged (defensive)', () => {
 expect(balanceMarkdownMarkers('')).toBe('');
 expect(balanceMarkdownMarkers(null as unknown as string)).toBe(null);
 expect(balanceMarkdownMarkers(undefined as unknown as string)).toBe(undefined);
 });

 it('preserves single `*emphasis*` markers untouched', () => {
 const raw = 'Pacchetto *interessante* con benefit *aggiuntivi*';
 expect(balanceMarkdownMarkers(raw)).toBe(raw);
 });

 it('idempotent: balancing twice equals balancing once', () => {
 const raw =
 "**Profilo:** orientato al cliente. ** ** Esperienza richiesta. ______";
 const once = balanceMarkdownMarkers(raw);
 const twice = balanceMarkdownMarkers(once);
 expect(twice).toBe(once);
 });
});

/**
 * The empty-bold step used ONE regex over the whole text: two markers with
 * only blanks or punctuation between them. That shape is also the gap between
 * the end of one bold span and the start of the next, and `\s` crosses line
 * breaks — so a list item ending in bold swallowed the item after it, and the
 * exit transform took lines away from a translation that had kept them.
 * Measured on the article corpus (12'692 Italian body fields replayed line for
 * line): 109 fields in 99 articles came out with fewer lines; 0 after the fix.
 */
describe('balanceMarkdownMarkers — never merges lines or neighbouring bolds', () => {
  it('keeps list items that end in bold apart from the item that follows', () => {
    const raw = [
      '- **AVS**: 22 anni su 44 → circa **1.260 CHF/mese**',
      '- **LPP**: capitale di 280.000 CHF × 6,8% = **1.587 CHF/mese**',
      '- **Pilastro 3a**: capitale di 180.000 CHF',
    ].join('\n');
    expect(balanceMarkdownMarkers(raw)).toBe(raw);
  });

  it('keeps a bold heading line apart from a bold-labelled line below it', () => {
    const raw = '💡 **Consigli pratici:**\n- **Monitorare la situazione:** tenersi informati.';
    expect(balanceMarkdownMarkers(raw)).toBe(raw);
    const withBlank = '**Totale mensile**: circa **2.847 CHF**\n\n**Nota**: valori indicativi';
    expect(balanceMarkdownMarkers(withBlank)).toBe(withBlank);
  });

  it('keeps two neighbouring bold spans on the same line as two', () => {
    for (const raw of [
      'I tre pilastri: **AVS**, **LPP** e 3a.',
      '**Quando:** **18 febbraio 2026**, dalle **10:15** alle **11:30**.',
      '**Etichetta**: **valore**',
    ]) {
      expect(balanceMarkdownMarkers(raw)).toBe(raw);
    }
  });

  it('still drops a really empty bold that sits right after a real one', () => {
    expect(balanceMarkdownMarkers('- **Voce** ** - ** testo')).toBe('- **Voce** testo');
    expect(balanceMarkdownMarkers('prima **** dopo')).toBe('prima dopo');
  });

  it('keeps a separator-only line that the source owns at the same position', () => {
    const source = 'Primo paragrafo.\n\n---\n\nSecondo paragrafo.';
    const translated = 'Erster Absatz.\n\n---\n\nZweiter Absatz.';
    // No source: decoration, as before.
    expect(balanceMarkdownMarkers(translated)).toBe('Erster Absatz.\n\nZweiter Absatz.');
    // Line-aligned source: the rule is structure and stays.
    expect(balanceMarkdownMarkers(translated, { sourceText: source })).toBe(translated);
    // The source has text at that position: the line is not the source's.
    expect(
      balanceMarkdownMarkers('Erster Absatz.\n=====\nZweiter Absatz.', {
        sourceText: 'Primo paragrafo.\nRiga di mezzo.\nSecondo paragrafo.',
      }),
    ).toBe('Erster Absatz.\nZweiter Absatz.');
    // Source with a different line count: no alignment, behaviour as before.
    expect(balanceMarkdownMarkers(translated, { sourceText: 'Una riga sola.' })).toBe(
      'Erster Absatz.\n\nZweiter Absatz.',
    );
  });
});
