/**
 * `cadence_next_eligible_on`, solo SHADOW (perf-plan PR 8).
 *
 * Ogni invio (o decadimento) scrive sull'alert, nello STESSO update gia' esistente,
 * il primo giorno UTC in cui la cadenza potrebbe dirlo di nuovo in programma. La
 * query di caricamento non cambia: si misura soltanto se un filtro su quel campo
 * avrebbe saltato alert che oggi sono in programma (`cadenceIndexViolations`).
 *
 * La proprieta' che rende il limite «conservativo»: non e' mai piu' tardi del
 * giorno in cui `isJobAlertDueToday` risponde davvero «in programma».
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOB_ALERT_NEXT_ELIGIBLE_FIELD,
  JOB_ALERT_TERMINAL_NEXT_ELIGIBLE_ON,
  cadenceIndexReading,
  cadenceNextEligibleLowerBound,
  isJobAlertDueToday,
} from '../scripts/lib/jobAlertCadence.mjs';

const source = fs.readFileSync(path.resolve(__dirname, '../scripts/send-job-alerts.mjs'), 'utf8');
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('limite inferiore del prossimo giorno eleggibile', () => {
  const sentAtIso = '2026-11-14T05:30:00.000Z';

  it('un alert gestito dal motore: giorno dell invio + 1, mai il tier in corso (sta sul documento del destinatario)', () => {
    expect(cadenceNextEligibleLowerBound({ alert: {}, sentAtIso })).toBe('2026-11-15');
    // Anche a tier 7 (settimanale): il prossimo invio di un ALTRO alert dello stesso
    // destinatario puo promuoverlo a 1 giorno, quindi il limite resta +1.
    expect(cadenceNextEligibleLowerBound({ alert: { id: 'x' }, sentAtIso })).toBe('2026-11-15');
  });

  it('una frequenza fissata dalla persona vale alla lettera: daily +1, weekly +7', () => {
    expect(cadenceNextEligibleLowerBound({ alert: { frequencyOverride: true, frequency: 'daily' }, sentAtIso })).toBe('2026-11-15');
    expect(cadenceNextEligibleLowerBound({ alert: { frequencyOverride: true, frequency: 'weekly' }, sentAtIso })).toBe('2026-11-21');
  });

  it('un invio programmato per un giorno successivo e ancora in volo: il limite parte da quel giorno', () => {
    expect(cadenceNextEligibleLowerBound({ alert: {}, sentAtIso, scheduledFor: '2026-11-15T07:00:00.000Z' })).toBe('2026-11-16');
    // Programmato oggi o prima: non sposta il limite.
    expect(cadenceNextEligibleLowerBound({ alert: {}, sentAtIso, scheduledFor: '2026-11-14T08:00:00.000Z' })).toBe('2026-11-15');
    expect(cadenceNextEligibleLowerBound({ alert: {}, sentAtIso, scheduledFor: null })).toBe('2026-11-15');
  });

  it('un alert che decade con questo invio e terminale; un giorno illeggibile non produce un limite', () => {
    expect(cadenceNextEligibleLowerBound({ alert: {}, sentAtIso, decayStamp: { cadence_state: 'decayed' } })).toBe(JOB_ALERT_TERMINAL_NEXT_ELIGIBLE_ON);
    expect(cadenceNextEligibleLowerBound({ alert: {}, sentAtIso: 'ieri' })).toBeNull();
  });

  it('PROPRIETA: il limite non e mai piu tardi del primo giorno in cui la cadenza dice davvero «in programma»', () => {
    const sentDay = '2026-11-14';
    const tiers = [1, 3, 7];
    const pins = [null, 'daily', 'weekly'];
    let checked = 0;
    for (const tier of tiers) {
      for (const pin of pins) {
        const alert: any = pin ? { frequencyOverride: true, frequency: pin } : {};
        // Stato dopo l'invio: l'alert e il destinatario hanno il timbro del giorno.
        const sentAlert = { ...alert, lastMatchedAt: `${sentDay}T05:30:00.000Z` };
        const sub = { ja_cadence_tier: tier, ja_cadence_last_sent_at: `${sentDay}T05:30:00.000Z` };
        let firstDue: string | null = null;
        for (let offset = 0; offset <= 30 && !firstDue; offset += 1) {
          const day = addDays(sentDay, offset);
          const decision = isJobAlertDueToday({ alert: sentAlert, sub, todayIso: day, nowMs: Date.parse(`${day}T06:00:00Z`) });
          if (decision.due) firstDue = day;
        }
        expect(firstDue, `tier ${tier} pin ${pin}`).not.toBeNull();
        const bound = cadenceNextEligibleLowerBound({ alert, sentAtIso: `${sentDay}T05:30:00.000Z` }) as string;
        expect(bound <= (firstDue as string), `tier ${tier} pin ${pin}: limite ${bound} dopo il primo giorno dovuto ${firstDue}`).toBe(true);
        // E il limite e utile: per un pin settimanale coincide col giorno dovuto.
        if (pin === 'weekly') expect(bound).toBe(firstDue);
        checked += 1;
      }
    }
    expect(checked).toBe(9);
  });

  it('PROPRIETA con un invio programmato in avanti: ne il giorno dello slot ne quello dopo sono in anticipo sulla cadenza', () => {
    const sentDay = '2026-11-14';
    const scheduledFor = '2026-11-15T07:00:00.000Z';
    const alert: any = { lastMatchedAt: `${sentDay}T05:30:00.000Z`, cadence_scheduled_for: scheduledFor };
    const bound = cadenceNextEligibleLowerBound({ alert: {}, sentAtIso: `${sentDay}T05:30:00.000Z`, scheduledFor }) as string;
    for (let offset = 0; offset <= 10; offset += 1) {
      const day = addDays(sentDay, offset);
      const decision = isJobAlertDueToday({ alert, sub: { ja_cadence_tier: 1 }, todayIso: day, nowMs: Date.parse(`${day}T06:00:00Z`) });
      // Nessun giorno prima del limite puo essere in programma.
      if (day < bound) expect(decision.due, day).toBe(false);
    }
  });
});

describe('lettura del limite sul documento', () => {
  it('presente e valido, saltabile solo se e dopo oggi; un valore illeggibile conta come assente e non esclude mai', () => {
    expect(cadenceIndexReading({ [JOB_ALERT_NEXT_ELIGIBLE_FIELD]: '2026-11-20' }, '2026-11-14')).toEqual({ present: true, nextEligibleOn: '2026-11-20', skippable: true });
    expect(cadenceIndexReading({ [JOB_ALERT_NEXT_ELIGIBLE_FIELD]: '2026-11-14' }, '2026-11-14').skippable).toBe(false);
    expect(cadenceIndexReading({ [JOB_ALERT_NEXT_ELIGIBLE_FIELD]: '2026-11-10' }, '2026-11-14').skippable).toBe(false);
    expect(cadenceIndexReading({ [JOB_ALERT_NEXT_ELIGIBLE_FIELD]: JOB_ALERT_TERMINAL_NEXT_ELIGIBLE_ON }, '2026-11-14').skippable).toBe(true);
    for (const bad of [undefined, null, '', 'domani', '2026-13-45x', 20261120, { seconds: 1 }]) {
      expect(cadenceIndexReading({ [JOB_ALERT_NEXT_ELIGIBLE_FIELD]: bad }, '2026-11-14'), String(bad)).toEqual({ present: false, nextEligibleOn: null, skippable: false });
    }
  });
});

describe('il sender: solo shadow, nessuna scrittura extra, nessun cambio di query', () => {
  it('la query di caricamento e invariata: nessun filtro sul campo', () => {
    expect(source).toContain("db.collectionGroup('alerts').where('active', '==', true).get()");
    const queryRegion = source.slice(source.indexOf("db.collectionGroup('alerts')"), source.indexOf("db.collectionGroup('alerts')") + 400);
    expect(queryRegion).not.toContain(JOB_ALERT_NEXT_ELIGIBLE_FIELD);
    expect(source).not.toMatch(/where\(\s*JOB_ALERT_NEXT_ELIGIBLE_FIELD/);
    expect(source).not.toMatch(/where\('cadence_next_eligible_on'/);
  });

  it('il campo viaggia nell update fuso dell invio (stesso update, nessuna scrittura in piu) e nella riattivazione', () => {
    const accepted = source.slice(source.indexOf('buildAcceptedAlertFields: (sendResult) => {'));
    const block = accepted.slice(0, accepted.indexOf('      sentMap,'));
    expect(block).toContain('[JOB_ALERT_NEXT_ELIGIBLE_FIELD]: cadenceNextEligibleLowerBound({');
    expect(block).toContain('decayStamp: decay');
    expect(block).toContain('lastMatchedAt: FieldValue.serverTimestamp()');
    expect(source).toContain('verdict.alertFields[JOB_ALERT_NEXT_ELIGIBLE_FIELD] = TODAY_ISO');
    // Nessuna scrittura dedicata al campo: mai un update() il cui unico contenuto e il limite.
    expect(source).not.toMatch(/update\(\s*\{\s*\[?JOB_ALERT_NEXT_ELIGIBLE_FIELD/);
  });

  it('misura le violazioni: alert in programma oggi con limite dopo oggi', () => {
    expect(source).toContain("jobAlertMetrics.set('cadenceIndexViolations', 0)");
    expect(source).toMatch(/if \(indexReading\.skippable\) \{[\s\S]*?if \(decision\.due\) jobAlertMetrics\.count\('cadenceIndexViolations'\);/);
  });
});
