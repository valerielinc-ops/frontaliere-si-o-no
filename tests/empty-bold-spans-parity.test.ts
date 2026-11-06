import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dropEmptyBoldSpans, parseInline } from '../build-plugins/shared/jobDescription/parser';
// @ts-expect-error — plain .mjs helper, no type declarations
import { cleanCrawlerArtifacts } from '../scripts/lib/crawler-template.mjs';
// @ts-expect-error — plain .mjs helper, no type declarations
import { balanceMarkdownMarkers } from '../scripts/lib/free-translate.mjs';

/**
 * «Togli i grassetti vuoti» vive in tre posti che non possono importarsi fra
 * loro: il parser di render (TypeScript, condiviso fra SSG e SPA), la pulizia
 * al momento dell'assemblaggio (`crawler-template.mjs`) e l'uscita della
 * cascata di traduzione (`free-translate.mjs`, gemello adattato del corpus).
 *
 * Tutti e tre usavano la stessa regex sul testo intero — due marcatori `**`
 * con in mezzo solo spazi o punteggiatura — che non distingue un marcatore di
 * chiusura da uno di apertura. `**a**, **b**` diventava un solo grassetto, e
 * poiché `\s` attraversa gli a capo una riga che finisce in grassetto
 * inghiottiva la riga dopo: titolo di sezione e prima voce su una riga sola.
 * Misura sul corpus degli articoli (12'692 campi italiani ripassati riga per
 * riga dall'uscita della cascata): 109 campi in 99 articoli perdevano righe.
 *
 * Questo file tiene insieme le tre copie e impedisce alla regex di tornare.
 */
const REPO_ROOT = path.resolve(__dirname, '..');

const squash = (value: string) => value.replace(/[ \t]{2,}/g, ' ').trim();

const KEPT_AS_IS = [
  '- **AVS**: 22 anni su 44 → circa **1.260 CHF/mese**\n- **LPP**: capitale di 280.000 CHF = **1.587 CHF/mese**\n- **Pilastro 3a**: 180.000 CHF',
  '**Ihre Aufgaben:**\n- **Leitung** des Teams\n- **Planung** der Projekte',
  'I tre pilastri: **AVS**, **LPP** e 3a.',
  '**Quando:** **18 febbraio 2026**, dalle **10:15** alle **11:30**.',
  '**Etichetta**: **valore**',
];

const CLEANED: Array<[string, string]> = [
  ['prima ** ** dopo', 'prima dopo'],
  ['prima ** : ** dopo', 'prima dopo'],
  ['prima **** dopo', 'prima dopo'],
  ['- **Voce** ** - ** testo', '- **Voce** testo'],
  ['Compiti ** ** **  ** **:** Operativo.', 'Compiti Operativo.'],
];

describe('grassetti vuoti — le tre copie fanno la stessa cosa', () => {
  const implementations: Array<[string, (value: string) => string]> = [
    ['parser.ts dropEmptyBoldSpans', (value) => dropEmptyBoldSpans(value)],
    ['crawler-template.mjs cleanCrawlerArtifacts', (value) => cleanCrawlerArtifacts(value)],
    ['free-translate.mjs balanceMarkdownMarkers', (value) => balanceMarkdownMarkers(value)],
  ];

  for (const [name, run] of implementations) {
    it(`${name}: non fonde righe né grassetti vicini`, () => {
      for (const text of KEPT_AS_IS) {
        expect(run(text), text).toBe(text);
      }
    });

    it(`${name}: toglie ancora i grassetti davvero vuoti`, () => {
      for (const [text, expected] of CLEANED) {
        expect(squash(run(text)), text).toBe(expected);
      }
    });
  }
});

describe('grassetti vuoti — effetto sul render e sul dataset', () => {
  it('parseInline rende due grassetti vicini come due, con il testo fra loro', () => {
    expect(parseInline('**AVS**, **LPP** e 3a.')).toEqual([
      { kind: 'strong', value: 'AVS' },
      { kind: 'text', value: ', ' },
      { kind: 'strong', value: 'LPP' },
      { kind: 'text', value: ' e 3a.' },
    ]);
  });

  it('cleanCrawlerArtifacts lascia il titolo di sezione e le sue voci su righe distinte', () => {
    const description = '**Ihre Aufgaben:**\n- **Leitung** des Teams\n- **Planung** der Projekte\n\n**Ihr Profil:**\n- **Erfahrung** im Bereich';
    const cleaned = cleanCrawlerArtifacts(description);
    expect(cleaned.split('\n')).toHaveLength(description.split('\n').length);
    expect(cleaned).toContain('**Ihre Aufgaben:**\n- **Leitung** des Teams');
  });
});

describe('grassetti vuoti — la regex sul testo intero non torna', () => {
  // La forma vietata: un `replace` con `\*\*` … solo `\s` o una classe che
  // contiene `\s` … `\*\*`. Un controllo (`toMatch`, `test`) con quella forma
  // resta lecito: fa danno solo quando riscrive.
  const WHOLE_TEXT_EMPTY_BOLD_RE = /\\\*\\\*(?:\\s[*+]?|\[[^\]]*\\s[^\]]*\][*+]?){1,3}\\\*\\\*/;
  const ROOTS = ['scripts', 'build-plugins', 'src', 'packages', 'functions', 'services', 'components', 'utils', 'lib'];
  const SOURCE_FILE_RE = /\.(?:mjs|cjs|js|ts|tsx)$/;

  function walk(dir: string, out: string[]): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (SOURCE_FILE_RE.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('nessun sorgente riscrive i grassetti con quella regex', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const file of walk(path.join(REPO_ROOT, root), [])) {
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue; // symlink verso il corpus non risolto in un checkout sparse
        }
        scanned += 1;
        text.split('\n').forEach((line, index) => {
          if (line.includes('replace(') && WHOLE_TEXT_EMPTY_BOLD_RE.test(line)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}:${index + 1}`);
          }
        });
      }
    }
    // I tre file che la portavano devono essere stati letti davvero.
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it('il rilevatore riconosce la forma che vieta', () => {
    expect(WHOLE_TEXT_EMPTY_BOLD_RE.test(String.raw`out = out.replace(/\*\*\s*[\s:;,.\-–—]*\s*\*\*/g, ' ');`)).toBe(true);
    expect(WHOLE_TEXT_EMPTY_BOLD_RE.test(String.raw`const re = /\*\*([^*\n]+?)\*\*/g;`)).toBe(false);
  });
});
