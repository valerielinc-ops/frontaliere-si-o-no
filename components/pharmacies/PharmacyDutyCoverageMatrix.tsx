import React, { useMemo } from 'react';
import {
  buildDutyCoverageMatrix,
  formatDutyCoverageDate,
  formatDutyDateTime,
  getDutyCoverageMatrixCopy,
} from '@/services/pharmacies/dutyCoverageMatrix';
import { formatItalyDutyDateTime } from '@/services/pharmacies/italyDuty';
import { pharmacyById, pharmacyCitySlug, provinceSlugForPharmacy } from '@/services/pharmacies/data';
import { buildPharmacyPath } from '@/services/pharmacies/paths';
import type { Locale } from '@/services/i18n';
import type { ItalyDutySourceRegistry } from '@/services/pharmacies/italyDuty';
import type { ItalyDutySnapshot } from '@/services/pharmacies/italyRelease';
import type {
  PharmacyCatalogueDataset,
  PharmacyDutiesDataset,
  PharmacySourcesRegistry,
} from '@/services/pharmacies/types';

export interface PharmacyDutyCoverageMatrixProps {
  locale: Locale;
  now?: Date;
  weekStart?: string;
  duties?: PharmacyDutiesDataset;
  catalogue?: PharmacyCatalogueDataset;
  registry?: PharmacySourcesRegistry;
  italyDuties?: ItalyDutySnapshot;
  italyStatus?: ItalyDutySnapshot;
  italySources?: ItalyDutySourceRegistry;
}

function pharmacyHref(pharmacyId: string, locale: Locale): string | null {
  const pharmacy = pharmacyById(pharmacyId);
  if (!pharmacy || pharmacy.country !== 'CH') return null;
  return buildPharmacyPath({
    kind: 'pharmacy',
    country: 'CH',
    citySlug: pharmacyCitySlug(pharmacy.city),
    pharmacySlug: pharmacy.slug,
    locale,
  }, locale);
}

function italyPharmacyHref(pharmacyId: string, locale: Locale): string | null {
  const pharmacy = pharmacyById(pharmacyId);
  if (!pharmacy || pharmacy.country !== 'IT') return null;
  const areaSlug = provinceSlugForPharmacy(pharmacy);
  if (!areaSlug) return null;
  return buildPharmacyPath({
    kind: 'pharmacy',
    country: 'IT',
    areaSlug,
    citySlug: pharmacyCitySlug(pharmacy.city),
    pharmacySlug: pharmacy.slug,
    locale,
  }, locale);
}

export default function PharmacyDutyCoverageMatrix({
  locale,
  now,
  weekStart,
  duties,
  catalogue,
  registry,
  italyDuties,
  italyStatus,
  italySources,
}: PharmacyDutyCoverageMatrixProps) {
  const matrix = useMemo(() => buildDutyCoverageMatrix({ locale, now, weekStart, duties, catalogue, registry, italyDuties, italyStatus, italySources }), [catalogue, duties, italyDuties, italySources, italyStatus, locale, now, registry, weekStart]);
  const copy = getDutyCoverageMatrixCopy(locale);

  return <section className="space-y-6" aria-labelledby="pharmacy-duty-coverage-matrix-heading" data-coverage-matrix="true" data-release-ready={String(matrix.releaseReady)} data-italy-release-ready={String(matrix.italy.publishable)} data-italy-indexable={String(matrix.italy.indexable)} data-italy-release-state={matrix.italy.state}>
    <header className="space-y-3">
      <h2 id="pharmacy-duty-coverage-matrix-heading" className="font-display text-2xl font-bold tracking-tight text-heading">{copy.heading}</h2>
      <p className="max-w-3xl text-base leading-7 text-muted">{copy.lede}</p>
    </header>

    <section className="space-y-4" aria-labelledby="pharmacy-duty-coverage-ticino-heading">
      <div className="space-y-2">
        <h3 id="pharmacy-duty-coverage-ticino-heading" className="font-display text-xl font-bold text-heading">{copy.ticinoHeading}</h3>
        <p className="text-sm leading-6 text-muted" role="status">{matrix.releaseReady ? copy.readyNotice : copy.unavailableNotice(matrix.status)}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {matrix.regions.map((region) => <article key={region.key} className="overflow-hidden rounded-2xl border border-edge bg-surface" data-coverage-kind="ticino-region" data-region-key={region.key}>
          <header className="border-b border-edge bg-surface-alt px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h4 className="font-display text-lg font-bold text-heading">{region.name}</h4>
              {matrix.releaseReady && region.sourceUrl && <a className="text-sm font-semibold text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={region.sourceUrl} rel="nofollow noopener">{copy.openSource}<span aria-hidden="true"> ↗</span></a>}
            </div>
          </header>
          {matrix.releaseReady && region.duties.length > 0
            ? <ul className="divide-y divide-edge">
              {region.duties.map((duty) => {
                const pharmacy = pharmacyById(duty.pharmacyId);
                const href = pharmacyHref(duty.pharmacyId, locale);
                return <li key={duty.id} className="space-y-2 px-5 py-4" data-duty-id={duty.id}>
                  <p className="text-sm font-semibold text-heading">{copy.pharmacy}: {pharmacy && href ? <a className="text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href}>{pharmacy.name}</a> : <span>{copy.notResolved}</span>}</p>
                  <p className="text-sm text-body"><span className="font-semibold">{copy.interval}:</span> <time dateTime={duty.startsAt}>{formatDutyDateTime(duty.startsAt)}</time> – <time dateTime={duty.endsAt}>{formatDutyDateTime(duty.endsAt)}</time></p>
                </li>;
              })}
            </ul>
            : <p className="px-5 py-4 text-sm text-muted" role="status">{copy.noIntervals}</p>}
        </article>)}
      </div>
    </section>

    <section className="space-y-4" aria-labelledby="pharmacy-duty-coverage-italy-heading">
      <div className="space-y-2">
        <h3 id="pharmacy-duty-coverage-italy-heading" className="font-display text-xl font-bold text-heading">{copy.italyHeading}</h3>
        <p className="max-w-3xl text-sm leading-6 text-muted" role="status">{matrix.italy.indexable ? copy.italyReadyNotice : matrix.italy.publishable ? `${copy.italyPartialNotice} ${matrix.italy.reason}` : `${copy.italyUnavailableNotice(matrix.italy.state)} ${matrix.italy.reason}`}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {matrix.italy.provinces.map((province) => <article key={province.code} className="overflow-hidden rounded-2xl border border-edge bg-surface" data-coverage-kind="italy-province" data-province-code={province.code} {...(province.publishable ? { 'data-italy-duty-published': 'true' } : {})}>
          <header className="border-b border-edge bg-surface-alt px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="font-display text-lg font-bold text-heading">{province.name}</h4>
                <p className={`text-xs font-semibold uppercase tracking-wide ${province.publishable ? 'text-emerald-700' : 'text-amber-800'}`}>{province.publishable ? copy.italyPublishedLabel : copy.italyNotPublishedLabel}</p>
              </div>
              {province.sourceUrl && <a className="text-sm font-semibold text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={province.sourceUrl} rel="nofollow noopener">{copy.openOfficialSource}<span aria-hidden="true"> ↗</span></a>}
            </div>
          </header>
          {province.publishable && province.duties.length > 0
            ? <ul className="divide-y divide-edge">
              {province.duties.map((duty) => {
                const pharmacy = pharmacyById(duty.pharmacyId);
                const href = italyPharmacyHref(duty.pharmacyId, locale);
                return <li key={duty.id} className="space-y-2 px-5 py-4" data-duty-id={duty.id} data-duty-country="IT">
                  <p className="text-sm font-semibold text-heading">{copy.pharmacy}: {pharmacy && href ? <a className="text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href}>{pharmacy.name}</a> : <span>{copy.notResolved}</span>}</p>
                  <p className="text-sm text-body"><span className="font-semibold">{copy.interval}:</span> <time dateTime={duty.startsAt}>{formatItalyDutyDateTime(duty.startsAt)}</time> – <time dateTime={duty.endsAt}>{formatItalyDutyDateTime(duty.endsAt)}</time></p>
                </li>;
              })}
            </ul>
            : <p className="px-5 py-4 text-sm text-muted" role="status">{province.publishable ? copy.noIntervals : copy.italyUnavailableNotice(matrix.italy.state)}</p>}
        </article>)}
      </div>
    </section>

    <section className="space-y-4" aria-labelledby="pharmacy-duty-coverage-source-only-heading">
      <div className="space-y-2">
        <h3 id="pharmacy-duty-coverage-source-only-heading" className="font-display text-xl font-bold text-heading">{copy.sourceOnlyHeading}</h3>
        <p className="max-w-3xl text-sm leading-6 text-muted">{copy.sourceOnlyLede}</p>
      </div>
      <ul className="divide-y divide-edge border-y border-edge" aria-label={copy.sourceOnlyHeading}>
        {matrix.sourceOnlyCantons.map((canton) => <li key={canton.code} className="grid gap-4 px-1 py-4 sm:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)]" data-coverage-kind="source-only-canton" data-canton-code={canton.code} data-source-status={canton.status || 'unavailable'} data-source-type={canton.sourceType || 'unavailable'}>
          <div className="space-y-1">
            <h4 className="font-display text-lg font-semibold text-heading">{canton.name}</h4>
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">{copy.sourceOnlyLabel}</p>
          </div>
          <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="font-semibold text-body">{copy.status}</dt><dd className="text-muted">{copy.statusLabel(canton.status)}</dd></div>
            <div><dt className="font-semibold text-body">{copy.sourceType}</dt><dd className="text-muted">{copy.sourceTypeLabel(canton.sourceType)}</dd></div>
            <div><dt className="font-semibold text-body">{copy.lastVerifiedAt}</dt><dd className="text-muted">{canton.lastVerifiedAt ? <time dateTime={canton.lastVerifiedAt}>{formatDutyCoverageDate(canton.lastVerifiedAt, locale)}</time> : copy.notAvailable}</dd></div>
            <div><dt className="font-semibold text-body">{copy.officialSource}</dt><dd>{canton.officialSourceUrl ? <a className="text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={canton.officialSourceUrl} rel="nofollow noopener">{copy.openOfficialSource}<span aria-hidden="true"> ↗</span></a> : <span className="text-muted">{copy.notAvailable}</span>}</dd></div>
          </dl>
        </li>)}
      </ul>
    </section>
  </section>;
}
