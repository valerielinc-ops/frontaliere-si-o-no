import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { BIRTH_FIELD_RE, BIRTH_LOCATION_RE, DATE_OF_BIRTH_RE } from '../scripts/assisted-application/lib/portal/plan.mjs';

const directory = new URL('../scripts/assisted-application/extension/', import.meta.url);
const kit = { identity: { address: { city: 'Como', country: 'Italia' } }, profile: { dateOfBirth: '1990-01-02' }, answers: [] };
function page(label: string, type = 'text') {
  const dom = new JSDOM(`<form><h2>Personal information</h2><label for="birth">${label}</label><input id="birth" type="${type}" required></form>`, { runScripts: 'outside-only', url: 'https://jobs.example.test/apply/' });
  for (const file of ['apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(file, directory), 'utf8'));
  const F = (dom.window as any).CompilaCandidatura;
  return { dom, F, field: F.collect(dom.window.document)[0] };
}

describe('birth fact boundaries in the extension', () => {
  it('keeps the positive date and location patterns aligned with the server', () => {
    const { dom, F } = page('DOB');
    expect(`${F.DATE_OF_BIRTH_RE.source}/${F.DATE_OF_BIRTH_RE.flags}`).toBe(`${DATE_OF_BIRTH_RE.source}/${DATE_OF_BIRTH_RE.flags}`);
    expect(`${F.BIRTH_LOCATION_RE.source}/${F.BIRTH_LOCATION_RE.flags}`).toBe(`${BIRTH_LOCATION_RE.source}/${BIRTH_LOCATION_RE.flags}`);
    expect(`${F.BIRTH_FIELD_RE.source}/${F.BIRTH_FIELD_RE.flags}`).toBe(`${BIRTH_FIELD_RE.source}/${BIRTH_FIELD_RE.flags}`);
    dom.window.close();
  });

  it.each(['Place of birth', 'Comune di nascita', 'Luogo di nascita', 'Geburtsort', 'Lieu de naissance', 'Country of birth', 'Paese di nascita', 'Commune de naissance', 'Ort der Geburt', 'Nato a', 'Birth country', 'Provincia di nascita', 'Nationality / Country of birth'])('leaves %s unanswered despite a known DOB and residence', async (label) => {
    const { dom, F } = page(label);
    const result = await F.fillPage(dom.window.document, kit, { getFile: async () => null, attempts: new WeakMap() });
    expect((dom.window.document.getElementById('birth') as HTMLInputElement).value).toBe('');
    expect(result.missing).toHaveLength(1);
    dom.window.close();
  });

  it.each(['Date of birth', 'DOB', 'Data di nascita', 'Quando sei nato?', 'Geburtsdatum', 'Date de naissance'])('fills the actual %s date control', async (label) => {
    const { dom, F } = page(label, 'date');
    await F.fillPage(dom.window.document, kit, { getFile: async () => null, attempts: new WeakMap() });
    expect((dom.window.document.getElementById('birth') as HTMLInputElement).value).toBe('1990-01-02');
    dom.window.close();
  });

  it('can use the exact birthplace answer without borrowing it for birth country', () => {
    const one = page('Place of birth');
    const stated = { ...kit, answers: [{ question: 'Place of birth', answer: 'Lugano', source: 'answers' }] };
    expect(one.F.answerFor(one.field, stated)).toEqual({ value: 'Lugano' });
    one.dom.window.close();
    const other = page('Country of birth');
    expect(other.F.answerFor(other.field, stated)).toBeNull();
    other.dom.window.close();
  });
});
