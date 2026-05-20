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
