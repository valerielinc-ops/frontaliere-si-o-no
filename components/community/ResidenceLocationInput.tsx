import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Autocomplete from '@/components/shared/Autocomplete';
import { useLocale, useTranslation } from '@/services/i18n';
import { formatResidenceLocation, loadResidenceLocalities, parseResidenceLocation, residenceCountries } from '@/services/residenceLocalities';

/** Preserve the existing location contract while making country provenance explicit. */
export default function ResidenceLocationInput({ value, onChange, countryCode, disabled = false, error, label }: { value: string; onChange: (value: string, countryCode?: string) => void; countryCode?: string; disabled?: boolean; error?: string; label?: string }) {
  const [locale] = useLocale();
  const { t } = useTranslation();
  const id = useId();
  const initial = parseResidenceLocation(value);
  const initialCountry = countryCode ?? initial.country;
  const initialTown = countryCode === undefined || (countryCode && initial.country === countryCode) ? initial.town : value;
  const [country, setCountry] = useState(initialCountry);
  const [town, setTown] = useState(initialTown);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const lastEmitted = useRef({ value, countryCode });
  const options = useMemo(() => residenceCountries(locale), [locale]);
  useEffect(() => {
    if (value === lastEmitted.current.value && countryCode === lastEmitted.current.countryCode) return;
    lastEmitted.current = { value, countryCode };
    const loaded = parseResidenceLocation(value);
    setCountry(countryCode ?? loaded.country);
    setTown(countryCode === undefined || (countryCode && loaded.country === countryCode) ? loaded.town : value);
  }, [countryCode, value]);
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
    lastEmitted.current = { value: next, countryCode: nextCountry }; onChange(next, nextCountry);
  };
  const changeCountry = (nextCountry: string) => {
    // Never carry a town chosen for a different country into the new country.
    let nextTown = country && nextCountry && nextCountry !== country ? '' : town;
    // For an unconfirmed free-text value, only strip a country suffix after
    // the user explicitly selects a country; the suffix itself never selects it.
    if (!country && nextCountry) {
      const parsed = parseResidenceLocation(town);
      if (parsed.country) nextTown = parsed.town;
    }
    setCountry(nextCountry); setTown(nextTown); emit(nextTown, nextCountry);
  };
  const hint = status === 'loading' ? 'residenceLoading' : status === 'error' ? 'residenceUnavailable'
    : country ? 'residenceManual' : 'residenceChooseCountry';
  const countrySuffixLength = formatResidenceLocation('x', country, locale).length - 1;
  const maxTownLength = Math.max(1, 120 - countrySuffixLength);
  const control = 'mt-1 min-h-11 w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-base text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return <div className="min-w-0 space-y-3">
    <div>
      <label htmlFor={`${id}-country`} className="block text-sm font-medium text-body">{t('jobBoard.concierge.residenceCountry')}</label>
      <select id={`${id}-country`} value={country} disabled={disabled} onChange={event => changeCountry(event.target.value)} autoComplete="country" className={control}>
        <option value="">{t('jobBoard.concierge.residenceCountryPlaceholder')}</option>
        {options.map(option => <option key={option.code} value={option.code}>{option.label}</option>)}
      </select>
    </div>
    <div>
      <label htmlFor={`${id}-town`} className="block text-sm font-medium text-body">{label || t('jobBoard.concierge.location')}</label>
      <Autocomplete id={`${id}-town`} value={town} onChange={next => { setTown(next); emit(next, country); }} suggestions={suggestions} disabled={disabled} invalid={Boolean(error)}
        autoComplete="address-level2" maxLength={maxTownLength} describedBy={`${id}-hint`} className={control} />
      <p id={`${id}-hint`} role={error ? "alert" : "status"} className={`mt-2 text-sm leading-relaxed ${error ? "text-danger" : "text-subtle"}`}>{error || t(`jobBoard.concierge.${hint}`)}</p>
      <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm text-link underline underline-offset-2">{t('jobBoard.concierge.residenceSource')}</a>
    </div>
  </div>;
}
