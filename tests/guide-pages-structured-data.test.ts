/**
 * Le tre pagine guida (permessi, primo giorno, trasferimento auto) devono
 * restare allineate a Fisco/Calcolatore: tabelle e FAQ rese dai componenti
 * riusabili, e JSON-LD FAQPage/HowTo iniettato con il guard anti-doppione.
 *
 * Perche' questo test LEGGE i sorgenti come testo invece di importarli.
 * I worktree degli agenti sono sparse (`fast-worktree.sh`): `data/` e `public/`
 * non esistono li' dentro. Un import di questi componenti tira dentro la catena
 * `@/services/...` e a module-scope finisce per toccare quei percorsi — il test
 * sarebbe rosso in worktree e verde in CI, cioe' un guard che non si puo'
 * eseguire dove si scrive il codice. Il difetto che copriamo (componente non
 * usato, JSON-LD assente, guard rimosso) e' visibile nel sorgente, quindi la
 * lettura testuale e' sufficiente e gira ovunque.
 *
 * Cio' che NON copre, dichiarato per non dare falsa sicurezza: non esegue il
 * componente, quindi non prova che lo script finisca davvero in `<head>` a
 * runtime ne' che lo schema sia valido per Google.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relPath: string) => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/** Il guard: prima di iniettare si cerca un JSON-LD dello stesso @type gia' in pagina. */
const DUPLICATE_GUARD = `document.querySelectorAll('script[type="application/ld+json"]')`;

interface GuideExpectation {
  /** Percorso del componente guida. */
  file: string;
  /** Componenti riusabili che la pagina deve rendere. */
  components: string[];
  /** Tipi schema.org che la pagina deve emettere. */
  schemaTypes: string[];
  /** id degli script JSON-LD che la pagina possiede. */
  scriptIds: string[];
}

const GUIDES: GuideExpectation[] = [
  {
    file: 'components/guide/WorkPermitsGuide.tsx',
    components: ['AiExtractableTable', 'FaqAccordion'],
    schemaTypes: ['FAQPage'],
    scriptIds: ['permits-faq-jsonld'],
  },
  {
    file: 'components/guide/FirstDayGuide.tsx',
    components: ['AiExtractableTable'],
    schemaTypes: ['HowTo'],
    scriptIds: ['firstday-howto-jsonld'],
  },
  {
    file: 'components/guide/CarTransferGuide.tsx',
    components: ['AiExtractableTable', 'FaqAccordion'],
    schemaTypes: ['HowTo', 'FAQPage'],
    scriptIds: ['car-transfer-howto-jsonld', 'car-transfer-faq-jsonld'],
  },
  {
    // Sibling della stessa classe (AGENTS.md #6): rendeva 5 Q&A da chiavi t()
    // con un accordion fatto a mano e senza FAQPage. Stessa fix, quindi stesso
    // guard — sta qui perche' a regredire sarebbe per la stessa ragione.
    file: 'components/comparators/RenovationCalculator.tsx',
    components: ['FaqAccordion'],
    schemaTypes: ['FAQPage'],
    scriptIds: ['renovation-faq-jsonld'],
  },
];

describe('pagine guida: tabelle, FAQ e structured data', () => {
  for (const guide of GUIDES) {
    describe(guide.file, () => {
      const source = readSource(guide.file);

      for (const component of guide.components) {
        it(`importa e rende ${component}`, () => {
          expect(source).toContain(`import ${component} from '@/components/shared/${component}'`);
          expect(source).toContain(`<${component}`);
        });
      }

      for (const schemaType of guide.schemaTypes) {
        it(`emette JSON-LD ${schemaType}`, () => {
          expect(source).toContain(`'@type': '${schemaType}'`);
          expect(source).toContain(`script.type = 'application/ld+json'`);
        });
      }

      it('inietta solo dopo aver escluso un JSON-LD dello stesso @type gia in pagina', () => {
        // Senza questo guard due FAQPage sulla stessa pagina fanno scattare
        // l'errore "duplicate FAQPage" dei rich results (stessa ragione per cui
        // FaqSection.tsx lo applica).
        expect(source).toContain(DUPLICATE_GUARD);
        expect(source).toContain(`?.['@type']`);
      });

      it('non marca i propri script con data-dynamic-ld', () => {
        // `data-dynamic-ld` e' di seoService.updateStructuredData(), che rimuove
        // OGNI script che lo porta a ogni aggiornamento SEO: marcarlo qui
        // farebbe sparire il blocco col componente ancora montato.
        // Si guarda l'attributo POSATO nel codice, non la parola: il commento
        // che spiega questa regola contiene la stringa e non e' una violazione.
        expect(source).not.toMatch(/setAttribute\(\s*['"]data-dynamic-ld['"]/);
        expect(source).not.toMatch(/dataset\.dynamicLd/);
        expect(source).not.toMatch(/data-dynamic-ld\s*=/);
      });

      it('rimuove i propri script allo smontaggio', () => {
        for (const scriptId of guide.scriptIds) {
          expect(source).toContain(`'${scriptId}'`);
        }
        // La cleanup dell'effetto: id preso per getElementById e rimosso. Le due
        // pagine con un solo blocco usano LD_ID, quella con due itera sugli id
        // iniettati — in entrambe la coppia getElementById/remove deve esserci.
        expect(source).toMatch(/document\.getElementById\([^)]*\)\?\.remove\(\)/);
      });
    });
  }

  it('gli id degli script JSON-LD non collidono tra le pagine guida', () => {
    const allIds = GUIDES.flatMap(g => g.scriptIds);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('almeno 5 pagine tra tabs/ e guide/ usano i componenti estraibili', () => {
    // Ratchet della scheda: era 2 (FiscoTabContent, CalcolatoreTabContent).
    // Comando equivalente:
    //   grep -l "AiExtractableTable\|FaqAccordion" components/tabs/*.tsx components/guide/*.tsx | wc -l
    const dirs = ['components/tabs', 'components/guide'];
    const users = dirs.flatMap(dir =>
      readdirSync(resolve(REPO_ROOT, dir))
        .filter(name => name.endsWith('.tsx'))
        .filter(name => /AiExtractableTable|FaqAccordion/.test(readSource(join(dir, name))))
        .map(name => join(dir, name)),
    );
    expect(users.length).toBeGreaterThanOrEqual(5);
  });

  it('le chiavi nuove delle tabelle esistono in tutti e 4 i locali', () => {
    const NEW_KEYS = [
      'permits.table.col.document',
      'firstday.table.caption',
      'firstday.table.col.step',
      'firstday.table.col.category',
      'firstday.table.col.time',
    ];
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const source = readSource(`services/locales/${locale}-guide.ts`);
      for (const key of NEW_KEYS) {
        expect(source, `${locale}-guide.ts manca '${key}'`).toContain(`'${key}':`);
      }
    }
  });
});
