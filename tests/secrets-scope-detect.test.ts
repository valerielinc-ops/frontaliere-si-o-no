/**
 * secrets-scope-detect — pre-promotion detector for followup-drainer.mjs
 * (escalation #5057, bucket fix-outcome:blocked-secrets 6x/14d).
 *
 * `cloudflare-5xx` / `campaign-goal` / `evergreen-refresh` issues used to
 * structurally require a Firebase-RC-loaded credential never available to
 * `issue-fix` (GH_TOKEN only) — promoting them to `agent:fix` always burned a
 * full Claude run that ended `blocked-secrets`. This detector intercepted
 * them PRE-promotion, mirroring `detectWorkflowScoped` (#1724). From
 * 2026-08-24 `issue-fix.yml` loads Remote Config too (owner decision,
 * VISION.md), so that credential is now present and the drainer promotes
 * these anyway — the detector's match is logged, not parking. CONSERVATIVE
 * (bias to promote): only the 3 known monitor-applied labels ever match.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  detectRemoteConfigScoped,
  detectSecretsScoped,
  matchSecretsScopedLabel,
  matchSecretsScopedShape,
  SECRETS_SCOPED_LABELS,
} from '../scripts/lib/secrets-scope-detect.mjs';
import {
  detectSecretsScoped as reExported,
  matchSecretsScopedShape as reExportedShape,
} from '../scripts/ci/followup-drainer.mjs';

describe('detectSecretsScoped — scoped (park preemptivo)', () => {
  it('rileva la label cloudflare-5xx (CF 5xx monitor, richiede CF_API_TOKEN)', () => {
    expect(detectSecretsScoped(['priority:medium', 'stability', 'cloudflare-5xx'])).toBe(true);
  });

  it('rileva la label campaign-goal (richiede POSTHOG_PERSONAL_API_KEY)', () => {
    expect(detectSecretsScoped(['seo', 'campaign-goal'])).toBe(true);
  });

  it('rileva la label evergreen-refresh (richiede GEMINI_API_KEY/GH_MODELS_PAT)', () => {
    expect(detectSecretsScoped(['content', 'evergreen-refresh'])).toBe(true);
  });

  it('è re-esportato invariato da followup-drainer.mjs', () => {
    expect(reExported(['cloudflare-5xx'])).toBe(true);
  });
});

describe('detectSecretsScoped — NON scoped (promuovi)', () => {
  it('non scatta senza nessuna delle 3 label note', () => {
    expect(detectSecretsScoped(['follow-up', 'fu-prio:high', 'bug'])).toBe(false);
  });

  it('non scatta su prose/label simili ma non esatte (es. "revenue")', () => {
    expect(detectSecretsScoped(['revenue', 'priority:high'])).toBe(false);
  });

  it('gestisce input vuoto/null/undefined senza throw', () => {
    expect(detectSecretsScoped([])).toBe(false);
    expect(detectSecretsScoped(null as unknown as string[])).toBe(false);
    expect(detectSecretsScoped(undefined as unknown as string[])).toBe(false);
  });
});

describe('matchSecretsScopedLabel', () => {
  it('ritorna label + secret + reason per un match', () => {
    const match = matchSecretsScopedLabel(['stability', 'cloudflare-5xx']);
    expect(match).not.toBeNull();
    expect(match?.label).toBe('cloudflare-5xx');
    expect(match?.secret).toBe('CF_API_TOKEN');
    expect(typeof match?.reason).toBe('string');
  });

  it('ritorna null senza match', () => {
    expect(matchSecretsScopedLabel(['bug', 'priority:high'])).toBeNull();
  });

  it('ogni entry di SECRETS_SCOPED_LABELS ha secret e reason non vuoti', () => {
    for (const [label, meta] of Object.entries(SECRETS_SCOPED_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(meta.secret.length).toBeGreaterThan(0);
      expect(meta.reason.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5838 — il gate esisteva e NON guardava questa forma
//
// Rimisurato il 2026-08-14: il bucket `fix-outcome:blocked-secrets` contava ancora
// 7 ricorrenze su 14gg, cioe' lo stesso numero che #5057 aveva gia' affrontato, e
// NESSUNA delle 7 portava una delle 3 label. Il banco qui sotto usa i body VERI
// delle 7 (`tests/fixtures/secrets-scope/site-<n>.md`) e fissa il ratchet: le 3
// della famiglia «scrivi un parametro su Remote Config» devono essere parcheggiate
// PRE-promozione, le altre 4 devono restare promosse.
//
// Il campione largo (300 issue reali) misurato quando la regola e' stata scritta
// dava 3 park su 300 — esattamente queste 3, zero falsi positivi.
// ─────────────────────────────────────────────────────────────────────────────
describe('detectRemoteConfigScoped — il ratchet di #5838 sui body reali', () => {
  const fixture = (n: number) =>
    readFileSync(join(__dirname, 'fixtures/secrets-scope', `site-${n}.md`), 'utf8');

  // La famiglia che accelerava: 3 delle 7, tutte negli ultimi 3 giorni prima della fix.
  const PARK = [
    [5824, 'impostare NEWSLETTER_TOKEN_LEGACY_SUNSET su Remote Config'],
    [5758, 'flip Remote Config NEWSLETTER_TOKEN_SCHEME=v1'],
    [5737, 'flip Remote Config NEWSLETTER_AC_SCHEME=v1 + NEWSLETTER_AC_TTL_DAYS=30'],
  ] as const;

  // Le 4 che restano fuori PER SCELTA MISURATA, non per dimenticanza.
  const PROMOTE = [
    [5699, 'il testo vive nel repo del corpus: confine di push, non di credenziale'],
    [5696, 'offre un fix di codice VERO su questo repo (allowlist article-factuality-gates)'],
    [5629, 'blocked: decisione del proprietario — e\' una domanda, non un difetto tecnico'],
    [5607, 'RangeError PostHog: spesso un difetto di codice dell\'app, fixabile senza credenziali'],
  ] as const;

  it.each(PARK)('#%i e\' parcheggiata pre-promozione (%s)', (n) => {
    expect(detectRemoteConfigScoped(fixture(n))).toBe(true);
  });

  it.each(PROMOTE)('#%i resta PROMOSSA (%s)', (n) => {
    expect(detectRemoteConfigScoped(fixture(n))).toBe(false);
  });

  it('il conteggio del bucket scende da 7 a 4 sulla stessa finestra', () => {
    const all = [...PARK, ...PROMOTE].map(([n]) => n);
    const parked = all.filter((n) => detectRemoteConfigScoped(fixture(n)));
    expect(all).toHaveLength(7);
    expect(parked).toHaveLength(3);
    expect(all.length - parked.length).toBe(4);
  });
});

describe('detectRemoteConfigScoped — le tre congiunzioni, una per una', () => {
  const PARAM = 'NEWSLETTER_TOKEN_SCHEME';

  it('parcheggia superficie + parametro, senza codice citato', () => {
    expect(detectRemoteConfigScoped(`Impostare \`${PARAM}=v1\` su Firebase Remote Config.`)).toBe(true);
  });

  it('(1) senza la superficie non scatta: un parametro da solo non basta', () => {
    expect(detectRemoteConfigScoped(`Il valore di \`${PARAM}\` va portato a v1.`)).toBe(false);
  });

  it('(2) senza un parametro non scatta: "Remote Config" in prosa non e\' un\'istruzione di scrittura', () => {
    expect(detectRemoteConfigScoped('La configurazione del progetto sta su Firebase Remote Config, non nei file.')).toBe(false);
  });

  it('(3) VALVOLA DI PROMOZIONE: se cita codice, si promuove comunque', () => {
    expect(
      detectRemoteConfigScoped(
        `Impostare \`${PARAM}=v1\` su Remote Config e aggiornare \`scripts/lib/newsletter-token.mjs\`.`,
      ),
    ).toBe(false);
  });

  it('gli acronimi della prosa non passano per parametri (LPD, AVS, INPS, CHF)', () => {
    expect(
      detectRemoteConfigScoped('Diffida LPD: gli importi AVS e INPS in CHF vanno su Remote Config.'),
    ).toBe(false);
  });

  it('non lancia su input vuoto/null/undefined', () => {
    expect(detectRemoteConfigScoped('')).toBe(false);
    expect(detectRemoteConfigScoped(null as unknown as string)).toBe(false);
    expect(detectRemoteConfigScoped(undefined as unknown as string)).toBe(false);
  });
});

describe('matchSecretsScopedShape — label e testo nella stessa risposta', () => {
  it('la label ha precedenza e si dichiara via:label', () => {
    const m = matchSecretsScopedShape({ labels: ['cloudflare-5xx'], text: 'qualunque cosa' });
    expect(m?.via).toBe('label');
    expect(m?.label).toBe('cloudflare-5xx');
  });

  it('senza label, la forma Remote Config si dichiara via:remote-config e nomina i parametri', () => {
    const m = matchSecretsScopedShape({
      labels: ['follow-up', 'funnel-ux'],
      text: 'Flip Remote Config a `NEWSLETTER_AC_SCHEME=v1` e `NEWSLETTER_AC_TTL_DAYS=30`.',
    });
    expect(m?.via).toBe('remote-config');
    expect(m?.params).toContain('NEWSLETTER_AC_SCHEME');
    expect(m?.secret).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(m?.reason.length).toBeGreaterThan(0);
  });

  it('ritorna null quando ne la label ne il testo scattano', () => {
    expect(matchSecretsScopedShape({ labels: ['bug'], text: 'un difetto di rendering' })).toBeNull();
  });

  it('e\' re-esportato invariato da followup-drainer.mjs', () => {
    expect(reExportedShape({ labels: ['cloudflare-5xx'] })?.via).toBe('label');
  });
});

// Il pre-flight del drainer deve USARE la forma completa, non piu' la sola label:
// un detector giusto cablato al posto sbagliato e' una guardia che non guarda.
describe('#5838 — poi CADUTO per decisione del proprietario (2026-08-24)', () => {
  const SRC = readFileSync(join(__dirname, '../scripts/ci/followup-drainer.mjs'), 'utf8');

  // Fino al 2026-08-24 questo blocco pinnava l'opposto: il pre-flight del
  // drainer doveva parcheggiare su forma completa (label O testo), e
  // `isCapabilityScoped` doveva condividere quella stessa forma per non aprire
  // un ciclo un-park -> park fra parked-retry e pre-promozione. Era corretto
  // finché il fixer del sito girava senza credenziali: una issue secrets-scoped
  // era un blocco di capacità reale.
  //
  // Il proprietario ha autorizzato in modo permanente l'uso dei secret dal
  // ciclo autonomo (registro in VISION.md) e `issue-fix.yml` carica Remote
  // Config prima di ogni run: una issue secrets-scoped è ora lavoro normale.
  // Questi due test sono INVERTITI, non cancellati — sono il punto dove un
  // ripristino accidentale del vecchio guard diventerebbe rosso invece di
  // annullare la decisione in silenzio.

  it('il pre-flight OSSERVA ancora la forma (matcher condiviso, zero-Claude), ma non parcheggia più su di essa', () => {
    // Il rilevatore resta collegato come SEGNALE: se il caricamento dei secret
    // smettesse di funzionare, questa riga accanto a un `blocked-secrets` reale
    // renderebbe immediata la correlazione. Vedi il commento sopra
    // `secretsMatch` nel drainer per la stessa ragione, per esteso.
    expect(SRC).toContain('matchSecretsScopedShape({');
    const call = SRC.slice(SRC.indexOf('const secretsMatch = matchSecretsScopedShape('));
    expect(call.slice(0, 200)).toContain('text:');
    // La promozione avviene comunque: NON deve esserci più un `park` legato a
    // questo match nello stesso blocco.
    const block = SRC.slice(SRC.indexOf('if (secretsMatch) {'), SRC.indexOf('if (secretsMatch) {') + 900);
    expect(block).not.toContain("edit(cand.number, { add: [LBL_PARKED]");
  });

  it('isCapabilityScoped NON chiama più matchSecretsScopedShape: esclude solo su workflows-scope reale', () => {
    // La funzione porta un commento che RACCONTA la rimozione — cita
    // `matchSecretsScopedShape` in prosa apposta, come nota storica — quindi il
    // test isola il CORPO ESEGUITO (dal `try` in poi) e non l'intera funzione
    // commento incluso, o assertirebbe il falso sulla base delle parole sbagliate.
    expect(SRC).toContain('isCapabilityScoped(iss)');
    const start = SRC.indexOf('function isCapabilityScoped');
    const body = SRC.slice(SRC.indexOf('try {', start), SRC.indexOf('} catch { return true; }', start));
    expect(body).not.toContain('matchSecretsScopedShape');
    expect(body).not.toContain('isSecretsScoped');
    expect(body).toContain('isWorkflowScoped');
  });
});
