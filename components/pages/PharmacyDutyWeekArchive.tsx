import React, { useEffect, useState } from 'react';
import type { Locale } from '../../services/i18n';
import { cdnDataUrl } from '../../services/cdnDataBase';
import { DUTY_WEEK_REGIONS, formatDutyDateTime } from '../../services/pharmacies/dutyWeek';
import { dutyWeekArchiveTitle, resolveDutyWeekHistory, type DutyWeekHistory } from '../../services/pharmacies/dutyWeekHistory';
import { PHARMACY_DUTY_HUB_PATH } from '../../services/pharmacies/types';

const COPY = {
  it: {
    notice: 'Archivio storico, non turni attuali. Queste assegnazioni erano presenti nelle fonti alle date di raccolta indicate; non attestano il servizio effettivamente svolto né un’apertura attuale. L’archivio può essere incompleto e conservare revisioni diverse.',
    current: 'Consulta i turni attuali e le fonti ufficiali', source: 'Fonte originale', observed: 'Rilevato il',
    loading: 'Caricamento dell’archivio settimanale…',
    unavailable: 'Non è stato possibile caricare un archivio verificabile per questa settimana. Non usare questa pagina per cercare una farmacia di turno.',
    retry: 'Riprova a caricare l’archivio',
  },
  en: {
    notice: 'Historical archive, not current duties. These assignments appeared in the sources on the collection dates shown; they do not confirm service actually provided or current opening. The archive may be incomplete and retain different revisions.',
    current: 'Check current duties and official sources', source: 'Original source', observed: 'Observed on',
    loading: 'Loading the weekly archive…',
    unavailable: 'A verifiable archive could not be loaded for this week. Do not use this page to find a pharmacy currently on duty.',
    retry: 'Retry loading the archive',
  },
  de: {
    notice: 'Historisches Archiv, keine aktuellen Notdienste. Diese Einteilungen standen zu den angegebenen Abrufdaten in den Quellen; sie bestätigen weder tatsächlich geleistete Dienste noch eine aktuelle Öffnung. Das Archiv kann unvollständig sein und verschiedene Fassungen enthalten.',
    current: 'Aktuelle Notdienste und offizielle Quellen prüfen', source: 'Originalquelle', observed: 'Erfasst am',
    loading: 'Wochenarchiv wird geladen…',
    unavailable: 'Für diese Woche konnte kein überprüfbares Archiv geladen werden. Nutzen Sie diese Seite nicht, um eine aktuell diensthabende Apotheke zu finden.',
    retry: 'Archiv erneut laden',
  },
  fr: {
    notice: 'Archives historiques, pas les gardes actuelles. Ces affectations figuraient dans les sources aux dates de collecte indiquées ; elles ne confirment ni le service réellement assuré ni une ouverture actuelle. Les archives peuvent être incomplètes et conserver différentes versions.',
    current: 'Consulter les gardes actuelles et les sources officielles', source: 'Source originale', observed: 'Relevé le',
    loading: 'Chargement des archives hebdomadaires…',
    unavailable: 'Aucune archive vérifiable n’a pu être chargée pour cette semaine. N’utilisez pas cette page pour trouver une pharmacie actuellement de garde.',
    retry: 'Réessayer de charger les archives',
  },
} as const;

export function PharmacyDutyWeekArchiveView({ history, locale, title }: { history: DutyWeekHistory; locale: Locale; title?: string }) {
  const copy = COPY[locale];
  const entries = history.observations.flatMap((observation, edition) => observation.entries.map((entry, index) => ({ ...entry, fetchedAt: observation.fetchedAt, key: `${edition}-${index}` })));
  return <div className="mx-auto max-w-6xl space-y-8" data-pharmacy-duty-archive={history.weekStart}>
    <header className="space-y-4">
      <h1 className="font-display text-3xl font-bold tracking-tight text-heading sm:text-4xl">{title || dutyWeekArchiveTitle(history.weekStart, locale)}</h1>
      <p className="max-w-3xl rounded-xl border border-warning-border bg-warning-subtle p-4 text-base leading-7 text-body" role="note">{copy.notice}</p>
      <a className="inline-flex min-h-11 items-center text-base font-semibold text-link underline underline-offset-4" href={PHARMACY_DUTY_HUB_PATH[locale]}>{copy.current}</a>
    </header>
    <div className="grid gap-8 md:grid-cols-2">
      {DUTY_WEEK_REGIONS.map((region) => {
        const rows = entries.filter((entry) => entry.duty.coverageName === region.name).sort((a, b) => Date.parse(a.duty.startsAt) - Date.parse(b.duty.startsAt));
        if (!rows.length) return null;
        return <section className="min-w-0 space-y-3" key={region.key} aria-labelledby={`archive-${region.key}`}>
          <h2 id={`archive-${region.key}`} className="font-display text-xl font-bold text-heading">{region.name}</h2>
          <ul className="divide-y divide-edge border-y border-edge">{rows.map((entry) => <li className="space-y-2 py-4 text-base leading-7 text-body" key={entry.key} data-duty-id={entry.duty.id}>
            <p className="break-words font-semibold text-heading">{entry.pharmacy.name} · {entry.pharmacy.city}</p>
            <p className="tabular-nums"><time dateTime={entry.duty.startsAt}>{formatDutyDateTime(entry.duty.startsAt)}</time> – <time dateTime={entry.duty.endsAt}>{formatDutyDateTime(entry.duty.endsAt)}</time></p>
            <p className="text-sm leading-6 text-muted">{copy.observed}: <time dateTime={entry.fetchedAt}>{formatDutyDateTime(entry.fetchedAt)}</time> · <a className="text-link underline underline-offset-4" href={entry.duty.sourceUrl} rel="nofollow noopener">{copy.source}</a></p>
          </li>)}</ul>
        </section>;
      })}
    </div>
  </div>;
}

function readSeed(weekStart: string): DutyWeekHistory | null {
  if (typeof document === 'undefined') return null;
  const seed = document.getElementById('pharmacy-duty-week-history');
  if (seed?.getAttribute('type') !== 'application/json') return null;
  try { return resolveDutyWeekHistory(JSON.parse(seed.textContent || ''), weekStart); } catch { return null; }
}

export default function PharmacyDutyWeekArchive({ weekStart, locale }: { weekStart: string; locale: Locale }) {
  const [state, setState] = useState(() => ({ weekStart, history: readSeed(weekStart), failed: false }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const seeded = readSeed(weekStart);
    setState({ weekStart, history: seeded, failed: false });
    if (seeded) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let current = true;
    fetch(cdnDataUrl(`/data/pharmacy-duty-week-history/${weekStart}.json`), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Archive unavailable');
        const history = resolveDutyWeekHistory(await response.json(), weekStart);
        if (!history) throw new Error('Invalid archive');
        if (current) setState({ weekStart, history, failed: false });
      })
      .catch(() => { if (current) setState({ weekStart, history: null, failed: true }); })
      .finally(() => clearTimeout(timeout));
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [weekStart, attempt]);
  const history = state.weekStart === weekStart ? state.history : null;
  if (history) return <PharmacyDutyWeekArchiveView history={history} locale={locale} />;
  const copy = COPY[locale];
  const failed = state.weekStart === weekStart && state.failed;
  return <section className="mx-auto max-w-3xl space-y-4">
    <h1 className="font-display text-3xl font-bold text-heading">{dutyWeekArchiveTitle(weekStart, locale)}</h1>
    <p className="text-base leading-7 text-body" role="status">{failed ? copy.unavailable : copy.loading}</p>
    {failed && <button className="min-h-11 rounded-lg border border-edge px-4 py-2 font-semibold text-link" onClick={() => setAttempt((value) => value + 1)}>{copy.retry}</button>}
    <a className="inline-flex min-h-11 items-center text-link underline" href={PHARMACY_DUTY_HUB_PATH[locale]}>{copy.current}</a>
  </section>;
}
