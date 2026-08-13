/**
 * Proof of consent: what the subscriber was told, and where from (#5678, #5676).
 *
 * Two measurements on production, 2026-08-12, over 8.605
 * `newsletter_subscribers` documents:
 *   - `consent_text` present on 100. Absent on 8.505 (98,8%).
 *   - a consent IP present on 0. The only IP field in the whole collection was
 *     `unsubscribe_ip`, on 28 documents: the network of everyone who LEFT and
 *     of nobody who arrived.
 *
 * The first number is not a missing write. `captureNewsletterSubscriber` has
 * always persisted `input.consentText`; the callers passed nothing. So the
 * fix is at the call sites, and the test that keeps it fixed has to make the
 * absence impossible rather than merely absent — hence the creation guard
 * below, and hence the source-level census that no sixth signup path can quietly
 * skip.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED HERE
 * ----------------------------------------
 * That anything was backfilled. For the 8.505 existing documents the text and
 * the IP were never collected and are not derivable from anything we hold. The
 * honest answer to an art. 25 request about them is that the data does not
 * exist, and a test that accepted a default, an inferred value or the source
 * name standing in for the text would be helping to manufacture the very
 * evidence the record is supposed to be.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const setDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const addDocMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: 'evt-1' }));
const getDocMock = vi.fn<(...args: unknown[]) => Promise<{ exists: () => boolean; data: () => any }>>();

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  addDoc: (...args: unknown[]) => addDocMock(...args),
  increment: vi.fn((n: number) => ({ __increment: n })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

import { captureNewsletterSubscriber } from '@/services/newsletterSubscribers';
import { CONSENT_TEXTS, consentProof, oauthConsentMethod } from '@/services/consentTexts';
import { anonymizeIp, buildConsentIpStamp } from '../functions/src/lib/requestForensics.js';

const repoRoot = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const NOT_EXISTS = { exists: () => false, data: () => undefined };
const payloadOf = () => (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;

describe('captureNewsletterSubscriber — a new subscriber cannot exist without a consent text', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('refuses to CREATE a subscriber when no consent text is supplied', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);

    await expect(
      captureNewsletterSubscriber({} as any, {
        email: 'new@example.com',
        source: 'signup',
        sourceChannel: 'auth_google',
        isActive: true,
      }),
    ).rejects.toThrow(/consent-text-required/);

    // And it refuses BEFORE writing: a document that exists with no record of
    // what was disclosed is exactly the 8.505 state this is here to stop
    // growing. Nor an event, which would leave a subscribe_completed for a
    // subscriber that was never created.
    expect(setDocMock).not.toHaveBeenCalled();
    expect(addDocMock).not.toHaveBeenCalled();
  });

  it('accepts the creation once the caller names its formula', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);

    const result = await captureNewsletterSubscriber({} as any, {
      email: 'new@example.com',
      source: 'signup',
      sourceChannel: 'auth_google',
      isActive: true,
      ...consentProof('signInAutoSubscribe', 'google_oauth'),
    });

    expect(result.id).toBe('new@example.com');
    expect(payloadOf().consent_text).toBe(CONSENT_TEXTS.signInAutoSubscribe.text);
  });

  it('does NOT break the 8.505 documents that already lack one', async () => {
    // The guard is scoped to creation on purpose. A sign-in by one of the
    // existing subscribers must keep working — their text was never collected,
    // is not reconstructible, and throwing here would turn a documentation gap
    // into a production outage for 98,8% of the list.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ email: 'legacy@example.com', status: 'confirmed', isActive: true }),
    });

    const result = await captureNewsletterSubscriber({} as any, {
      email: 'legacy@example.com',
      source: 'signup',
      isActive: true,
    });

    expect(result.id).toBe('legacy@example.com');
    // …and the gap is carried forward as a gap. Not a default, not the source
    // name wearing the text's clothes: null, which is the true answer.
    expect(payloadOf().consent_text).toBeNull();
  });

  it('carries an existing text forward when a later write omits it', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        email: 'known@example.com',
        status: 'confirmed',
        isActive: true,
        consent_text: 'formula precedente',
        consent_text_version: '1',
      }),
    });

    await captureNewsletterSubscriber({} as any, {
      email: 'known@example.com',
      source: 'signup',
      isActive: true,
    });

    expect(payloadOf().consent_text).toBe('formula precedente');
    expect(payloadOf().consent_text_version).toBe('1');
  });
});

describe('the consent block written alongside the text', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('stores the version, the displayed flag and the act, not just the string', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);

    await captureNewsletterSubscriber({} as any, {
      email: 'job@example.com',
      source: 'job_gate',
      sourcePage: '/lavoro/annuncio',
      ...consentProof('jobUnlockEmail', 'email_submit'),
    });

    const payload = payloadOf();
    expect(payload.consent_text).toBe(CONSENT_TEXTS.jobUnlockEmail.text);
    expect(payload.consent_text_version).toBe(CONSENT_TEXTS.jobUnlockEmail.version);
    expect(payload.consent_text_displayed).toBe(false);
    expect(payload.consent_act).toBe('typed_email_submit');
    expect(payload.consent_method).toBe('email_submit');
    // art. 25 asks for the URL of the form, and `sourcePage` is what supplies it.
    expect(payload.consent_source_url).toBe('/lavoro/annuncio');
  });

  it('leaves consent_given false on paths that collected no affirmative opt-in', async () => {
    // The heart of the anti-fabrication rule. A sign-in records WHAT WAS SAID,
    // never a claim that the person agreed to it — that assertion belongs to
    // the 100 documents that earned it, and inflating the count would destroy
    // the only clean signal in the collection.
    getDocMock.mockResolvedValue(NOT_EXISTS);

    await captureNewsletterSubscriber({} as any, {
      email: 'signin@example.com',
      source: 'signup',
      isActive: true,
      ...consentProof('signInAutoSubscribe', 'social_signin'),
    });

    expect(payloadOf().consent_given).toBe(false);
    expect(payloadOf().consent_given_at).toBeNull();
  });

  it('distinguishes "never recorded" from an explicit false on the displayed flag', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ email: 'legacy@example.com', consent_text: 'vecchia formula' }),
    });

    await captureNewsletterSubscriber({} as any, {
      email: 'legacy@example.com',
      source: 'signup',
    });

    // null, not false: nobody ever asked the question for this document.
    expect(payloadOf().consent_text_displayed).toBeNull();
  });
});

describe('consent_ip — the network the consent came from (#5676)', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('is written into the same consent block when a server-side caller supplies it', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);

    await captureNewsletterSubscriber({} as any, {
      email: 'ip@example.com',
      source: 'signup',
      consentIp: '203.0.113.0',
      ...consentProof('signInAutoSubscribe', 'google_oauth'),
    });

    expect(payloadOf().consent_ip).toBe('203.0.113.0');
    expect(payloadOf().consent_ip_recorded_at).toEqual(expect.any(String));
  });

  it('never overwrites an IP already on the document', async () => {
    // Inverted precedence versus every other field in the write, and the whole
    // point: `consent_ip` must stay the network of the CONSENT. A login from
    // the office six months later would otherwise silently replace the address
    // that answers the art. 25 question.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        email: 'ip@example.com',
        consent_text: 'formula precedente',
        consent_ip: '198.51.100.0',
        consent_ip_recorded_at: '2026-01-01T00:00:00.000Z',
      }),
    });

    await captureNewsletterSubscriber({} as any, {
      email: 'ip@example.com',
      source: 'signup',
      consentIp: '203.0.113.0',
    });

    expect(payloadOf().consent_ip).toBe('198.51.100.0');
    expect(payloadOf().consent_ip_recorded_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stays null rather than inventing one when nobody could observe it', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);

    await captureNewsletterSubscriber({} as any, {
      email: 'noip@example.com',
      source: 'signup',
      ...consentProof('signInAutoSubscribe', 'google_oauth'),
    });

    expect(payloadOf().consent_ip).toBeNull();
  });
});

describe('buildConsentIpStamp — the edge half of the same field', () => {
  it('reads cf-connecting-ip, the one header an external caller cannot forge', () => {
    const stamp = buildConsentIpStamp(
      { headers: { 'cf-connecting-ip': '203.0.113.42', 'x-forwarded-for': '10.0.0.1' } } as any,
      '2026-08-12T10:00:00.000Z',
    );
    expect(stamp?.consent_ip).toBe('203.0.113.0');
    expect(stamp?.consent_ip_recorded_at).toBe('2026-08-12T10:00:00.000Z');
  });

  it('truncates before storing — /24 for IPv4, /48 for IPv6 — never the raw address', () => {
    expect(buildConsentIpStamp({ headers: { 'cf-connecting-ip': '203.0.113.42' } } as any, 'x')?.consent_ip)
      .toBe('203.0.113.0');
    expect(buildConsentIpStamp({ headers: { 'cf-connecting-ip': '2001:db8:1234:5678::1' } } as any, 'x')?.consent_ip)
      .toBe('2001:db8:1234::');
    // Same truncation the unsubscribe side already uses: one rule, one function.
    expect(anonymizeIp('203.0.113.42')).toBe('203.0.113.0');
  });

  it('returns null instead of a placeholder when no address is readable', () => {
    expect(buildConsentIpStamp({ headers: {} } as any, 'x')).toBeNull();
    expect(buildConsentIpStamp({ headers: { 'cf-connecting-ip': 'not-an-ip' } } as any, 'x')).toBeNull();
  });
});

describe('functions/index.js — where the stamp is and is not applied', () => {
  const src = read('functions/index.js');

  it('stamps the three endpoints every genuinely new subscriber or job-alert consent reaches', () => {
    // The browser cannot see its own address, so these are the only moments in
    // the signup path (plus the job-alert consent gap, #5718) where one is
    // observable at all.
    expect(src).toMatch(/async function stampConsentIp\(/);
    expect(src).toMatch(/await stampConsentIp\(req, email\)/);
    expect(src.match(/await stampConsentIp\(/g) || []).toHaveLength(3);
  });

  it('does NOT stamp the autologin branch, which is a login and not a consent', () => {
    // `purpose === 'login'` is requested for an ALREADY EXISTING subscriber.
    // Stamping there would attach today's network to a consent given months
    // ago — a login dressed up as an opt-in.
    const confirmFn = src.slice(
      src.indexOf('newsletterSendConfirmation = onRequest'),
      src.indexOf('newsletterSendWelcome = onRequest'),
    );
    const at = confirmFn.indexOf('await stampConsentIp(req, email)');
    expect(at).toBeGreaterThan(-1);
    expect(confirmFn.slice(Math.max(0, at - 200), at)).toMatch(/if \(purpose === 'confirm'\)/);
  });

  it('stamps create_alert only after a real create, not on a rejected/invalid request (#5718)', () => {
    // `createJobAlert` never passes through `captureNewsletterSubscriber`, so
    // this call site was the one signup-adjacent consent moment left unstamped
    // after #5676. Gated on `result.status === 200` — an invalid/expired token
    // means no alert was actually created, so there is nothing to attribute.
    const manageFn = src.slice(
      src.indexOf('newsletterManageSubscription = onRequest'),
      src.indexOf('async function stampConsentIp('),
    );
    const at = manageFn.indexOf('await stampConsentIp(req, email)');
    expect(at).toBeGreaterThan(-1);
    expect(manageFn.slice(Math.max(0, at - 200), at)).toMatch(/action === 'create_alert' && result\.status === 200/);
  });

  it('never creates or overwrites: the first address recorded is the consent one', () => {
    const helper = src.slice(
      src.indexOf('async function stampConsentIp('),
      src.indexOf('newsletterSendConfirmation = onRequest'),
    );
    expect(helper).toMatch(/if \(!snap\.exists\) return;/);
    expect(helper).toMatch(/if \(typeof existing === 'string' && existing\.trim\(\)\) return;/);
    // Funnel-critical endpoints: an evidence field must never cost a signup.
    expect(helper).toMatch(/catch \(error\)/);
  });
});

describe('the register is versioned, and editing a formula cannot be silent', () => {
  /**
   * Every string and version pinned literally. This is the mechanism behind
   * "the text is versioned": revising a formula without bumping its `version`
   * fails here, so a reworded notice can never quietly become the thing older
   * subscribers are recorded as having been shown.
   */
  const PINNED: Record<string, { version: string; text: string }> = {
    communicationsOptIn: {
      version: '2026-08-13.1',
      text: 'Iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino. Cosa ricevo, con che frequenza, come disdire e chi tratta i dati: frontaliereticino.ch/comunicazioni (versione 2026-08-13.1).',
    },
    communicationsSignIn: {
      version: '2026-08-13.1',
      text: 'Accedendo iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino. Cosa ricevo, con che frequenza, come disdire e chi tratta i dati: frontaliereticino.ch/comunicazioni (versione 2026-08-13.1).',
    },
    // Same sentence as `communicationsSignIn`, different act — the email branch
    // of an access gate, which since #5765 shows ONE notice for both branches.
    // The duplication in this table is the point: a divergence between the two
    // would mean one branch stores something the screen never said.
    communicationsSignInEmail: {
      version: '2026-08-13.1',
      text: 'Accedendo iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino. Cosa ricevo, con che frequenza, come disdire e chi tratta i dati: frontaliereticino.ch/comunicazioni (versione 2026-08-13.1).',
    },
    signInAutoSubscribe: {
      version: '2026-08-12.2',
      text: 'Accedendo con Google, Facebook o LinkedIn a Frontaliere Ticino, l’indirizzo email dell’account viene iscritto alle comunicazioni di Frontaliere Ticino: aggiornamenti redazionali (fisco, previdenza, novità normative e approfondimenti per chi lavora oltre confine) e messaggi di servizio sul mio account. L’accesso al sito è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. L’elenco completo, con la frequenza di ciascuna comunicazione, è su frontaliereticino.ch/comunicazioni. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    },
    chatbotSignIn: {
      version: '2026-08-12.2',
      text: 'Accedendo dall’assistente di Frontaliere Ticino per continuare la conversazione, l’indirizzo email viene iscritto alle comunicazioni di Frontaliere Ticino: aggiornamenti redazionali (fisco, previdenza, novità normative e approfondimenti per chi lavora oltre confine) e messaggi di servizio sul mio account. Proseguire con l’assistente è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. L’elenco completo, con la frequenza di ciascuna comunicazione, è su frontaliereticino.ch/comunicazioni. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    },
    jobUnlockSocial: {
      version: '2026-08-12.1',
      text: 'Accedendo con Google o Facebook per sbloccare un annuncio di lavoro, l’indirizzo email dell’account viene iscritto alla newsletter per frontalieri e agli avvisi di lavoro. Sbloccare l’annuncio è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    },
    jobUnlockEmail: {
      version: '2026-08-12.1',
      text: 'Inserendo il mio indirizzo email per sbloccare gli annunci di lavoro, chiedo di ricevere la newsletter per frontalieri e gli avvisi di lavoro. L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    },
    analysisGate: {
      version: '2026-08-12.1',
      text: 'Inserendo il mio indirizzo email per sbloccare l’analisi completa dello stipendio, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    },
    taxCalendarSocial: {
      version: '2026-08-12.1',
      text: 'Accedendo con Google o Facebook per attivare i promemoria delle scadenze fiscali, l’indirizzo email dell’account viene iscritto alla newsletter per frontalieri e ai promemoria del calendario fiscale. Attivare i promemoria è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    },
    taxCalendarEmail: {
      version: '2026-08-12.1',
      text: 'Inserendo il mio indirizzo email per ricevere i promemoria delle scadenze fiscali, chiedo di ricevere anche la newsletter per frontalieri. L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    },
    leadMagnet: {
      version: '2026-08-12.1',
      text: 'Inserendo il mio indirizzo email per scaricare la guida gratuita, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    },
    newsletterForm: {
      version: '2026-08-12.1',
      text: 'Inserendo il mio indirizzo email nel modulo della newsletter, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    },
    weeklyDigest: {
      version: '2026-08-12.1',
      text: 'Inserendo il mio indirizzo email per ricevere il riepilogo settimanale, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    },
    resubscribeLink: {
      version: '2026-08-12.1',
      text: 'Riattivo l’iscrizione alla newsletter per frontalieri aprendo il link «riattiva» contenuto in una email ricevuta da Frontaliere Ticino. Il gesto registrato è l’apertura di quel link, non la compilazione di un modulo. Posso disiscrivermi di nuovo in qualsiasi momento.',
    },
    saveJobSignIn: {
      version: '1',
      text: 'Accedendo per salvare un annuncio, accetto di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    },
    companyFollow: {
      version: '1',
      text: 'Seguendo un\'azienda, accetto di ricevere una email quando pubblica nuovi annunci e la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    },
    publisherGateSocial: {
      version: '1',
      text: 'Accedendo per pubblicare un\'offerta, accetto di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    },
    publisherGateEmail: {
      version: '1',
      text: 'Accedendo per pubblicare un\'offerta, accetto di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    },
  };


  /**
   * The three non-Italian strings of every entry that claims `displayed:
   * true`, pinned as literally as the Italian ones above.
   *
   * Not decoration. Before #5712 the popup RENDERED `newsletter.consentLabel`
   * (translated four ways) and STORED an Italian literal, so a German
   * visitor's document recorded a sentence they had never seen. `displayed:
   * true` is only true if the string the person actually read is the string
   * that was kept — which means the translations are part of the proof, and
   * editing one without bumping `version` has to fail here.
   */
  const SIGN_IN_LOCALES = {
    en: 'By signing in I subscribe my address to the Frontaliere Ticino communications. What I receive, how often, how to stop it and who processes the data: frontaliereticino.ch/comunicazioni (version 2026-08-13.1).',
    de: 'Mit der Anmeldung trage ich meine Adresse in die Mitteilungen von Frontaliere Ticino ein. Was ich erhalte, wie oft, wie ich abbestelle und wer die Daten bearbeitet: frontaliereticino.ch/comunicazioni (Version 2026-08-13.1).',
    fr: 'En me connectant, j’inscris mon adresse aux communications de Frontaliere Ticino. Ce que je reçois, à quelle fréquence, comment me désinscrire et qui traite les données : frontaliereticino.ch/comunicazioni (version 2026-08-13.1).',
  } as const;

  const PINNED_LOCALES: Record<string, Record<'en' | 'de' | 'fr', string>> = {
    communicationsOptIn: {
      en: 'I subscribe my address to the Frontaliere Ticino communications. What I receive, how often, how to stop it and who processes the data: frontaliereticino.ch/comunicazioni (version 2026-08-13.1).',
      de: 'Ich trage meine Adresse in die Mitteilungen von Frontaliere Ticino ein. Was ich erhalte, wie oft, wie ich abbestelle und wer die Daten bearbeitet: frontaliereticino.ch/comunicazioni (Version 2026-08-13.1).',
      fr: 'J’inscris mon adresse aux communications de Frontaliere Ticino. Ce que je reçois, à quelle fréquence, comment me désinscrire et qui traite les données : frontaliereticino.ch/comunicazioni (version 2026-08-13.1).',
    },
    communicationsSignIn: { ...SIGN_IN_LOCALES },
    communicationsSignInEmail: { ...SIGN_IN_LOCALES },
  };

  it('pins every formula and its version literally', () => {
    for (const [key, expected] of Object.entries(PINNED)) {
      const actual = (CONSENT_TEXTS as any)[key];
      expect(actual, `CONSENT_TEXTS.${key} disappeared`).toBeTruthy();
      expect(actual.text, `CONSENT_TEXTS.${key}.text changed — bump .version`).toBe(expected.text);
      expect(actual.version, `CONSENT_TEXTS.${key}.version`).toBe(expected.version);
    }
  });

  it('covers the whole register, so a new entry cannot arrive unpinned', () => {
    expect(Object.keys(CONSENT_TEXTS).sort()).toEqual(Object.keys(PINNED).sort());
  });

  it('pins the other three locales of every displayed formula', () => {
    for (const [key, expected] of Object.entries(PINNED_LOCALES)) {
      const texts = (CONSENT_TEXTS as any)[key].texts;
      expect(texts, `${key}.texts missing`).toBeTruthy();
      for (const loc of ['en', 'de', 'fr'] as const) {
        expect(texts[loc], `CONSENT_TEXTS.${key}.texts.${loc} changed — bump .version`)
          .toBe(expected[loc]);
      }
      // `texts.it` is the same string as `text`, so the Italian pin above
      // covers it and a divergence between the two is itself a failure.
      expect(texts.it).toBe((CONSENT_TEXTS as any)[key].text);
    }
    // Every entry that claims to have been shown has all four locales pinned:
    // a fifth displayed entry cannot arrive with three of them unpinned.
    const displayed = Object.entries(CONSENT_TEXTS)
      .filter(([, p]) => p.displayed)
      .map(([k]) => k)
      .sort();
    expect(displayed).toEqual(Object.keys(PINNED_LOCALES).sort());
  });

  it('keeps the three pre-existing formulas byte-identical to what they replaced', () => {
    // They were moved into the register, not rewritten. Re-wording them would
    // change what FUTURE subscribers are recorded as having been told, for a
    // reason that has nothing to do with this fix.
    expect(CONSENT_TEXTS.saveJobSignIn.text).toContain('Accedendo per salvare un annuncio');
    expect(CONSENT_TEXTS.companyFollow.text).toContain('Seguendo un\'azienda');
    expect(CONSENT_TEXTS.publisherGateSocial.text).toBe(CONSENT_TEXTS.publisherGateEmail.text);
    // Same notice, different act — which is why they are two entries.
    expect(CONSENT_TEXTS.publisherGateSocial.act).toBe('authentication');
    expect(CONSENT_TEXTS.publisherGateEmail.act).toBe('typed_email_submit');
  });

  it('gives the two halves of an access gate one sentence and two acts (#5765)', () => {
    // The same shape as the publisher pair above, and the reason a gate showing
    // ONE notice can still record what each branch really did. Divergence here
    // would mean one of the two branches keeps a sentence nobody was shown.
    expect(CONSENT_TEXTS.communicationsSignInEmail.text).toBe(CONSENT_TEXTS.communicationsSignIn.text);
    expect(CONSENT_TEXTS.communicationsSignInEmail.texts).toEqual(CONSENT_TEXTS.communicationsSignIn.texts);
    expect(CONSENT_TEXTS.communicationsSignIn.act).toBe('authentication');
    expect(CONSENT_TEXTS.communicationsSignInEmail.act).toBe('typed_email_submit');
    // …and the opt-in wording stays a DIFFERENT sentence, because the forms it
    // labels have no sign-in to describe.
    expect(CONSENT_TEXTS.communicationsOptIn.text).not.toBe(CONSENT_TEXTS.communicationsSignIn.text);
    expect(CONSENT_TEXTS.communicationsOptIn.text.toLowerCase()).not.toContain('accedendo');
  });

  it('states which formulas are rendered and which are not, entry by entry', () => {
    // This assertion USED to read "no formula is rendered on screen today",
    // and it was true: not one of these strings was referenced from any JSX.
    // #5712 rendered two of them. The list is enumerated rather than
    // computed, so flipping a fourth entry to `true` fails here and has to be
    // justified next to the call site that renders it — which is what
    // tests/consent-shown-at-signup.test.tsx then checks.
    //
    // `communicationsSignInEmail` is on the list although no JSX names that
    // KEY: since #5765 an access gate shows one notice for its two branches,
    // and that notice renders this entry's exact sentence. `displayed` claims
    // "this string was on screen", not "this key appeared in an attribute" —
    // and consent-shown-at-signup checks it that way, per locale.
    const RENDERED = new Set([
      'communicationsOptIn',
      'communicationsSignIn',
      'communicationsSignInEmail',
    ]);
    for (const [key, proof] of Object.entries(CONSENT_TEXTS)) {
      expect(proof.displayed, `${key}.displayed`).toBe(RENDERED.has(key));
    }
  });

  it('never claims a formula was displayed without having it in all four locales', () => {
    // A notice in a language the reader does not speak is not a notice.
    for (const [key, proof] of Object.entries(CONSENT_TEXTS)) {
      if (!proof.displayed) continue;
      expect(proof.texts, `${key} is displayed but has no locale table`).toBeTruthy();
      for (const loc of ['it', 'en', 'de', 'fr'] as const) {
        expect(proof.texts?.[loc]?.length, `${key}.texts.${loc}`).toBeGreaterThan(80);
      }
    }
  });

  it('names the act for every entry, and never calls an authentication a subscription', () => {
    for (const [key, proof] of Object.entries(CONSENT_TEXTS)) {
      expect(['authentication', 'typed_email_submit', 'email_link_click'])
        .toContain(proof.act);
      if (proof.act === 'authentication') {
        // The formula must say what really happened. Reusing the popup's
        // "accetto di ricevere la newsletter" here would describe a decision
        // the person never made.
        expect(proof.text.toLowerCase(), `${key} must describe the sign-in`)
          .toMatch(/accedendo|sbloccare|pubblicare|attivare/);
      }
    }
  });

  it('records the link-click act for the win-back path instead of promoting it to consent', () => {
    // Corporate anti-phishing scanners fetch every link we send (measured on
    // this domain: 35 clicks, 25 within 7 seconds, Microsoft ranges). A click
    // is a fetch; calling it an opt-in is the fabrication the whole batch is
    // about.
    expect(CONSENT_TEXTS.resubscribeLink.act).toBe('email_link_click');
    expect(CONSENT_TEXTS.resubscribeLink.text).toMatch(/apertura di quel link/);
  });

  it('does not hand callers a consentGiven to set', () => {
    const proof = consentProof('signInAutoSubscribe', 'google_oauth') as Record<string, unknown>;
    expect(proof).not.toHaveProperty('consentGiven');
    expect(proof.consentTextVersion).toBe(CONSENT_TEXTS.signInAutoSubscribe.version);
  });

  it('maps OAuth provider ids to a method without guessing', () => {
    expect(oauthConsentMethod('google.com')).toBe('google_oauth');
    expect(oauthConsentMethod('facebook.com')).toBe('facebook_oauth');
    expect(oauthConsentMethod('linkedin.com')).toBe('linkedin_oauth');
  });
});

describe('every signup path names its formula — the census that keeps it that way', () => {
  /**
   * Source-level, and on purpose. The five auto-subscribe-on-sign-in paths were
   * found by #5690 and are pinned there; this is the wider set — every call
   * site that can CREATE a `newsletter_subscribers` document. A sixth path
   * added without a consent proof would throw at runtime thanks to the guard
   * above, but it would throw in production, on a real signup. This catches it
   * in CI instead.
   */
  const PATHS = [
    'App.tsx',
    'services/authService.ts',
    'components/community/JobBoard.tsx',
    'components/community/JobOrphanView.tsx',
    'components/community/JobBridgeView.tsx',
    'components/community/JobExpiredView.tsx',
    'components/community/WeeklyDigest.tsx',
    'components/community/Newsletter.tsx',
    'components/community/SaveSignInPromptModal.tsx',
    'components/community/CompanyFollowButton.tsx',
    'components/shared/LeadMagnetCTA.tsx',
    'components/calculator/MobileCalcLayout.tsx',
    'components/fisco/TaxCalendar.tsx',
    'components/pages/PublisherPublishPage.tsx',
  ];

  it.each(PATHS)('%s passes a consent proof to its upsert', (rel) => {
    const src = read(rel);
    expect(src, `${rel} must import the register`).toMatch(/from '@\/services\/consentTexts'/);
    expect(src, `${rel} must pass a proof`).toMatch(/\.\.\.consentProof\(/);
  });

  it('leaves no upsert call site in these files without a proof beside it', () => {
    for (const rel of PATHS) {
      const src = read(rel);
      const upserts = (src.match(/upsertNewsletterSubscriber(Record)?\(\s*\n?\s*(firestore|db|\{)/g) || []).length;
      const proofs = (src.match(/\.\.\.consentProof\(/g) || []).length;
      expect(proofs, `${rel}: ${upserts} upsert call(s) but ${proofs} proof(s)`)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it('leaves no consent formula inlined in a component, in any of the five files that had one', () => {
    // The five literals #5712 removed. Two of them (NewsletterPopup,
    // SubscriptionCTA) were the "newsletter settimanale" sentence that named
    // a cadence we stopped keeping — the wording that made the move to a
    // daily brief contestable (#5679) — and all five stored a string
    // unrelated to whatever the component rendered. A sixth inline formula
    // fails here rather than reaching a subscriber's document.
    const HAD_A_LITERAL = [
      'components/community/NewsletterPopup.tsx',
      'components/shared/SubscriptionCTA.tsx',
      'components/shared/PdfDownloadGate.tsx',
      'components/community/OfferwallNewsletterGate.tsx',
    ];
    for (const rel of HAD_A_LITERAL) {
      const src = read(rel);
      expect(src, `${rel} still declares a local consent constant`)
        .not.toMatch(/const CONSENT_TEXT(_BY_LOCALE)? *[:=]/);
      expect(src, `${rel} must take its formula from the register`)
        .toMatch(/from '@\/services\/consentTexts'/);
    }
  });

  it('keeps the retired cadence claim out of every signup path', () => {
    // "settimanale" is a promise about frequency, and the weekly newsletter
    // workflow now triggers daily (`33 3 * * *`, deduped per week-campaign)
    // while a separate daily brief ships twice a day. No formula may state a
    // cadence: `/comunicazioni/` states them, generated from the crons.
    for (const rel of [
      'App.tsx',
      'services/authService.ts',
      'services/consentTexts.ts',
      'components/community/JobBoard.tsx',
      'components/community/NewsletterPopup.tsx',
      'components/shared/SubscriptionCTA.tsx',
    ]) {
      expect(read(rel), `${rel} must not inline the retired popup formula`)
        .not.toContain('Accetto di ricevere la newsletter settimanale');
    }
  });

  it('keeps consentGiven off every sign-in call site', () => {
    for (const rel of ['App.tsx', 'services/authService.ts', 'components/community/JobBoard.tsx']) {
      expect(read(rel), `${rel} must not assert an opt-in it did not collect`)
        .not.toMatch(/consentGiven:\s*true/);
    }
  });
});
