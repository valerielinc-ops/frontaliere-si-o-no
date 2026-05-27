import { describe, expect, it } from 'vitest';

import { parseSwisscomJobDescription } from '../scripts/lib/swisscom-job-parser.mjs';

describe('swisscom-job-parser', () => {
  it('keeps Workday sections and extracts requirements from "Cosa porti con te"', () => {
    const html = [
      '<h1><b>Il tuo futuro inizia qui</b></h1>',
      '<p>Dai un&apos;identità a Swisscom ed entusiasmi i nostri clienti con la tua personalità e con il tuo sapere. Sei pronto/a,</p>',
      '<ul>',
      '<li>ad entusiasmare con la tua passione per i prodotti e le tendenze del mondo TIC</li>',
      '<li>ad acquisire e fidelizzare i clienti con la tua conoscenza completa dei prodotti</li>',
      '</ul>',
      '<p><br /><b>Cosa porti con te</b></p>',
      '<ul>',
      '<li>Aver portato a termine la scuola dell&apos;obbligo con costanti buone note</li>',
      '<li>L&apos;italiano, la matematica e almeno una lingua nazionale sono tra i tuoi punti di forza</li>',
      '</ul>',
      '<p>A partire dalla maggiore età, verrà richiesto l&apos;estratto del casellario giudiziale.</p>',
      '<h1><b>Il tuo apprendistato</b></h1>',
      '<p><b>La tua formazione</b></p>',
      '<p>Durata: <b>3 anni</b></p>',
      '<p>Diploma: <b>Impiegato/a del commercio al dettaglio AFC</b></p>',
    ].join('');

    const result = parseSwisscomJobDescription(html, 'Apprendistato: Impiegato/a del commercio al dettaglio AFC');

    expect(result.description).toContain('# Apprendistato: Impiegato/a del commercio al dettaglio AFC');
    expect(result.description).toContain('## Il tuo futuro inizia qui');
    expect(result.description).toContain('## Cosa porti con te');
    expect(result.description).toContain('- Aver portato a termine la scuola dell\'obbligo con costanti buone note');
    expect(result.description).toContain('## La tua formazione');
    expect(result.description).not.toContain('Cosa porti con te Aver portato a termine');
    expect(result.requirements).toEqual([
      'Aver portato a termine la scuola dell\'obbligo con costanti buone note',
      'L\'italiano, la matematica e almeno una lingua nazionale sono tra i tuoi punti di forza',
    ]);
  });
});
