/**
 * followup-drainer — `detectSiblingDebt`: il gemello dichiarato in PROSA.
 *
 * Una follow-up aggregata dice a parole che un file `mode: identical`/`adapted`
 * ha un gemello sull'altro repo del workspace non ancora allineato. Prima di
 * questo detector quella frase restava prosa dentro una issue che l'altro repo
 * non vede mai: `loop-drift-check` confronta i file del manifest e non legge le
 * issue, il drainer legge le issue e non riconosceva la forma.
 *
 * Le fixture sono VERBATIM dalle follow-up aperte il 2026-08-25 (8 su 47, tutte
 * sul corpus, che è il lato a valle del mirror) — non forme inventate.
 *
 * CONSERVATIVO: la sola parola «gemello», o un `#N` nudo, non bastano; il
 * marker deve stare entro ~100 caratteri, perché i body reali hanno righe da
 * 300+ in cui due proposizioni scorrelate finiscono sulla stessa riga.
 */
import { describe, it, expect } from 'vitest';
import { detectSiblingDebt, siblingSideOf } from '../scripts/ci/followup-drainer.mjs';

const SITE = 'valerielinc-ops/frontaliere-si-o-no';
const CORPUS = 'nanakokyobashi-rgb/frontaliere-articles';

/** Verbatim: titolo di corpus#513. */
const T_513 = 'follow-up(#474): gemello sito ai-models.mjs non riceve la correzione del commento/test (blocked su valerielinc-ops#6045)';
/** Verbatim: titolo di corpus#511. */
const T_511 = 'follow-up(#465): gemello sito exhaustion-disposition.mjs non portato (blocked) + gate CI per exit 124 di generate-article (blocked, serve baseline)';
/** Verbatim: una riga del body di corpus#403 — marker PRIMA della parola gemello. */
const L_403 = '- blocked: serve una passata di riconciliazione sul gemello del sito.';
/**
 * Verbatim: la riga di sito#6222 (329 caratteri) che il match a riga intera
 * classificava come sibling-debt. «blocked: serve la misura…» e «nessun file
 * gemello introdotto» sono due proposizioni scorrelate a ~180 caratteri l'una
 * dall'altra. È il falso positivo che ha imposto la finestra di prossimità.
 */
const FP_6222 = 'Item escluso in dedup: la voce originale della PR body su "soglie dist:quality-tests al 60%, blocked: serve la misura di due o tre run consecutivi" e\' duplicate of #6192 item 1 (stesso tema, stato aggiornato). La voce "per scelta — nessun file gemello introdotto" e\' esclusa come stato chiudente motivato (per scelta con motivo).';

describe('siblingSideOf — il lato si legge dal NOME del repo, non dall\'owner', () => {
  it('il corpus è il repo che si chiama frontaliere-articles', () => {
    expect(siblingSideOf(CORPUS)).toBe('corpus');
  });

  it('il sito è tutto il resto (gh è autenticato come valerielinc-ops su entrambi)', () => {
    expect(siblingSideOf(SITE)).toBe('site');
    expect(siblingSideOf('')).toBe('site');
  });
});

describe('detectSiblingDebt — forme reali (verbatim dalle issue aperte)', () => {
  it('corpus#513: «gemello sito X non riceve …» + ref cross-repo al sito', () => {
    const d = detectSiblingDebt(T_513, CORPUS);
    expect(d).not.toBeNull();
    expect(d!.repo).toBe(SITE);
    expect(d!.refs).toContain(`${SITE}#6045`);
    // Il nome del gemello è nudo (nessuna directory): va nominato lo stesso,
    // è la sola informazione utile a chi legge dall'altro lato.
    expect(d!.files).toContain('ai-models.mjs');
  });

  it('corpus#511: «gemello sito X non portato (blocked)», nessun ref cross-repo', () => {
    const d = detectSiblingDebt(T_511, CORPUS);
    expect(d).not.toBeNull();
    expect(d!.repo).toBe(SITE);
    expect(d!.files).toContain('exhaustion-disposition.mjs');
  });

  it('corpus#403: marker PRIMA della parola gemello («blocked … sul gemello del sito»)', () => {
    expect(detectSiblingDebt(L_403, CORPUS)).not.toBeNull();
  });

  it('il lato indicato è sempre l\'ALTRO repo: la stessa prosa sul sito punta al corpus', () => {
    const d = detectSiblingDebt('il gemello corpus di scripts/lib/ai-models.mjs non è ancora allineato', SITE);
    expect(d).not.toBeNull();
    expect(d!.repo).toBe(CORPUS);
    expect(d!.files).toContain('scripts/lib/ai-models.mjs');
  });
});

describe('detectSiblingDebt — conservativo (bias a NON etichettare)', () => {
  it('sito#6222: «blocked …» e «… gemello …» distanti ~180 char sulla stessa riga → nessun debito', () => {
    expect(detectSiblingDebt(FP_6222, SITE)).toBeNull();
  });

  it('la sola parola «gemello», senza marker, non basta', () => {
    expect(detectSiblingDebt('Il gemello corpus di questo file è già allineato, verificato oggi.', SITE)).toBeNull();
  });

  it('un `#N` nudo è un riferimento LOCALE e non prova niente sul gemello', () => {
    expect(detectSiblingDebt('- blocked: dipende da #6045, non ancora mergiata', CORPUS)).toBeNull();
  });

  it('un ref cross-repo SENZA `blocked` che lo precede non basta (citazione, non debito)', () => {
    expect(detectSiblingDebt(`Vedi ${SITE}#6045 per il contesto storico.`, CORPUS)).toBeNull();
  });

  it('un ref al PROPRIO repo non è un debito verso il gemello', () => {
    expect(detectSiblingDebt(`- blocked su ${SITE}#6045`, SITE)).toBeNull();
  });

  it('body vuoto/assente → null (nessuna decisione su niente)', () => {
    expect(detectSiblingDebt('', CORPUS)).toBeNull();
    expect(detectSiblingDebt(undefined as unknown as string, CORPUS)).toBeNull();
  });

  it('la prossimità non attraversa le righe: marker e «gemello» su righe diverse non matchano', () => {
    expect(detectSiblingDebt('- blocked: la CI è rossa\n- il gemello è stato allineato ieri', CORPUS)).toBeNull();
  });
});
