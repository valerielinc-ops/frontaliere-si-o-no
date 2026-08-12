import { describe, expect, it } from 'vitest';
import {
  toIso,
  labelForEvent,
  describeEvent,
  missingData,
  buildSubscriberExport,
} from '@/scripts/lib/subscriberExport.mjs';

const GENERATED_AT = '2026-08-12T12:00:00.000Z';

/** Un iscritto realistico: consenso da popup, doppio opt-in mai completato. */
const SUBSCRIBER = {
  email: 'tester@example.com',
  status: 'confirmed',
  active: true,
  subscribed_at: { _seconds: 1781102840, _nanoseconds: 0 },
  consent_given: true,
  consent_given_at: '2026-06-10T14:47:25.381Z',
  consent_text: 'Accetto di ricevere la newsletter settimanale.',
  consent_method: 'email_checkbox',
  consent_source_url: '/de/jobs-im-tessin/esempio/',
  consent_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149.0.0.0',
  source: 'popup',
  source_channel: 'popup',
  source_component: 'NewsletterPopup',
  source_utm: { source: 'google_jobs_apply', medium: 'organic', campaign: 'google_jobs_apply', term: null, content: null },
  signup_locale: 'it-IT',
  confirmation_sent_at: '2026-06-10T14:47:22.782Z',
  geo_source: 'none',
  send_count: 9,
  open_count: 7,
  click_count: 35,
};

const EVENTS = [
  { event_type: 'click', occurred_at: '2026-07-06T06:03:57.000Z', provider: 'maileroo', campaign_id: 'weekly_2026-06-29', metadata: { ip: '74.242.242.134', original_url: 'https://frontaliereticino.ch/de/statistiken' } },
  { event_type: 'subscribe_completed', occurred_at: '2026-06-10T14:47:19.816Z' },
  { event_type: 'confirmation_email_sent', occurred_at: '2026-06-10T14:47:22.811Z' },
];

describe('toIso', () => {
  it('normalizza i quattro formati di data che Firestore restituisce', () => {
    expect(toIso({ _seconds: 1781102840, _nanoseconds: 0 })).toBe('2026-06-10T14:47:20.000Z');
    expect(toIso({ toDate: () => new Date('2026-06-10T14:47:20.000Z') })).toBe('2026-06-10T14:47:20.000Z');
    expect(toIso('2026-06-10T14:47:20.000Z')).toBe('2026-06-10T14:47:20.000Z');
    expect(toIso(1781102840000)).toBe('2026-06-10T14:47:20.000Z');
  });

  it('restituisce null su valori assenti o non interpretabili', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso('')).toBeNull();
    expect(toIso('non una data')).toBeNull();
  });
});

describe('labelForEvent', () => {
  it('traduce i tipi noti', () => {
    expect(labelForEvent('unsubscribe')).toBe('Disiscrizione');
    expect(labelForEvent('confirm')).toBe('Iscrizione confermata dal destinatario');
  });

  it('mostra un tipo sconosciuto invece di nasconderlo', () => {
    // L'interessato ha diritto al dato anche quando non abbiamo un'etichetta.
    expect(labelForEvent('qualcosa_di_nuovo')).toContain('qualcosa_di_nuovo');
  });
});

describe('describeEvent', () => {
  it('include IP e link quando presenti nei metadati', () => {
    const row = describeEvent(EVENTS[0]);
    expect(row.when).toBe('2026-07-06T06:03:57.000Z');
    expect(row.text).toContain('74.242.242.134');
    expect(row.text).toContain('statistiken');
  });
});

describe('missingData', () => {
  it("dichiara l'IP di iscrizione mancante, che non registriamo per nessuno", () => {
    const gaps = missingData(SUBSCRIBER, EVENTS).join(' ');
    expect(gaps).toContain('IP');
  });

  it('non scambia unsubscribe_ip per un IP di iscrizione', () => {
    // Registriamo l'IP di chi si disiscrive, mai di chi si iscrive (#5676):
    // la sua presenza non deve far sparire la dichiarazione di lacuna.
    const gaps = missingData({ ...SUBSCRIBER, unsubscribe_ip: '1.2.3.4' }, EVENTS).join(' ');
    expect(gaps).toContain('IP');
  });

  it('dichiara il doppio opt-in mancante quando non c\'è né campo né evento', () => {
    expect(missingData(SUBSCRIBER, EVENTS).join(' ')).toContain('doppio opt-in');
  });

  it('non lo dichiara quando esiste un evento di conferma', () => {
    const withConfirm = [...EVENTS, { event_type: 'confirm', occurred_at: '2026-06-10T15:00:00.000Z' }];
    expect(missingData(SUBSCRIBER, withConfirm).join(' ')).not.toContain('doppio opt-in');
  });

  it('non lo dichiara quando esiste il campo confirmed_at', () => {
    expect(missingData({ ...SUBSCRIBER, confirmed_at: '2026-06-10T15:00:00.000Z' }, EVENTS).join(' ')).not.toContain('doppio opt-in');
  });
});

describe('buildSubscriberExport', () => {
  const md = buildSubscriberExport(
    { email: 'tester@example.com', subscriber: SUBSCRIBER, events: EVENTS, deliveries: [], jobAlert: null, alerts: [] },
    { generatedAt: GENERATED_AT },
  );

  it('intesta il documento con indirizzo, data e titolare', () => {
    expect(md).toContain('tester@example.com');
    expect(md).toContain(GENERATED_AT);
    expect(md).toContain('Valerie Linc');
  });

  it('riporta il testo del consenso alla lettera', () => {
    expect(md).toContain('Accetto di ricevere la newsletter settimanale.');
  });

  it('elenca la cronologia in ordine cronologico, non nell\'ordine di lettura', () => {
    const iscrizione = md.indexOf('2026-06-10T14:47:19.816Z');
    const click = md.indexOf('2026-07-06T06:03:57.000Z');
    expect(iscrizione).toBeGreaterThan(-1);
    expect(click).toBeGreaterThan(iscrizione);
  });

  it('conta gli eventi nel titolo di sezione', () => {
    expect(md).toContain(`Cronologia completa (${EVENTS.length} eventi)`);
  });

  it('dichiara esplicitamente cosa non abbiamo registrato', () => {
    expect(md).toContain('Cosa non abbiamo registrato');
    expect(md).toContain('doppio opt-in');
  });

  it('non inventa un valore per un campo assente', () => {
    const senzaUtm = buildSubscriberExport(
      { email: 'x@example.com', subscriber: { ...SUBSCRIBER, source_utm: null }, events: [], deliveries: [], jobAlert: null, alerts: [] },
      { generatedAt: GENERATED_AT },
    );
    expect(senzaUtm).toContain('**Parametri UTM:** (non registrato)');
  });

  it('dice chiaramente quando non conserviamo nulla su un indirizzo', () => {
    const vuoto = buildSubscriberExport(
      { email: 'sconosciuto@example.com', subscriber: null, events: [], deliveries: [], jobAlert: null, alerts: [] },
      { generatedAt: GENERATED_AT },
    );
    expect(vuoto).toContain('Non conserviamo alcun dato');
  });

  it('rifiuta di generare senza generatedAt, invece di leggere l\'orologio', () => {
    // La purezza è ciò che rende questo modulo testabile: se leggesse Date.now()
    // il documento cambierebbe a ogni esecuzione e questi test sarebbero instabili.
    expect(() => buildSubscriberExport(
      { email: 'x@example.com', subscriber: SUBSCRIBER, events: [], deliveries: [], jobAlert: null, alerts: [] },
      {},
    )).toThrow(/generatedAt/);
  });

  it('elenca le ricerche salvate degli avvisi di lavoro', () => {
    const conAlert = buildSubscriberExport(
      {
        email: 'x@example.com',
        subscriber: SUBSCRIBER,
        events: [],
        deliveries: [],
        jobAlert: { status: 'active' },
        alerts: [{ id: 'a1', keywords: ['informatico'], locations: ['Bellinzona'], frequency: 'daily', createdAt: '2026-06-11T08:00:00.000Z' }],
      },
      { generatedAt: GENERATED_AT },
    );
    expect(conAlert).toContain('informatico');
    expect(conAlert).toContain('Bellinzona');
  });
});
