import { describe, expect, it } from 'vitest';
import duties from '../data/pharmacy-duties-italy.json';
import status from '../data/pharmacy-duties-italy-status.json';
import sources from '../data/pharmacy-duties-italy-sources.json';
import catalogue from '../data/pharmacies-italy-border.json';
import { checkItalyDutyData } from '../scripts/check-pharmacy-duties-italy.mjs';
import {
  buildAtomicItalyDutySnapshots,
  buildItalyDutyRelease,
  isItalyDutyReleasePublishable,
  validateItalyDutyRelease,
  verifyItalyDutyRelease,
} from '../services/pharmacies/italyRelease';

const NOW = '2026-09-15T12:00:00.000Z';

describe('Italian duty release contract', () => {
  it('keeps one releaseId and Europe/Rome across the checked-in snapshots', () => {
    expect(duties._release.releaseId).toBe(status._release.releaseId);
    expect(duties._release.timezone).toBe('Europe/Rome');
    expect(duties._release.scope).toEqual({ country: 'IT', provinces: ['CO', 'VA', 'VB'] });
    expect(validateItalyDutyRelease(duties._release)).toEqual([]);
    expect(validateItalyDutyRelease(status._release)).toEqual([]);
    expect(verifyItalyDutyRelease({ duties, status })).toEqual([]);
    // Questi assert NON pinnano piu' lo stato corrente dello snapshot.
    // Pinnavano `not_published` e `dutyCount: 0, observedDutyCount: 4`, cioe' i
    // valori di una release rotta: appena il cron riesce a pubblicare, il
    // workflow committa dati nuovi e quegli assert sarebbero diventati rossi su
    // `main` proprio PERCHE' il difetto era stato riparato. Si verifica invece
    // la COERENZA INTERNA, che vale prima e dopo un refresh.
    expect(['fresh', 'stale', 'partial', 'not_published']).toContain(duties._release.state);
    expect(duties._release.state).toBe(buildItalyDutyRelease({ duties, status, evaluatedAt: duties._fetchedAt }).state);
    expect(isItalyDutyReleasePublishable({ duties, status })).toBe(duties._release.state === 'fresh');
    // Il conteggio per provincia deve corrispondere alle righe realmente
    // pubblicate per quella provincia, qualunque sia lo stato.
    const coRows = (duties.duties as Array<{ province: string }>).filter((duty) => duty.province === 'CO').length;
    expect(status._provinces.CO.dutyCount).toBe(coRows);
    expect(status._provinces.CO.province).toBe('CO');
  });

  it('derives a deterministic releaseId from both payloads', () => {
    const first = buildItalyDutyRelease({ duties, status, evaluatedAt: duties._fetchedAt });
    const second = buildItalyDutyRelease({
      duties: { ...duties, _warnings: ['payload changed'] },
      status,
      evaluatedAt: duties._fetchedAt,
    });
    expect(first.releaseId).toBe(duties._release.releaseId);
    expect(second.releaseId).not.toBe(first.releaseId);
  });

  it('blocks tampering, stale sources, and incomplete province coverage', () => {
    const tampered = { ...duties, duties: [{ ...duties.duties[0], province: undefined }] };
    expect(verifyItalyDutyRelease({ duties: tampered, status })).toEqual(expect.arrayContaining([
      'duties payload hash mismatch',
      'releaseId does not match the release contract',
    ]));

    const tamperedStatusRelease = {
      ...status,
      _release: {
        ...status._release,
        snapshots: {
          ...status._release.snapshots,
          status: { ...status._release.snapshots.status, sha256: '0'.repeat(64) },
        },
      },
    };
    expect(verifyItalyDutyRelease({ duties, status: tamperedStatusRelease })).toEqual(expect.arrayContaining([
      'status payload hash mismatch',
      'status release metadata does not match the payload contract',
    ]));

    const tamperedStatusState = {
      ...status,
      _release: { ...status._release, state: 'fresh' },
    };
    expect(verifyItalyDutyRelease({ duties, status: tamperedStatusState })).toContain('status release metadata does not match the payload contract');

    const completeStatus = {
      ...status,
      _allSourcesFailed: false,
      _errors: [],
      _provinces: Object.fromEntries(Object.entries(status._provinces).map(([province, entry]) => [
        province,
        { ...entry, state: 'fresh', freshness: 'fresh', coverage: 'covered' },
      ])),
    };
    // `publication: 'required'` e' esplicito: l'intento del caso e' "una
    // provincia BLOCCANTE stantia rende stantia la release". Prima si appoggiava
    // al default fail-closed di uno snapshot generato senza il campo, quindi si
    // sarebbe invertito da solo appena il cron avesse riscritto VB come
    // best-effort.
    const staleStatus = {
      ...completeStatus,
      _provinces: {
        ...completeStatus._provinces,
        VB: { ...completeStatus._provinces.VB, publication: 'required', freshness: 'stale', state: 'stale' },
      },
    };
    const stale = buildAtomicItalyDutySnapshots({ duties: { ...duties, _errors: [] }, status: staleStatus, evaluatedAt: NOW });
    expect(stale.release.state).toBe('stale');
    expect(isItalyDutyReleasePublishable(stale)).toBe(false);

    // Degradazione parziale: una provincia `best-effort` che non pubblica NON
    // deve azzerare le province bloccanti. E' il motivo per cui una sola fonte
    // irraggiungibile (VCO, bloccata in egress dai runner GitHub) teneva a zero
    // anche Como e Varese, che sono perfettamente pubblicabili.
    const bestEffortDown = {
      ...completeStatus,
      _bestEffortErrors: ['vco-asl-2026: fetch failed (UND_ERR_CONNECT_TIMEOUT)'],
      _provinces: {
        ...completeStatus._provinces,
        VB: {
          ...completeStatus._provinces.VB,
          publication: 'best-effort',
          state: 'not_published',
          freshness: 'unknown',
          coverage: 'not_published',
          dutyCount: 0,
        },
      },
    };
    const degradedButPublishable = buildAtomicItalyDutySnapshots({
      duties: { ...duties, _errors: [] },
      status: bestEffortDown,
      evaluatedAt: NOW,
    });
    // Si verifica lo stato deciso dal WRITER, che e' esattamente cio' che
    // determina l'exit code dell'importer e quindi il rosso/verde del workflow.
    // `isItalyDutyReleasePublishable` non e' asseribile su questo snapshot: e'
    // la valutazione lato SPA e dipende anche dall'eta' reale di `_fetchedAt`
    // (qui 3 giorni, oltre le 72h) e dalle righe committate, che per CO e VA
    // sono zero proprio perche' il difetto le teneva a zero.
    expect(degradedButPublishable.release.state).toBe('fresh');

    // Ma se la stessa provincia e' `required`, la release NON passa: la
    // degradazione e' consentita solo dove e' dichiarata.
    const requiredDown = {
      ...bestEffortDown,
      _provinces: {
        ...bestEffortDown._provinces,
        VB: { ...bestEffortDown._provinces.VB, publication: 'required' },
      },
    };
    expect(buildAtomicItalyDutySnapshots({
      duties: { ...duties, _errors: [] },
      status: requiredDown,
      evaluatedAt: NOW,
    }).release.state).toBe('not_published');

    const missingProvince = {
      ...status,
      _provinces: { CO: status._provinces.CO, VA: status._provinces.VA },
    };
    expect(buildItalyDutyRelease({ duties, status: missingProvince, evaluatedAt: NOW }).state).toBe('not_published');
  });

  it('checks official source identity, catalogue provenance, and release integrity together', () => {
    // Costruito a mano invece di appoggiarsi allo snapshot committato: quelle
    // stringhe comparivano solo perche' i dati su disco erano rotti, quindi il
    // test si sarebbe invertito al primo refresh riuscito. Una provincia
    // `required` degradata DEVE produrre entrambi gli errori.
    const degraded = {
      ...status,
      _provinces: {
        ...status._provinces,
        CO: {
          ...status._provinces.CO,
          publication: 'required',
          state: 'not_published',
          freshness: 'unknown',
          coverage: 'not_published',
        },
      },
      _release: { ...status._release, state: 'not_published' },
    };
    const degradedDuties = { ...duties, _release: { ...duties._release, state: 'not_published' } };
    expect(checkItalyDutyData({ duties: degradedDuties, status: degraded, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') })).toEqual(expect.arrayContaining([
      expect.stringContaining('source is not fresh and covered'),
      expect.stringContaining('release: state is not_published'),
    ]));

    const tampered = {
      ...duties,
      duties: [{ ...duties.duties[0], pharmacyId: 'it-msal-not-in-catalogue' }, ...duties.duties.slice(1)],
    };
    expect(checkItalyDutyData({ duties: tampered, status, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') })).toEqual(expect.arrayContaining([
      expect.stringContaining('pharmacyId is missing or ambiguous'),
      expect.stringContaining('payload hash mismatch'),
    ]));

    const statusStateTampered = {
      ...status,
      _release: { ...status._release, state: 'fresh' },
    };
    expect(checkItalyDutyData({ duties, status: statusStateTampered, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain('release metadata differs between duties and status');

    const aliasMismatchSources = {
      ...sources,
      sources: sources.sources.map((source: { province: string; identityAliases: Array<Record<string, string>> }) => source.province === 'CO'
        ? {
          ...source,
          identityAliases: [
            { ...source.identityAliases[0], pharmacyId: 'it-msal-3924' },
            ...source.identityAliases.slice(1),
          ],
        }
        : source),
    };
    expect(checkItalyDutyData({ duties, status, sources: aliasMismatchSources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain('source como-ats-2026-2027: alias it-msal-3924 province does not match CO');

    const httpRawSources = {
      ...sources,
      sources: sources.sources.map((source: { province: string }) => source.province === 'CO'
        ? { ...source, rawUrl: 'http://www.comune.merone.co.it/EG0/EGDOCVISJS.HBL' }
        : source),
    };
    expect(checkItalyDutyData({ duties, status, sources: httpRawSources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain('source como-ats-2026-2027: rawUrl must be official HTTPS');
    // Il numero atteso si DERIVA dalle righe committate: era scritto a mano
    // ("rows 0") e si sarebbe rotto al primo refresh che pubblica righe per CO.
    const committedCoRows = (duties.duties as Array<{ province: string }>).filter((duty) => duty.province === 'CO').length;
    const bogusCount = committedCoRows + 1;
    const statusCountMismatch = {
      ...status,
      _provinces: {
        ...status._provinces,
        CO: { ...status._provinces.CO, dutyCount: bogusCount },
      },
    };
    expect(checkItalyDutyData({ duties, status: statusCountMismatch, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain(`status.CO: dutyCount ${bogusCount} does not match duties rows ${committedCoRows}`);
  });

  it('pins VCO to the official ASL calendar and its declared 2026 validity window', () => {
    const vco = sources.sources.find((source: { province: string }) => source.province === 'VB');
    expect(vco).toMatchObject({
      officialSourceUrl: 'https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=',
      rawUrl: 'https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      // VCO e' una fonte corrections-only e NON dichiara un minimo in giorni:
      // pubblica solo i cambi turno con data esplicita su una rotazione che il
      // parser non espande, quindi un minimo in giorni-calendario sarebbe
      // insoddisfacibile per costruzione. E' `best-effort` perche' il PDF non e'
      // raggiungibile dai runner GitHub (blocco di egress, HTTP 200 da rete
      // residenziale): non deve azzerare la release di CO e VA.
      coverageModel: 'corrections-only',
      publication: 'best-effort',
    });
    expect(vco.minimumCalendarDays).toBeUndefined();
    const errors = checkItalyDutyData({ duties, status, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') });
    expect(errors.filter((error) => /^(source|thirdPartyLinkOut)/.test(error))).toEqual([]);
  });
});
