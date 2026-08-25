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
    //  - un'uguaglianza esatta sarebbe un wedge: i runner arrivano dalla PR di
    //    promozione del prospector, che non rigenera questo file, e ogni
    //    promozione renderebbe `main` rosso finche' qualcuno non lancia
    //    `npm run companies:generate`.
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
