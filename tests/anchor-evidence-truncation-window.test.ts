/**
 * L'OSSERVATORE del troncamento dell'evidenza.
 *
 * ── IL DIFETTO ───────────────────────────────────────────────────────────────
 *
 * `anchorEvidence` promette, nel proprio docblock, di non restituire mai una
 * citazione sbagliata: «Returns '' when the anchor cannot be located (the
 * instruction then degrades to naming it, never to a wrong quote)». La promessa
 * era vera per la RICERCA della frase e falsa per il suo TRONCAMENTO: la frase
 * veniva tagliata ai primi 237 caratteri a prescindere da dove stesse il fatto,
 * quindi un dato oltre quella soglia spariva dalla propria citazione. Il rimedio
 * diceva «reintegra DATEC — la fonte dice: "<237 char senza DATEC>"», cioe'
 * esattamente una citazione sbagliata, e in silenzio: il prompt resta ben
 * formato, la CI verde, il gate continua a bocciare l'articolo.
 *
 * E' il difetto peggiore della famiglia, non il piu' innocuo: il writer
 * reintegra CIO' CHE GLI VIENE MOSTRATO. Una citazione che non contiene il dato
 * lo spinge a ricostruirlo a memoria — che e' il modo in cui un «80%» perso
 * torna inventato, cioe' l'incidente per cui l'evidenza era stata aggiunta.
 *
 * ── LA MISURA ────────────────────────────────────────────────────────────────
 *
 * Sul corpus tirato (`frontaliere-articles/content`, 17.804 body, 65.223 ancore
 * con citazione): 1.689 ancore in 930 documenti ricevevano una citazione da 238
 * char che NON conteneva il proprio fatto. Dopo la finestra centrata: 0.
 * Le altre 63.534 restano byte-identiche — il fix e' additivo, non un
 * riformattatore.
 *
 * ── PERCHE' I TEST SONO SCRITTI COSI' ────────────────────────────────────────
 *
 * L'asserzione centrale non e' sulla lunghezza ma sulla PORTANZA: la citazione
 * deve contenere il fatto che chiede di reintegrare. L'oracolo e'
 * `anchorEvidence` stesso applicato alla citazione — lo stesso ago che ha
 * scelto la frase deve ritrovare il dato nel ritaglio. Il tetto dei 240 char e'
 * pinnato a parte come ratchet: una finestra che "risolve" allargandosi non
 * risolve niente, sposta il costo nel prompt.
 */
import { describe, expect, it } from 'vitest';
import {
  anchorEvidence,
  checkSourceFidelity,
  extractSourceAnchors,
  matchedAnchors,
  renderAnchorForPrompt,
} from '../scripts/lib/article-factuality-gates.mjs';

/** Il tetto dichiarato dal modulo: ellissi comprese, mai superato. */
const TETTO_CITAZIONE = 240;

/** Riempitivo neutro, senza cifre ne' sigle: non introduce ancore parassite. */
const zavorra = (n: number) => 'e la commissione paritetica ha ribadito il punto '.repeat(n);

/**
 * Forma reale, ricalcata su `blog-body/it/a2-giornico-cantiere-disagi-frontalieri`:
 * una frase lunga che apre con altre cifre e chiude con la sigla, oltre i 237
 * char. E' il caso che sul corpus produceva la citazione senza il fatto.
 */
const FRASE_SIGLA_IN_CODA = `Tuttavia l'aumento del traffico su questa arteria secondaria genera code nella tratta tra Biasca e Faido ${zavorra(3)}secondo le simulazioni del Dipartimento federale dell'ambiente, dei trasporti, dell'energia e delle comunicazioni (DATEC).`;

/** Stessa forma con una percentuale in coda, per coprire l'altro `kind`. */
const FRASE_PCT_IN_CODA = `Il rapporto annuale osserva che la situazione dei lavoratori pendolari resta sotto osservazione ${zavorra(3)}e la quota di posizioni interessate raggiunge il 5,3% del totale censito.`;

/** E una data in coda: il terzo `kind` con un ago non banale. */
const FRASE_DATA_IN_CODA = `Il documento ricostruisce l'iter della revisione parlamentare senza anticipare l'esito ${zavorra(3)}e ricorda che il testo e' entrato in vigore il 17 luglio 2023 in tutti i cantoni.`;

describe('anchorEvidence: la citazione troncata porta il fatto che nomina', () => {
  const casi: Array<[string, string, string]> = [
    ['sigla in coda', FRASE_SIGLA_IN_CODA, 'org:DATEC'],
    ['percentuale in coda', FRASE_PCT_IN_CODA, 'pct:5.3'],
    ['data in coda', FRASE_DATA_IN_CODA, 'date:2023-07-17'],
  ];

  for (const [nome, fonte, ancora] of casi) {
    it(`${nome}: il ritaglio contiene ancora il dato`, () => {
      expect(fonte.length, 'guardia: il fixture deve superare il tetto, o non troncherebbe')
        .toBeGreaterThan(TETTO_CITAZIONE);

      const citazione = anchorEvidence(fonte, ancora);
      expect(citazione, 'guardia: la frase deve essere localizzata').not.toBe('');

      // L'oracolo: lo stesso ago che ha scelto la frase ritrova il dato nel
      // ritaglio. Se no, il rimedio sta mostrando una citazione sbagliata.
      expect(
        anchorEvidence(citazione, ancora),
        `citazione senza il proprio fatto (${ancora} → «${citazione}»)`,
      ).not.toBe('');
    });

    it(`${nome}: il ritaglio resta entro il tetto di ${TETTO_CITAZIONE} char`, () => {
      expect(anchorEvidence(fonte, ancora).length).toBeLessThanOrEqual(TETTO_CITAZIONE);
    });
  }

  it('la frase corta non viene toccata, e quella col dato in testa taglia come prima', () => {
    // Additivo, non riformattatore: la finestra centrata entra in gioco SOLO
    // quando il taglio in testa perderebbe il dato. Senza questo pin, un
    // riscrittore libero cambierebbe 63.534 citazioni gia' corrette per
    // ripararne 1.689.
    const corta = "L'aliquota ordinaria resta al 5,3% per tutti i frontalieri.";
    expect(anchorEvidence(corta, 'pct:5.3')).toBe(corta);

    const inTesta = `L'aliquota ordinaria resta al 5,3% per tutti i frontalieri ${zavorra(5)}fino a nuovo avviso.`;
    expect(inTesta.length).toBeGreaterThan(TETTO_CITAZIONE);
    expect(anchorEvidence(inTesta, 'pct:5.3')).toBe(`${inTesta.slice(0, 237)}…`);
  });

  it('ancora non localizzabile: nessuna citazione, mai una sbagliata', () => {
    expect(anchorEvidence(FRASE_SIGLA_IN_CODA, 'org:INEXISTENTE')).toBe('');
    expect(anchorEvidence('', 'pct:5.3')).toBe('');
  });
});

describe('checkSourceFidelity: due frasi che collidono sui primi 237 char', () => {
  // Il caso che la PR #6029 dichiara di riparare col raggruppamento sulla frase
  // intera. Da solo il raggruppamento non bastava: le due citazioni troncate
  // erano byte-identiche e nessuna delle due conteneva il proprio dato, perche'
  // entrambi stanno oltre il char 237. Serve la finestra centrata perche' la
  // scissione produca due citazioni davvero distinte e davvero portanti.
  const PREFISSO = "Secondo il rapporto della commissione paritetica che monitora i lavoratori frontalieri residenti nella fascia di confine e occupati nei cantoni svizzeri di lingua italiana, il quadro delle retribuzioni resta stabile nel periodo osservato".padEnd(240, ' ').slice(0, 240);
  const FONTE = [
    `${PREFISSO} e la quota di lavoratori interessati raggiunge il 25% del totale.`,
    `${PREFISSO} mentre la quota di aziende coinvolte si ferma all'80% del campione.`,
    "Il contributo INPS resta invariato per tutto il 2026.",
  ].join(' ');

  const righeEvidenza = () => {
    const issues = checkSourceFidelity('Un articolo che non riporta nessun dato.', FONTE, {});
    const rate = issues.find((i: { code: string }) => i.code === 'source-key-rates-dropped');
    expect(rate, 'guardia: il fixture deve far scattare source-key-rates-dropped').toBeTruthy();
    return String(rate.fix).split('\n').filter((l) => l.includes('la fonte dice'));
  };

  it('ogni riga cita il proprio dato, e le due citazioni non coincidono', () => {
    const righe = righeEvidenza();
    expect(righe.length, 'due frasi distinte → due righe distinte').toBe(2);

    const riga25 = righe.find((l) => l.startsWith('25%'));
    const riga80 = righe.find((l) => l.startsWith("80%"));
    expect(riga25, 'etichetta 25% assente').toBeTruthy();
    expect(riga80, 'etichetta 80% assente').toBeTruthy();
    expect(riga25).toContain('25%');
    expect(riga80).toContain('80%');

    const cit = (l: string) => l.split('la fonte dice:')[1];
    expect(
      cit(riga25!),
      'due fatti diversi non possono condividere la stessa citazione troncata',
    ).not.toBe(cit(riga80!));
  });

  it('nessuna riga porta una citazione priva del proprio fatto', () => {
    for (const riga of righeEvidenza()) {
      const citazione = riga.slice(riga.indexOf('«') + 1, riga.lastIndexOf('»'));
      const etichette = riga.slice(0, riga.indexOf('—')).trim();
      // Almeno il primo dato nominato dalla riga deve stare nella citazione.
      const primo = etichette.split(',')[0].trim();
      expect(
        citazione.includes(primo.replace(/…/g, '')),
        `riga «${etichette}» con citazione che non lo contiene: ${citazione.slice(0, 80)}…`,
      ).toBe(true);
    }
  });
});

describe('invariante di famiglia', () => {
  it('su un corpus sintetico, nessuna ancora riceve una citazione priva del fatto', () => {
    // Sedici forme che spostano il dato lungo tutta la frase: prima del taglio,
    // a cavallo, e ben oltre. E' la generalizzazione dei tre casi sopra, cosi'
    // un fix che ripara solo la coda non passa.
    const offensori: string[] = [];
    for (let i = 0; i <= 15; i += 1) {
      const fonte = [
        `${zavorra(i)}l'aliquota applicata e' del 5,3% e resta invariata ${zavorra(15 - i)}.`,
        `${zavorra(i)}la distanza coperta e' di 20 km lungo il tracciato ${zavorra(15 - i)}.`,
        `${zavorra(i)}il testo e' in vigore dal 17 luglio 2023 senza proroghe ${zavorra(15 - i)}.`,
      ].join(' ');
      for (const a of extractSourceAnchors(fonte)) {
        const citazione = anchorEvidence(fonte, a);
        if (!citazione) continue;
        if (citazione.length > TETTO_CITAZIONE) offensori.push(`${a}@${i}: ${citazione.length} char`);
        if (!anchorEvidence(citazione, a)) offensori.push(`${a}@${i}: citazione senza il fatto`);
      }
    }
    expect(offensori, `citazioni difettose:\n${offensori.join('\n')}`).toEqual([]);
  });

  it("l'etichetta chiesta al writer e' quella che il recall check accredita", () => {
    // Pin di contorno: la citazione porta il dato nella forma che
    // `matchedAnchors` riconosce, non in una qualsiasi.
    const citazione = anchorEvidence(FRASE_PCT_IN_CODA, 'pct:5.3');
    expect(citazione).toContain(renderAnchorForPrompt('pct:5.3'));
    expect(matchedAnchors(citazione, new Set(['pct:5.3'])).has('pct:5.3')).toBe(true);
  });
});
