/**
 * job-content-plausibility — regression test del rilevatore deterministico che
 * distingue un annuncio di lavoro da un frammento di sito sorgente finito nel
 * dataset (`scripts/lib/job-content-plausibility.mjs`).
 *
 * I casi POSITIVI sono i due incidenti reali del 2026-08-24, trovati a mano dal
 * proprietario navigando il sito, piu' il terzo che il rilevatore ha scoperto
 * da solo alla prima esecuzione sul corpus:
 *   - `hotel-international`: 5/5 record erano offerte promozionali di camere.
 *   - `schindler`: 11 record col widget di consenso cookie come titolo, piu' 2
 *     con un placeholder di template mai risolto.
 *   - `gemeinde-st-moritz`: 5/5 record col titolo della sidebar del sito
 *     ("Wichtige Kontakte") e il menu di navigazione come descrizione.
 *
 * I casi NEGATIVI contano quanto quelli positivi, e sono scelti apposta per
 * essere ADIACENTI ai positivi: un lessico che boccia "Spa Therapist 80%"
 * perche' contiene "spa", o "Reservation Agent" perche' contiene "reservation",
 * o "Newsletter Manager" perche' contiene "newsletter", trasformerebbe l'audit
 * in una fabbrica di issue-spam. Ogni negativo qui e' un titolo di lavoro vero
 * che condivide vocabolario con una delle regole decisive.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyJobTitle,
  normalize,
  scanSlice,
  titleDescriptionOverlap,
} from '../scripts/lib/job-content-plausibility.mjs';

describe('classifyJobTitle — casi che DEVONO essere bocciati', () => {
  const nonJobs: Array<{ title: string; code: string; from: string }> = [
    // hotel-international, tutti e 5 i record reali
    { title: 'Prenota SENZA carta di credito!', code: 'booking-offer', from: 'hotel-international' },
    { title: 'Offerta speciale 3 notti', code: 'booking-offer', from: 'hotel-international' },
    { title: 'Perché prenotare direttamente', code: 'booking-offer', from: 'hotel-international' },
    { title: 'Top-3-Star-Hotels', code: 'booking-offer', from: 'hotel-international' },
    { title: 'Alla scoperta delle camere rinnovate a superprezzi', code: 'booking-offer', from: 'hotel-international' },
    // schindler, le tre varianti di locale realmente presenti nel dataset
    { title: 'Manager für Cookie-Einwilligungen', code: 'consent-widget', from: 'schindler (de)' },
    { title: 'Gestore consenso ai cookie', code: 'consent-widget', from: 'schindler (it)' },
    { title: 'Gestionnaire de consentements pour les cookies', code: 'consent-widget', from: 'schindler (fr)' },
    // schindler, placeholder di template mai sostituito
    { title: '[[Title]] à Le Mont-sur-Lausanne', code: 'unresolved-placeholder', from: 'schindler' },
    { title: '[[Title] a Le Mont-sur-Lausanne', code: 'unresolved-placeholder', from: 'schindler (it, bracket persa)' },
    // varianti sintetiche della stessa classe, negli altri locali
    { title: 'Cookie Consent Manager', code: 'consent-widget', from: 'variante en' },
    { title: 'Datenschutzeinstellungen', code: 'consent-widget', from: 'variante de' },
    { title: 'Jetzt buchen und sparen', code: 'booking-offer', from: 'variante de' },
    { title: 'Réservez maintenant votre séjour', code: 'booking-offer', from: 'variante fr' },
    { title: 'Special Offer 2 Nights', code: 'booking-offer', from: 'variante en' },
    { title: 'Leggi di più', code: 'site-chrome', from: 'link di navigazione' },
    { title: 'Aggiungi al carrello', code: 'site-chrome', from: 'e-commerce' },
    { title: 'Pagina non trovata', code: 'site-chrome', from: 'errore 404 scrapato' },
    { title: 'Passwort vergessen', code: 'site-chrome', from: 'form di login' },
    { title: '{{job_title}}', code: 'unresolved-placeholder', from: 'template handlebars' },
    { title: 'undefined', code: 'unresolved-placeholder', from: 'bug del parser' },
  ];

  for (const c of nonJobs) {
    it(`"${c.title}" → non e' un lavoro [${c.code}] (${c.from})`, () => {
      const out = classifyJobTitle(c.title);
      expect(out.isJob).toBe(false);
      expect(out.reasons.map((r) => r.code)).toContain(c.code);
    });
  }

  it("un segnale job-positivo NON annulla una regola decisiva (il caso schindler contiene 'Manager')", () => {
    const out = classifyJobTitle('Manager für Cookie-Einwilligungen');
    expect(out.jobPositive).toBe(true); // "manager" e' un nome di ruolo
    expect(out.isJob).toBe(false); // ma la regola decisiva vince comunque
  });
});

describe('classifyJobTitle — annunci VERI che non devono mai essere segnalati', () => {
  const realJobs: string[] = [
    // il controesempio chiesto esplicitamente: lavoro vero in un hotel
    'Spa Therapist 80%',
    // adiacenti alle regole decisive: condividono vocabolario, ma sono lavori
    'Reservation Agent (m/w/d)',
    'Addetto/a alle prenotazioni 60-80%',
    'Newsletter Marketing Manager',
    'Category Manager Cookies & Biscuits',
    'Data Privacy Officer 80-100%',
    'Legal Counsel Data Protection (m/w/d)',
    // Composto tedesco fuso che CONDIVIDE il primo membro con la regola
    // consent-widget: "Datenschutzbeauftragte" e' un lavoro, "Datenschutz-
    // einstellungen" no. La differenza sta solo nel secondo membro.
    'Datenschutzbeauftragte/r 80%',
    'Cookie & Snack Produktentwickler:in',
    'Night Auditor Hotel 100%',
    'Hotelfachfrau/-mann EFZ',
    'Chef de Réception (h/f) 100%',
    'Cameriere ai piani / Addetto alle camere',
    'Responsabile Food & Beverage',
    // campione ordinario dal corpus reale
    'Detailhandelsfachfrau:mann EFZ "Gestalten von Einkaufserlebnissen"',
    'Monteur d\'ascenseurs expérimenté pour la région Neuchâtel/Jura (h/f/d) 80-100%',
    'Elektriker*in als Aufzugsmonteur*in Region St. Gallen (m/w/d) 80-100%',
    'Client Advisor, Las Vegas City Center',
    'PRADA Runner, Sankt Moritz',
    'Addetto/a Laboratorio Abbigliamento',
    'Praktikant*in Netto-Null und Kooperationen (befristet für 12 Monate)',
    'Cybersecurity Engineer im öffentlichen Sektor 80–100 %',
    'Lehrstelle als Detailhandelsassistent/in EBA Lebensmittel',
    'Assistente di farmacia AFC',
  ];

  for (const title of realJobs) {
    it(`"${title}" → e' un lavoro, nessun finding`, () => {
      const out = classifyJobTitle(title);
      expect(out.reasons.map((r) => r.code)).toEqual([]);
      expect(out.isJob).toBe(true);
    });
  }
});

describe('scanSlice — livello crawler vs livello record', () => {
  const jobTitle = (t: string, description = 'Descrizione di un ruolo reale con mansioni e requisiti.') => ({
    id: `id-${t.slice(0, 8)}`,
    title: t,
    description,
    url: 'https://example.ch/job',
  });

  it("hotel-international: 5/5 bocciati → verdetto sul CRAWLER, non sui singoli record", () => {
    const out = scanSlice({
      crawlerKey: 'hotel-international',
      jobs: [
        jobTitle('Top-3-Star-Hotels'),
        jobTitle('Prenota SENZA carta di credito!'),
        jobTitle('Offerta speciale 3 notti'),
        jobTitle('Alla scoperta delle camere rinnovate a superprezzi'),
        jobTitle('Perché prenotare direttamente'),
      ],
    });
    expect(out.level).toBe('crawler');
    expect(out.flagged).toBe(5);
    expect(out.ratio).toBe(1);
  });

  it('schindler: pochi record su molti → verdetto sui RECORD, il crawler resta sano', () => {
    const jobs = [
      ...Array.from({ length: 20 }, (_, i) => jobTitle(`Aufzugsmonteur*in Region ${i} (m/w/d) 80-100%`)),
      jobTitle('Manager für Cookie-Einwilligungen'),
      jobTitle('Gestore consenso ai cookie'),
    ];
    const out = scanSlice({ crawlerKey: 'schindler', jobs });
    expect(out.level).toBe('job');
    expect(out.flagged).toBe(2);
    expect(out.findings.every((f) => f.codes.includes('consent-widget'))).toBe(true);
  });

  it("gemeinde-st-moritz: nessun record col lessico noto ma NEMMENO uno che somigli a un lavoro → 'no-job-signal'", () => {
    const out = scanSlice({
      crawlerKey: 'gemeinde-st-moritz',
      jobs: Array.from({ length: 5 }, () =>
        jobTitle('Wichtige Kontakte', '• News • Agenda • Gemeindewahlen 2026 • Amtliche Anzeigen')
      ),
    });
    expect(out.level).toBe('crawler');
    expect(out.findings[0].codes).toEqual(['no-job-signal']);
  });

  it("un crawler piccolo con titoli laconici ma VERI non scatta 'no-job-signal' (il caso prada, 3 record)", () => {
    const out = scanSlice({
      crawlerKey: 'prada',
      jobs: [
        jobTitle('Client Advisor, Las Vegas City Center'),
        jobTitle('PRADA Runner, Sankt Moritz'),
        jobTitle('Addetto/a Laboratorio Abbigliamento'),
      ],
    });
    expect(out.level).toBe(null);
    expect(out.findings).toEqual([]);
  });

  it('slice sano → nessun verdetto', () => {
    const out = scanSlice({
      crawlerKey: 'sano',
      jobs: Array.from({ length: 6 }, (_, i) => jobTitle(`Verkäufer:in Frischprodukte ${i} 80%`)),
    });
    expect(out.level).toBe(null);
    expect(out.flagged).toBe(0);
  });

  it('slice vuoto → nessun verdetto (dominio di crawler-health-monitor, non di questo audit)', () => {
    expect(scanSlice({ crawlerKey: 'vuoto', jobs: [] }).level).toBe(null);
  });
});

describe('helper', () => {
  it('normalize appiattisce accenti e punteggiatura', () => {
    expect(normalize('Perché prenotare direttamente!')).toBe('perche prenotare direttamente');
    expect(normalize('Manager für Cookie-Einwilligungen')).toBe('manager fur cookie einwilligungen');
  });

  it("titleDescriptionOverlap resta CORROBORAZIONE: e' 1 anche su un record sbagliato", () => {
    // Il caso hotel-international ha titolo e descrizione perfettamente
    // allineati — sono sbagliati entrambi. E' la misura che dimostra perche'
    // la divergenza non puo' essere il trigger.
    expect(
      titleDescriptionOverlap('Perché prenotare direttamente', 'Perché prenotare direttamente — Hotel International au Lac')
    ).toBe(1);
    // Il caso schindler invece diverge, e la corroborazione si vede.
    expect(
      titleDescriptionOverlap('Manager für Cookie-Einwilligungen', 'Mobilität seit 1874 — Schindler Berufsbildung')
    ).toBe(0);
  });

  it('titleDescriptionOverlap → null quando non calcolabile', () => {
    expect(titleDescriptionOverlap('', 'qualcosa')).toBe(null);
    expect(titleDescriptionOverlap('Un titolo', '')).toBe(null);
  });
});
