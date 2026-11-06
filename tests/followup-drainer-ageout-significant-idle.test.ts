/**
 * followup-drainer — l'AGE-OUT CLOSE misura l'inattività SIGNIFICATIVA, non
 * `updatedAt`. È la metà mai riparata del difetto del 2026-08-11.
 *
 * Quella data la starvation del PARKED-RETRY fu chiusa facendo misurare al
 * cooldown l'ultimo evento significativo invece di `updatedAt`
 * (`followup-drainer-bot-idle.test.ts`). Ma `isAgeOutEligible` continuava a
 * leggere `updatedAt` — e l'header di quel test lo dice a chiare lettere:
 * «lo stesso `updatedAt` che le affamava le proteggeva anche dall'age-out close
 * (stesso campo) → limbo permanente». Riparata una uscita sola, lo stato è
 * rimasto stabile: le issue non venivano ri-accodate MA nemmeno chiuse.
 *
 * Misurato il 2026-08-23 sui due repo con i default (10gg età, 7gg quiete):
 *   sito   112 aperte — 26 oltre i 10 giorni, 7 quiete su `updatedAt`,
 *          intersezione VUOTA → 0 eleggibili all'age-out;
 *   corpus  56 aperte — stesso esito, 0 eleggibili.
 * Zero su entrambi, cioè l'uscita chiusa al 100%, mentre la coda saliva di +38
 * (sito) e +28 (corpus) issue in 7 giorni. Rimisurando sull'evento
 * significativo: 6 eleggibili sul sito, fra cui #5657 con
 * `idle(updatedAt)=0,08g` contro `idle(reale)=10,97g`.
 *
 * Questi test fissano il contratto:
 *  - un ping di bot al giorno non protegge più dall'age-out (il caso reale);
 *  - la direzione della fix è sicura per costruzione: il nuovo insieme di
 *    eleggibili è un SOVRAINSIEME del vecchio, mai un insieme diverso;
 *  - un evento significativo recente protegge ancora (la quiete dev'essere vera);
 *  - senza una misura significativa si ripiega su `updatedAt`, e con date
 *    illeggibili non si chiude MAI al buio;
 *  - `isAgeOutCandidate` resta indipendente dall'inattività, così il chiamante
 *    può escludere gratis chi non merita una lettura commenti.
 */
import { describe, it, expect } from 'vitest';
import {
  isAgeOutEligible,
  isAgeOutCandidate,
  lastSignificantActivityAt,
} from '../scripts/ci/followup-drainer.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-23T18:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

const AGEOUT_DAYS = 10;
const INACTIVE_DAYS = 7;

type Issue = { title?: string; labels?: Array<{ name: string }>; createdAt?: string; updatedAt?: string };

/** Un follow-up normale, queue-managed, vecchio abbastanza per l'age-out. */
const parked = (over: Partial<Issue> = {}): Issue => ({
  title: 'follow-up(#1234): un item deferred',
  labels: [{ name: 'follow-up' }, { name: 'fu-parked' }],
  createdAt: daysAgo(14),
  updatedAt: daysAgo(14),
  ...over,
});

const eligible = (iss: Issue, significantAt: number | null = null) =>
  isAgeOutEligible(iss, {
    now: NOW, ageOutDays: AGEOUT_DAYS, inactiveDays: INACTIVE_DAYS, significantAt,
  });

describe('age-out — il caso reale che teneva la coda in limbo', () => {
  it('un ping di bot al giorno non protegge più dalla chiusura', () => {
    // La forma esatta osservata: un monitor ri-commenta «🔁 Recurrence on
    // workflow run» ogni poche ore sulla issue che ha aperto lui. `updatedAt`
    // resta a ridosso di adesso per sempre, e l'issue non raggiunge MAI i 7
    // giorni di quiete richiesti — pur non avendo avuto un solo evento reale.
    const iss = parked({ updatedAt: daysAgo(0.05) });
    const comments = Array.from({ length: 13 }, (_, i) => ({
      body: '🔁 Recurrence on workflow run',
      createdAt: daysAgo(13 - i),
      user: { login: 'github-actions[bot]', type: 'Bot' },
    }));

    // Prima della fix: `updatedAt` a 0,05 giorni → protetta, per sempre.
    expect(eligible(iss)).toBe(false);

    // Dopo: l'ultimo evento significativo è la CREAZIONE, 14 giorni fa.
    const at = lastSignificantActivityAt(iss, comments);
    expect(at).toBe(Date.parse(iss.createdAt!));
    expect(eligible(iss, at)).toBe(true);
  });

  it('il nuovo insieme di eleggibili è un SOVRAINSIEME del vecchio', () => {
    // Invariante di direzione: un evento significativo è un sottoinsieme degli
    // eventi che alzano `updatedAt`, quindi `significantAt <= updatedAt` e
    // l'inattività misurata così è sempre >= di quella su `updatedAt`. Chi era
    // già eleggibile deve restarlo — altrimenti la fix non starebbe aprendo
    // un'uscita, la starebbe spostando.
    const iss = parked({ updatedAt: daysAgo(9) });
    expect(eligible(iss)).toBe(true);
    expect(eligible(iss, Date.parse(daysAgo(12)))).toBe(true);
  });

  it('un evento significativo recente protegge ancora (la quiete dev\'essere vera)', () => {
    // Il rovescio della medaglia: se qualcuno ha davvero detto qualcosa tre
    // giorni fa, la issue è viva e non si chiude. Senza questo caso la fix
    // sarebbe «chiudi tutto ciò che è vecchio», che è un difetto peggiore.
    const iss = parked({ updatedAt: daysAgo(0.1) });
    const comments = [
      { body: 'ci sto lavorando', createdAt: daysAgo(3), user: { login: 'valerielinc-ops', type: 'User' } },
      { body: '🔁 Recurrence', createdAt: daysAgo(0.1), user: { login: 'github-actions[bot]', type: 'Bot' } },
    ];
    expect(eligible(iss, lastSignificantActivityAt(iss, comments))).toBe(false);
  });

  it('un verdetto FIX_OUTCOME di un bot conta come evento significativo', () => {
    // È il proxy del momento del park (una mutazione di label non ha timestamp
    // nel JSON), e impedisce che «ignora i bot» degeneri in «chiudi un park di
    // ieri». Stesso termine già usato dal cooldown del parked-retry.
    const iss = parked({ updatedAt: daysAgo(0.1) });
    const comments = [
      { body: 'park\n<!-- FIX_OUTCOME: rate-limited -->', createdAt: daysAgo(2), user: { login: 'github-actions[bot]', type: 'Bot' } },
    ];
    expect(eligible(iss, lastSignificantActivityAt(iss, comments))).toBe(false);
  });
});

describe('age-out — fail-safe: non chiudere mai al buio', () => {
  it('senza misura significativa si ripiega su `updatedAt` (comportamento invariato)', () => {
    // Il caso in cui `gh` non risponde: la lettura commenti torna null, il
    // chiamante non passa `significantAt`, e il predicato deve comportarsi
    // esattamente come prima della fix invece di inventarsi una chiusura.
    expect(eligible(parked({ updatedAt: daysAgo(9) }))).toBe(true);
    expect(eligible(parked({ updatedAt: daysAgo(2) }))).toBe(false);
  });

  it('date illeggibili → nessuna chiusura, in entrambi i campi', () => {
    expect(eligible(parked({ createdAt: 'non-una-data' }))).toBe(false);
    expect(eligible(parked({ updatedAt: 'non-una-data' }))).toBe(false);
    // ...e un `significantAt` non finito non deve "vincere" sul ripiego.
    expect(eligible(parked({ updatedAt: 'non-una-data' }), Number.NaN)).toBe(false);
  });

  it('una issue in lavorazione o in coda non si chiude, per quanto quieta', () => {
    for (const l of ['agent:fix', 'agent:fix-queued']) {
      const iss = parked({ labels: [{ name: 'follow-up' }, { name: l }] });
      expect(eligible(iss, Date.parse(daysAgo(30)))).toBe(false);
    }
  });

  it('un tracker permanente non si chiude mai', () => {
    const iss = parked({ labels: [{ name: 'follow-up' }, { name: 'agent:no-age-out' }] });
    expect(eligible(iss, Date.parse(daysAgo(30)))).toBe(false);
  });
});

describe('isAgeOutCandidate — separa il gratis dal caro', () => {
  it('non dipende dall\'inattività: decide solo chi merita una lettura commenti', () => {
    // È questa indipendenza a rendere bounded il passo: `updatedAt` a ridosso
    // di adesso non deve escludere la candidata PRIMA di averne misurato
    // l'attività vera — sarebbe di nuovo il difetto, spostato di una riga.
    const vivace = parked({ updatedAt: daysAgo(0.01) });
    expect(isAgeOutCandidate(vivace, { now: NOW, ageOutDays: AGEOUT_DAYS })).toBe(true);
  });

  it('esclude gratis chi è troppo giovane, in lavorazione, o tracker', () => {
    expect(isAgeOutCandidate(parked({ createdAt: daysAgo(3) }), { now: NOW, ageOutDays: AGEOUT_DAYS })).toBe(false);
    expect(isAgeOutCandidate(
      parked({ labels: [{ name: 'follow-up' }, { name: 'agent:fix' }] }), { now: NOW, ageOutDays: AGEOUT_DAYS },
    )).toBe(false);
    expect(isAgeOutCandidate(
      parked({ labels: [{ name: 'follow-up' }, { name: 'agent:no-age-out' }] }), { now: NOW, ageOutDays: AGEOUT_DAYS },
    )).toBe(false);
  });

  it('`ageOutDays` a 0 disattiva tutto (interruttore del chiamante)', () => {
    expect(isAgeOutCandidate(parked(), { now: NOW, ageOutDays: 0 })).toBe(false);
  });
});
