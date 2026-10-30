import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Autocomplete from '@/components/shared/Autocomplete';
import { useLocale, useTranslation } from '@/services/i18n';
import { formatResidenceLocation, loadResidenceLocalities, parseResidenceLocation, residenceCountries } from '@/services/residenceLocalities';

/** Preserve the existing location contract while making country provenance explicit. */
export default function ResidenceLocationInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [locale] = useLocale();
  const { t } = useTranslation();
  const id = useId();
  const initial = parseResidenceLocation(value);
  const [country, setCountry] = useState(initial.country);
  const [town, setTown] = useState(initial.town);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const lastEmitted = useRef(value);
  const options = useMemo(() => residenceCountries(locale), [locale]);
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const loaded = parseResidenceLocation(value);
    setCountry(loaded.country); setTown(loaded.town);
  }, [value]);
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    if (!country) { setStatus('idle'); return; }
    setStatus('loading');
    loadResidenceLocalities(country).then(values => {
      if (!cancelled) { setSuggestions(values); setStatus('ready'); }
    }).catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [country]);
  const emit = (nextTown: string, nextCountry: string) => {
    const next = formatResidenceLocation(nextTown, nextCountry, locale);
    lastEmitted.current = next; onChange(next);
  };
  const changeCountry = (nextCountry: string) => {
    // Never carry a town chosen for a different country into the new country.
    const nextTown = country && nextCountry && nextCountry !== country ? '' : town;
    setCountry(nextCountry); setTown(nextTown); emit(nextTown, nextCountry);
  };
  const hint = status === 'loading' ? 'residenceLoading' : status === 'error' ? 'residenceUnavailable'
    : country ? 'residenceManual' : 'residenceChooseCountry';
  const countryLabel = options.find(option => option.code === country)?.label || '';
  const maxTownLength = countryLabel ? Math.max(1, 120 - countryLabel.length - 2) : 120;
  const control = 'mt-1 min-h-11 w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-base text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return <div className="min-w-0 space-y-3">
    <div>
      <label htmlFor={`${id}-country`} className="block text-sm font-medium text-body">{t('jobBoard.concierge.residenceCountry')}</label>
      <select id={`${id}-country`} value={country} onChange={event => changeCountry(event.target.value)} autoComplete="country" className={control}>
        <option value="">{t('jobBoard.concierge.residenceCountryPlaceholder')}</option>
        {options.map(option => <option key={option.code} value={option.code}>{option.label}</option>)}
      </select>
    </div>
    <div>
      <label htmlFor={`${id}-town`} className="block text-sm font-medium text-body">{t('jobBoard.concierge.location')}</label>
      <Autocomplete id={`${id}-town`} value={town} onChange={next => { setTown(next); emit(next, country); }} suggestions={suggestions}
        autoComplete="address-level2" maxLength={maxTownLength} describedBy={`${id}-hint`} className={control} />
      <p id={`${id}-hint`} role="status" className="mt-2 text-sm leading-relaxed text-subtle">{t(`jobBoard.concierge.${hint}`)}</p>
      <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm text-link underline underline-offset-2">{t('jobBoard.concierge.residenceSource')}</a>
    </div>
  </div>;
}
