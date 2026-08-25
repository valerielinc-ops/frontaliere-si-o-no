/**
 * Osservatore di `data/crawler-companies-auto.json` e delle due regole che lo
 * producono.
 *
 * Il file alimenta la directory aziende pubblica: un nome sbagliato qui e' una
 * scheda sbagliata in pagina, non una riga di log. I difetti che questo test
 * tiene chiusi sono stati tutti osservati sul dato vero (issue #6481):
 *
 *  - `fust` intestato «Coop Genossenschaft», perche' il nome veniva da
 *    `jobs[0].company` di uno slice che copre piu' marchi;
 *  - `OTTO'S AG` scritto «OTTO», perche' la regex chiudeva il literal
 *    sull'apostrofo interno, e `Chicco d’Oro` pubblicato con l'escape grezzo
 *    `Chicco d\\u2019Oro`, perche' nessuno lo risolveva;
 *  - `tl-lausanne` intestato «Volksschule Stadt Luzern», nome citato in un
 *    docblock e pescato al posto della dichiarazione vera;
 *  - schede intestate «Careers» e «Recruitingapp 2649», che sono frammenti di
 *    URL e id di tenant ATS, non datori di lavoro;
 *  - il file fermo a 213 entry su 614 runner per mesi, senza che niente lo
 *    dicesse.
 *
 * Il file vive sotto `data/`, che in un worktree sparse non e' materializzato.
 * Leggerlo con `fs` soltanto renderebbe il gate **vacuo in locale e reale solo
 * in CI**: qui si ricade su `git show HEAD:<path>`, che funziona in entrambi.
 * Se nessuna delle due strade porta il file il test FALLISCE — un osservatore
 * che si auto-salta e' peggio di nessun osservatore.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchQuotedLiteral, stripCommentLines } from '../scripts/lib/js-string-literal.mjs';
import {
  extractDeclaredIdentity,
  isNonEmployerSlug,
  sliceDomainForName,
  summariseSliceCompanies,
} from '../scripts/lib/crawler-company-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_REL = 'data/crawler-companies-auto.json';

interface CompanyEntry {
  name: string;
  key: string;
  website?: string;
  careersUrl?: string;
}

/** Il file dal working tree, o — in sparse checkout — da `HEAD`. */
function readCompanies(): CompanyEntry[] {
  const abs = path.join(ROOT, DATA_REL);
  if (fs.existsSync(abs)) return JSON.parse(fs.readFileSync(abs, 'utf8'));
  const fromGit = execFileSync('git', ['show', `HEAD:${DATA_REL}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(fromGit);
}

describe('js-string-literal — lettura di un literal da sorgente', () => {
  it('non tronca su un apostrofo interno a un literal fra doppi apici', () => {
    const src = `export const OTTOS_COMPANY_NAME = "OTTO'S AG";`;
    expect(matchQuotedLiteral(src, /(?:COMPANY_NAME|companyLabel)\s*[:=]\s*/)).toBe("OTTO'S AG");
  });

  it('risolve gli escape invece di lasciarli grezzi nel nome', () => {
    const src = "const X_COMPANY_NAME = 'Chicco d\\u2019Oro';";
    expect(matchQuotedLiteral(src, /const\s+\w+_COMPANY_NAME\s*=\s*/)).toBe('Chicco d’Oro');
    const escaped = "const Y_COMPANY_NAME = 'L\\'Oreal Suisse';";
    expect(matchQuotedLiteral(escaped, /const\s+\w+_COMPANY_NAME\s*=\s*/)).toBe("L'Oreal Suisse");
  });

  it('ignora un nome citato dentro un docblock e prende la dichiarazione vera', () => {
    const src = [
      '/**',
      " * Il parser gemello ships `VOLKSSCHULE_LUZERN_COMPANY_NAME = 'Volksschule Stadt Luzern'`,",
      ' * qui invece:',
      ' */',
      "export const TL_LAUSANNE_COMPANY_NAME = 'tl (Transports publics de la region lausannoise)';",
    ].join('\n');
    expect(matchQuotedLiteral(src, /(?:COMPANY_NAME|companyLabel)\s*[:=]\s*/)).toBe(
      'tl (Transports publics de la region lausannoise)',
    );
    expect(stripCommentLines(src).split('\n')).toHaveLength(5);
  });

  it('salta un valore che non e’ un literal e prosegue alla dichiarazione', () => {
    const src = [
      'const CFG = {',
      '  companyLabel: ACME_COMPANY_NAME,',
      '};',
      "export const ACME_COMPANY_NAME = 'ACME SA';",
    ].join('\n');
    expect(matchQuotedLiteral(src, /(?:COMPANY_NAME|companyLabel)\s*[:=]\s*/)).toBe('ACME SA');
  });

  it('salta un template con interpolazione e prende la costante vera', () => {
    // `alten` sarebbe finito nella directory con
    // `careersUrl: .../?per_page=${LISTING_PAGE_CAP}` — un link rotto in pagina.
    const src = [
      'const URL_TEMPLATE = `https://www.alten.ch/jobs/?per_page=${LISTING_PAGE_CAP}`;',
      "const CAREERS_URL = 'https://www.alten.ch/career/jobs/';",
    ].join('\n');
    expect(matchQuotedLiteral(src, /CAREERS_URL\s*=\s*/)).toBe('https://www.alten.ch/career/jobs/');
    expect(matchQuotedLiteral('const CAREERS_URL = `a/${x}`;', /CAREERS_URL\s*=\s*/)).toBeNull();
  });

  it('non attraversa la fine riga con apici semplici', () => {
    expect(matchQuotedLiteral("const A_COMPANY_NAME = 'aperto\nchiuso';", /const\s+\w+_COMPANY_NAME\s*=\s*/)).toBeNull();
  });
});

describe('crawler-company-identity — chi e’ l’azienda di uno slice', () => {
  const job = (company: string, companyDomain = '') => ({ company, companyDomain });

  it('su uno slice mono-datore prende il nome e il suo dominio', () => {
    const s = summariseSliceCompanies([job('IKEA', 'ikea.ch'), job('IKEA', 'ikea.ch')]);
    expect(s.name).toBe('IKEA');
    expect(s.domain).toBe('ikea.ch');
  });

  it('NON prende il primo record quando lo slice copre piu’ datori', () => {
    // La forma di `coop-ticino`: il primo job e' un marchio periferico.
    const jobs = [
      job('Marche Restaurants Schweiz AG', 'marche.ch'),
      ...Array.from({ length: 40 }, () => job('Coop Genossenschaft', 'coop.ch')),
      ...Array.from({ length: 35 }, () => job('Interdiscount', 'interdiscount.ch')),
      ...Array.from({ length: 30 }, () => job('Jumbo', 'jumbo.ch')),
    ];
    const s = summariseSliceCompanies(jobs);
    expect(s.name).not.toBe('Marche Restaurants Schweiz AG');
    // Nessuna maggioranza assoluta: lo slice si astiene invece di eleggere il
    // marchio piu' prolifico a nome del crawler.
    expect(s.name).toBe('');
    expect(s.domain).toBe('');
    expect(s.distinct).toBe(4);
  });

  it('il dominio segue il nome scelto dal chiamante, non la maggioranza dello slice', () => {
    // La forma di `fust`: maggioranza «Coop Genossenschaft», nome dichiarato «Fust».
    const jobs = [
      ...Array.from({ length: 60 }, () => job('Coop Genossenschaft', 'coop.ch')),
      ...Array.from({ length: 30 }, () => job('Fust', 'fust.ch')),
    ];
    const s = summariseSliceCompanies(jobs);
    expect(s.name).toBe('Coop Genossenschaft');
    expect(sliceDomainForName(s, 'Fust')).toBe('fust.ch');
  });

  it('e’ deterministico a parita’ di conteggio', () => {
    const a = summariseSliceCompanies([job('Beta'), job('Alfa'), job('Alfa'), job('Beta'), job('Alfa')]);
    const b = summariseSliceCompanies([job('Alfa'), job('Beta'), job('Alfa'), job('Beta'), job('Alfa')]);
    expect(a.name).toBe(b.name);
    expect(a.name).toBe('Alfa');
  });

  it('riconosce gli slug che non sono un datore di lavoro', () => {
    for (const slug of ['careers', 'de', 'jobs', 'recruitingapp-2649', 'workable-1123', '']) {
      expect(isNonEmployerSlug(slug), slug).toBe(true);
    }
    for (const slug of ['fust', 'coop', 'spitex-ch', 'saint-gobain-weber-isover', 'recruitingapp-x']) {
      expect(isNonEmployerSlug(slug), slug).toBe(false);
    }
  });
});

describe('data/crawler-companies-auto.json — invarianti della directory', () => {
  const companies = readCompanies();

  it('copre i runner invece di restare lo snapshot fermo (213 su 614)', () => {
    // La soglia e' PROPORZIONALE ai runner, non un numero fisso, per due
    // ragioni opposte e ugualmente concrete:
    //
    //  - un pavimento assoluto invecchia: 500 oggi e' il 82% dei runner, fra
    //    duecento crawler sarebbe il 60% e non direbbe piu' niente;
    //  - un'uguaglianza esatta resterebbe un wedge anche adesso che la PR di
    //    promozione del prospector rigenera il file da sola (vedi il describe
    //    «il registro si rigenera a ogni promozione»): la rigenerazione ha un
    //    ramo di fallimento dichiarato, che lascia apposta il file alla
    //    versione precedente invece di committarne uno a meta'. Al 100% quel
    //    ramo — l'esito PREVISTO di un guasto — renderebbe `main` rosso.
    //
    // Il 90% lascia passare il ritardo fisiologico di una manciata di crawler
    // appena promossi (misurato: 602/609 = 98,9%) e non lascia passare lo
    // snapshot fermo che ha aperto la issue (213/614 = 34,7%).
    const runners = fs
      .readdirSync(path.join(ROOT, 'scripts'))
      .filter((f) => f.startsWith('update-') && f.endsWith('-jobs.mjs'));
    expect(runners.length).toBeGreaterThan(100); // la lettura ha davvero funzionato
    expect(companies.length / runners.length).toBeGreaterThanOrEqual(0.9);
  });

  it('ogni entry ha un nome e una chiave', () => {
    const broken = companies.filter((e) => !e?.name?.trim() || !e?.key?.trim());
    expect(broken).toEqual([]);
  });

  it('nessuna chiave e’ un frammento di URL o un id di tenant ATS', () => {
    const junk = companies.filter((e) => isNonEmployerSlug(e.key)).map((e) => e.key);
    expect(junk).toEqual([]);
  });

  it('nessun nome porta un escape grezzo o si interrompe su una parola tronca', () => {
    const rawEscape = companies.filter((e) => /\\u[0-9a-fA-F]{4}|\\['"`]/.test(e.name));
    expect(rawEscape.map((e) => `${e.key}=${e.name}`)).toEqual([]);

    // «Etablissements publics pour l» / «Groupement Hospitalier de l»: il
    // troncamento sull'apostrofo lascia sempre in coda l'articolo elisemp.
    const truncated = companies.filter((e) =>
      /\s(?:l|d|dell|nell|all|un|della|delle|dei|degli)$/i.test(e.name),
    );
    expect(truncated.map((e) => `${e.key}=${e.name}`)).toEqual([]);
  });

  it('la scheda porta il nome che il crawler DICHIARA', () => {
    // L'invariante che chiude tutta la famiglia in una riga sola: troncamento
    // sull'apostrofo, nome pescato da un docblock, nome preso da `jobs[0]` di
    // uno slice di gruppo — ognuno di questi produce un nome DIVERSO da quello
    // dichiarato dal runner/parser, e qui si vede.
    //
    // Gira su `scripts/`, che esiste anche in un worktree sparse.
    const mismatches: string[] = [];
    for (const entry of companies) {
      const declared =
        extractDeclaredIdentity(path.join(ROOT, 'scripts', `update-${entry.key}-jobs.mjs`)).company ||
        extractDeclaredIdentity(path.join(ROOT, 'scripts', 'lib', `${entry.key}-job-parser.mjs`)).company;
      if (!declared) continue; // 5 crawler su 609 non dichiarano nulla: li copre lo slice
      if (declared !== entry.name) mismatches.push(`${entry.key}: file="${declared}" json="${entry.name}"`);
    }
    expect(mismatches).toEqual([]);
  });

  it('ogni website e’ un https assoluto', () => {
    const bad = companies
      .filter((e) => e.website !== undefined)
      .filter((e) => !/^https:\/\/[^/\s]+$/.test(e.website as string));
    expect(bad.map((e) => `${e.key}=${e.website}`)).toEqual([]);
  });

  it('nessun campo porta un placeholder di template non risolto', () => {
    // Un `${...}` in un `careersUrl` e' un link rotto servito a un utente, non
    // una stringa brutta in un file di dati.
    const leaked = companies.filter((e) => /\$\{/.test(JSON.stringify(e)));
    expect(leaked.map((e) => e.key)).toEqual([]);
  });
});

/**
 * Il registro sopra puo' essere perfetto e comunque sbagliato, se nessuno lo
 * rigenera.
 *
 * E' successo per mesi: `generate-crawler-companies.mjs` esisteva, `npm run
 * companies:generate` esisteva, e non li chiamava NIENTE — ne' un workflow, ne'
 * uno stadio del prospector. Il file e' rimasto a 213 voci mentre i runner
 * arrivavano a 614, cioe' 401 datori con crawler dedicato invisibili nella
 * directory pubblica, e gli invarianti qui sopra restavano tutti verdi: erano
 * veri su uno snapshot vecchio.
 *
 * Il gancio e' `scripts/prospect-promote.mjs`, l'unico punto del repo che
 * cambia l'insieme dei crawler in produzione. Questi test lo tengono agganciato.
 *
 * Sono osservatori SUL SORGENTE, ed e' una scelta, non una scorciatoia:
 * `prospect-promote.mjs` e' uno script top-level che al primo import aprirebbe
 * PR vere e leggerebbe lo store dei candidati, quindi non ha superficie
 * importabile da esercitare. Cio' che deve restare vero e' comunque strutturale
 * — chi chiama chi, e in che ordine rispetto ai due guard che lo delimitano —
 * e su quello un'asserzione sul sorgente non e' un'approssimazione.
 */
describe('il registro si rigenera a ogni promozione, non a mano', () => {
  const promoteSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'prospect-promote.mjs'), 'utf8');
  const generatorSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'generate-crawler-companies.mjs'), 'utf8');

  /** Indice della prima occorrenza, con un messaggio utile se manca. */
  const at = (src: string, needle: string): number => {
    const i = src.indexOf(needle);
    expect(i, `atteso nel sorgente: ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('prospect-promote.mjs invoca il generatore', () => {
    expect(promoteSrc).toContain("'scripts/generate-crawler-companies.mjs'");
  });

  it('lo invoca DOPO il guard sui promossi, cosi’ un giro a zero non tocca il file', () => {
    // Il vincolo: nessuna rigenerazione se l'insieme dei crawler non e'
    // cambiato. Il guard `!shipped.length` esce dal processo, quindi «dopo il
    // guard» e' letteralmente cio' che lo garantisce — non un `if` in piu' da
    // tenere allineato.
    const guard = at(promoteSrc, 'if (!shipped.length) {');
    const regen = at(promoteSrc, "'scripts/generate-crawler-companies.mjs'");
    expect(regen).toBeGreaterThan(guard);

    // E anche dopo l'uscita per `--dry-run`, che non ha scaffoldato niente.
    expect(regen).toBeGreaterThan(at(promoteSrc, "console.log('\\n--dry-run: niente scritto.')"));
  });

  it('lo invoca PRIMA del commit, cosi’ il diff viaggia nella stessa PR', () => {
    // Se la rigenerazione finisse dopo `git commit`, il file resterebbe
    // modificato e non committato: la PR di promozione arriverebbe senza il
    // registro aggiornato e `main` resterebbe incoerente — esattamente lo stato
    // che questo aggancio esiste per chiudere.
    const regen = at(promoteSrc, "'scripts/generate-crawler-companies.mjs'");
    expect(regen).toBeLessThan(at(promoteSrc, "git('add'"));
    expect(regen).toBeLessThan(at(promoteSrc, "git('commit'"));
  });

  it('committa il registro solo se la rigenerazione e’ riuscita', () => {
    // Il ramo di fallimento non interrompe la promozione, quindi senza questo
    // guard un fallimento committerebbe comunque cio' che c'e' sul disco.
    expect(promoteSrc).toContain("if (companiesRegenerated) paths.push('data/crawler-companies-auto.json');");
  });

  it('il corpo della PR nomina il file di dati che il diff tocca', () => {
    // Stesso gap di #6301/#6279: un file pubblico modificato dal diff e mai
    // citato nel body. Entrambi i rami devono dire qualcosa — anche quello di
    // fallimento, che informa che la directory e' indietro.
    const bodyStart = at(promoteSrc, 'const body = `## Implementato');
    const nonImpl = promoteSrc.indexOf('## Non implementato (ancora)', bodyStart);
    const implementato = promoteSrc.slice(bodyStart, nonImpl);
    expect(implementato).toContain('${companiesNote}');
    expect(promoteSrc).toContain('const companiesNote = companiesRegenerated');
  });

  it('il generatore scrive in modo atomico: mai un JSON troncato su disco', () => {
    // `data/crawler-companies-auto.json` e' importato a build time da
    // `TicinoCompanies`: un file scritto a meta' non e' un dato sbagliato, e'
    // una build rotta — e da quando lo produce una pipeline non presidiata,
    // sarebbe una build rotta committata dentro una PR che nessuno legge.
    //
    // L'atomicita' arriva dal modulo condiviso (`writeJsonAtomic`, issue
    // #2805), non da una tmp+rename riscritta qui: una copia locale sarebbe la
    // numero 96 e deriverebbe dal resto il giorno dopo.
    expect(generatorSrc).toContain('writeJsonAtomic(OUTPUT, companies)');
    expect(generatorSrc).toContain("from './lib/atomic-write-json.mjs'");
    // La scrittura diretta sulla destinazione e' proprio cio' che il modulo
    // sostituisce: se ricompare, l'atomicita' e' persa senza che nulla lo dica.
    expect(generatorSrc).not.toMatch(/fs\.writeFileSync\(\s*OUTPUT\b/);
  });

  it('writeJsonAtomic scrive davvero via rename, e ripulisce il temporaneo', async () => {
    // L'unica asserzione qui che NON e' sul sorgente: il modulo condiviso e'
    // importabile, quindi la garanzia si esercita invece di descriverla.
    const { writeJsonAtomic } = await import('../scripts/lib/atomic-write-json.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-companies-'));
    const target = path.join(dir, 'registry.json');
    try {
      fs.writeFileSync(target, '["vecchio"]\n', 'utf8');
      writeJsonAtomic(target, [{ name: 'ACME SA', key: 'acme' }]);
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual([{ name: 'ACME SA', key: 'acme' }]);
      // Byte identici a cio' che il generatore scriveva prima: 2 spazi di
      // indentazione e newline finale, cosi' il passaggio al modulo condiviso
      // non produce un diff cosmetico su 600 voci.
      expect(fs.readFileSync(target, 'utf8')).toBe(
        JSON.stringify([{ name: 'ACME SA', key: 'acme' }], null, 2) + '\n',
      );
      // Nessun `.tmp` sopravvissuto accanto alla destinazione: in `data/` un
      // residuo untracked confonde il `git status` della PR senza dire niente.
      expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
