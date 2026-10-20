export type FuelTripCurrency = 'CHF' | 'EUR';

export interface FuelExchangeRateCandidate {
  provider?: unknown;
  sourceUrl?: unknown;
  rateDate?: unknown;
  chfPerEur?: unknown;
  eurPerChf?: unknown;
}

export interface DatedFuelExchangeRate {
  readonly provider: 'ECB';
  readonly sourceUrl: string;
  readonly rateDate: string;
  readonly chfPerEur: number;
  readonly eurPerChf: number;
}

export interface FuelTripCalculatorInput {
  referencePrice: number | null;
  alternativePrice: number | null;
  liters: number | null;
  /** Additional route distance for the complete round trip. */
  additionalRoundTripKm: number | null;
  vehicleCostPerKm: number | null;
  otherTripCosts: number | null;
  /** Optional number of comparable trips per month. */
  monthlyTrips: number | null;
}

export interface FuelTripCalculatorResult {
  status: 'ready' | 'incomplete' | 'invalid';
  grossDifference: number | null;
  tripCosts: number | null;
  netDifference: number | null;
  monthlyGrossDifference: number | null;
  monthlyTripCosts: number | null;
  monthlyNetDifference: number | null;
  breakEvenAdditionalRoundTripKm: number | null;
  breakEvenLiters: number | null;
}

export interface FuelTripCalculatorCopy {
  title: string;
  description: string;
  assumptionNote: string;
  referencePrice: string;
  alternativePrice: string;
  liters: string;
  additionalRoundTripKm: string;
  roundTripHint: string;
  vehicleCostPerKm: string;
  otherTripCosts: string;
  monthlyTrips: string;
  optional: string;
  resultTitle: string;
  gross: string;
  tripCosts: string;
  net: string;
  monthlyNet: string;
  breakEvenKm: string;
  breakEvenLiters: string;
  breakEvenUnavailable: string;
  incomplete: string;
  invalid: string;
  positiveMeaning: string;
  currency: string;
  sourceLabel: string;
  dateLabel: string;
  dateUnavailable: string;
  fxLabel: string;
  noDatedFx: string;
}

export interface RenderFuelTripCalculatorOptions {
  locale: 'it' | 'en' | 'de' | 'fr';
  fuel: 'benzina' | 'diesel';
  currency: FuelTripCurrency;
  id: string;
  referencePrice: number | null;
  alternativePrice?: number | null;
  referenceSource?: string | null;
  referenceDate?: string | null;
  alternativeSource?: string | null;
  alternativeDate?: string | null;
  exchangeRateDate?: string | null;
  showExchangeRateNote?: boolean;
  copy: FuelTripCalculatorCopy;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function renderPriceProvenanceText(source: string | null | undefined, date: string | null | undefined, copy: FuelTripCalculatorCopy): string {
  if (!source && !date) return '';
  const parts = [source ? `${copy.sourceLabel}: ${source}` : '', source ? `${copy.dateLabel}: ${date || copy.dateUnavailable}` : date ? `${copy.dateLabel}: ${date}` : ''].filter(Boolean);
  return parts.join(' · ');
}

/** Render the shared calculator form for static daily and city pages. */
export function renderFuelTripCalculatorMarkup(options: RenderFuelTripCalculatorOptions): string {
  const { locale, fuel, currency, id, copy } = options;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '-');
  const value = (price: number | null | undefined) => typeof price === 'number' && Number.isFinite(price) && price > 0 ? String(price) : '';
  const input = (name: string, label: string, initial: string, min: string, step: string, help = '', provenance = '') => {
    const inputId = `${safeId}-${name}`;
    const describedBy = help ? ` aria-describedby="${safeId}-${name}-help"` : '';
    return `<label for="${inputId}" class="block text-sm font-semibold text-body">${escapeAttribute(label)}
      <input id="${inputId}" data-fuel-trip-field="${name}" type="number" inputmode="decimal" min="${min}" step="${step}" value="${initial}"${describedBy} class="mt-1.5 min-h-[44px] w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-strong outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent">
      ${help ? `<span id="${safeId}-${name}-help" class="mt-1 block text-xs font-normal text-muted">${escapeAttribute(help)}</span>` : ''}
      ${provenance ? `<span class="mt-1 block text-xs font-normal text-muted">${escapeAttribute(provenance)}</span>` : ''}
    </label>`;
  };
  const resultRow = (name: string, label: string, initial = '') => `<div data-fuel-trip-result="${name}" hidden class="hidden items-center justify-between gap-3 border-t border-edge py-2 text-sm"><dt class="text-body">${escapeAttribute(label)}</dt><dd data-fuel-trip-value class="m-0 text-right font-bold tabular-nums text-heading">${initial}</dd></div>`;
  const attrs = {
    'data-currency': currency,
    'data-locale': locale,
    'data-fuel': fuel,
    'data-label-gross': copy.gross,
    'data-label-costs': copy.tripCosts,
    'data-label-net': copy.net,
    'data-label-monthly': copy.monthlyNet,
    'data-label-break-even-km': copy.breakEvenKm,
    'data-label-break-even-liters': copy.breakEvenLiters,
    'data-message-incomplete': copy.incomplete,
    'data-message-invalid': copy.invalid,
    'data-message-no-break-even': copy.breakEvenUnavailable,
  };
  const attributes = Object.entries(attrs).map(([key, raw]) => `${key}="${escapeAttribute(raw)}"`).join(' ');
  const fxNote = options.showExchangeRateNote === false ? '' : options.exchangeRateDate
    ? `<p class="mt-2 text-xs text-muted">${escapeAttribute(copy.fxLabel)}: ${escapeAttribute(options.exchangeRateDate)}</p>`
    : `<p class="mt-2 text-xs text-muted">${escapeAttribute(copy.noDatedFx)}</p>`;
  return `<section class="s-card my-5 p-4 sm:p-5" data-fuel-trip-calculator ${attributes} aria-labelledby="${safeId}-title">
    <h2 id="${safeId}-title" class="s-h2 mt-0">${escapeAttribute(copy.title)}</h2>
    <p class="mb-3 text-sm leading-6 text-subtle">${escapeAttribute(copy.description)}</p>
    <p class="mb-3 text-xs leading-5 text-muted">${escapeAttribute(copy.assumptionNote)}</p>
    ${fxNote}
    <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      ${input('referencePrice', `${copy.referencePrice} (${currency}/L)`, value(options.referencePrice), '0', '0.001', '', renderPriceProvenanceText(options.referenceSource, options.referenceDate, copy))}
      ${input('alternativePrice', `${copy.alternativePrice} (${currency}/L)`, value(options.alternativePrice), '0', '0.001', '', renderPriceProvenanceText(options.alternativeSource, options.alternativeDate, copy))}
      ${input('liters', copy.liters, '50', '0', 'any')}
      ${input('additionalRoundTripKm', copy.additionalRoundTripKm, '', '0', 'any', copy.roundTripHint)}
      ${input('vehicleCostPerKm', `${copy.vehicleCostPerKm} (${currency}/km)`, '0.18', '0', 'any')}
      ${input('otherTripCosts', `${copy.otherTripCosts} (${currency})`, '0', '0', 'any')}
      ${input('monthlyTrips', `${copy.monthlyTrips} · ${copy.optional}`, '', '0', '1')}
    </div>
    <div class="mt-4 rounded-xl bg-surface-alt p-4" aria-live="polite" aria-atomic="true">
      <h3 class="m-0 text-base font-bold text-heading">${escapeAttribute(copy.resultTitle)}</h3>
      <p data-fuel-trip-output class="mb-1 mt-1 min-h-5 text-sm text-muted"></p>
      <dl class="m-0 mt-2 space-y-0">
        ${resultRow('gross', copy.gross)}${resultRow('costs', copy.tripCosts)}${resultRow('net', copy.net)}${resultRow('monthly', copy.monthlyNet)}
        ${resultRow('breakEvenKm', copy.breakEvenKm)}${resultRow('breakEvenLiters', copy.breakEvenLiters)}
      </dl>
      <p class="mb-0 mt-2 text-xs leading-5 text-muted">${escapeAttribute(copy.positiveMeaning)}</p>
    </div>
    <script>${fuelTripCalculatorInlineScript()}</script>
  </section>`;
}

/**
 * Accept only a real, dated ECB reference rate. Undated or unverified cached
 * conversions must never make two pump prices look directly comparable.
 */
export function datedFuelExchangeRate(candidate: FuelExchangeRateCandidate | null | undefined): DatedFuelExchangeRate | null {
  if (!candidate || candidate.provider !== 'ECB') return null;
  if (typeof candidate.sourceUrl !== 'string' || !candidate.sourceUrl.startsWith('https://www.ecb.europa.eu/')) return null;
  if (typeof candidate.rateDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.rateDate)) return null;
  const parsedDate = new Date(`${candidate.rateDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== candidate.rateDate) return null;
  if (typeof candidate.chfPerEur !== 'number' || !Number.isFinite(candidate.chfPerEur) || candidate.chfPerEur <= 0) return null;
  if (typeof candidate.eurPerChf !== 'number' || !Number.isFinite(candidate.eurPerChf) || candidate.eurPerChf <= 0) return null;
  if (Math.abs(candidate.chfPerEur * candidate.eurPerChf - 1) > 0.01) return null;
  return {
    provider: 'ECB',
    sourceUrl: candidate.sourceUrl,
    rateDate: candidate.rateDate,
    chfPerEur: candidate.chfPerEur,
    eurPerChf: candidate.eurPerChf,
  };
}

/** Return a positive price in the target currency, or null when conversion is not supported. */
export function convertFuelPrice(
  price: number | null,
  from: FuelTripCurrency,
  to: FuelTripCurrency,
  rate: DatedFuelExchangeRate | null,
): number | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (from === to) return price;
  if (!rate) return null;
  const converted = from === 'CHF' ? price * rate.eurPerChf : price * rate.chfPerEur;
  return Number.isFinite(converted) && converted > 0 ? Number(converted.toFixed(4)) : null;
}

/**
 * Pure trip comparison shared by the SPA and the static fuel-page widget.
 * Positive differences favor the alternative price after the entered trip
 * costs. Route kilometres already cover the complete round trip.
 */
export function calculateFuelTrip(input: FuelTripCalculatorInput): FuelTripCalculatorResult {
  const emptyResult: Omit<FuelTripCalculatorResult, 'status'> = {
    grossDifference: null,
    tripCosts: null,
    netDifference: null,
    monthlyGrossDifference: null,
    monthlyTripCosts: null,
    monthlyNetDifference: null,
    breakEvenAdditionalRoundTripKm: null,
    breakEvenLiters: null,
  };
  const required: Array<[number | null, number]> = [
    [input.referencePrice, 0],
    [input.alternativePrice, 0],
    [input.liters, 0],
    [input.additionalRoundTripKm, 0],
    [input.vehicleCostPerKm, 0],
    [input.otherTripCosts, 0],
  ];
  let missing = false;
  let invalid = false;
  for (const [value, min] of required) {
    if (value === null) {
      missing = true;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
      invalid = true;
    }
  }

  // Zero litres and zero prices cannot represent a usable comparison, while
  // zero route distance/cost is valid when a user explicitly enters it.
  if (input.referencePrice !== null && (!(input.referencePrice > 0) || !Number.isFinite(input.referencePrice))) invalid = true;
  if (input.alternativePrice !== null && (!(input.alternativePrice > 0) || !Number.isFinite(input.alternativePrice))) invalid = true;
  if (input.liters !== null && (!(input.liters > 0) || !Number.isFinite(input.liters))) invalid = true;
  if (input.monthlyTrips !== null && (typeof input.monthlyTrips !== 'number' || !Number.isFinite(input.monthlyTrips) || input.monthlyTrips < 0)) invalid = true;

  if (invalid || missing) return { status: invalid ? 'invalid' : 'incomplete', ...emptyResult };

  const referencePrice = input.referencePrice as number;
  const alternativePrice = input.alternativePrice as number;
  const liters = input.liters as number;
  const additionalRoundTripKm = input.additionalRoundTripKm as number;
  const vehicleCostPerKm = input.vehicleCostPerKm as number;
  const otherTripCosts = input.otherTripCosts as number;
  const grossDifference = (referencePrice - alternativePrice) * liters;
  const tripCosts = additionalRoundTripKm * vehicleCostPerKm + otherTripCosts;
  const netDifference = grossDifference - tripCosts;
  const priceAdvantagePerLiter = referencePrice - alternativePrice;
  const monthlyTrips = input.monthlyTrips;
  const monthlyGrossDifference = monthlyTrips === null ? null : grossDifference * monthlyTrips;
  const monthlyTripCosts = monthlyTrips === null ? null : tripCosts * monthlyTrips;
  const monthlyNetDifference = monthlyTrips === null ? null : netDifference * monthlyTrips;
  const breakEvenAdditionalRoundTripKm =
    priceAdvantagePerLiter > 0 && vehicleCostPerKm > 0 && grossDifference >= otherTripCosts
      ? (grossDifference - otherTripCosts) / vehicleCostPerKm
      : null;
  const breakEvenLiters = priceAdvantagePerLiter > 0
    ? tripCosts / priceAdvantagePerLiter
    : null;
  if ([grossDifference, tripCosts, netDifference, monthlyGrossDifference, monthlyTripCosts, monthlyNetDifference, breakEvenAdditionalRoundTripKm, breakEvenLiters]
    .some((value) => value !== null && !Number.isFinite(value))) return { status: 'invalid', ...emptyResult };

  return {
    status: 'ready',
    grossDifference,
    tripCosts,
    netDifference,
    monthlyGrossDifference,
    monthlyTripCosts,
    monthlyNetDifference,
    breakEvenAdditionalRoundTripKm,
    breakEvenLiters,
  };
}

/**
 * Static pages execute this small DOM adapter around the exact pure function
 * above. Inputs and localized copy come from escaped HTML attributes; results
 * are written with textContent so source data can never become markup.
 */
export function fuelTripCalculatorInlineScript(): string {
  return `(function(){var calculate=${calculateFuelTrip.toString()};document.querySelectorAll('[data-fuel-trip-calculator]').forEach(function(root){var fields={};root.querySelectorAll('[data-fuel-trip-field]').forEach(function(el){fields[el.getAttribute('data-fuel-trip-field')]=el;});var output=root.querySelector('[data-fuel-trip-output]');var resultRows={};root.querySelectorAll('[data-fuel-trip-result]').forEach(function(el){resultRows[el.getAttribute('data-fuel-trip-result')]=el;});var tracked=false;var number=function(name){var el=fields[name];if(!el||el.value.trim()==='')return null;var value=Number(el.value);return Number.isFinite(value)?value:NaN;};var currency=root.getAttribute('data-currency')||'EUR';var locale=root.getAttribute('data-locale')||'it';var localeTag={it:'it-IT',en:'en-GB',de:'de-CH',fr:'fr-CH'}[locale]||'it-IT';var money=function(value){return new Intl.NumberFormat(localeTag,{style:'currency',currency:currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(value);};var numberFmt=function(value){return new Intl.NumberFormat(localeTag,{minimumFractionDigits:0,maximumFractionDigits:1}).format(value);};var unavailable=root.getAttribute('data-message-no-break-even')||'';var statusText={incomplete:root.getAttribute('data-message-incomplete')||'',invalid:root.getAttribute('data-message-invalid')||''};function showRow(name,value){var row=resultRows[name];if(!row)return;row.hidden=value===null;row.classList.toggle('hidden',value===null);var target=row.querySelector('[data-fuel-trip-value]');if(target)target.textContent=value===null?'':value;}function update(event){var calculation=calculate({referencePrice:number('referencePrice'),alternativePrice:number('alternativePrice'),liters:number('liters'),additionalRoundTripKm:number('additionalRoundTripKm'),vehicleCostPerKm:number('vehicleCostPerKm'),otherTripCosts:number('otherTripCosts'),monthlyTrips:number('monthlyTrips')});if(calculation.status!=='ready'){if(output)output.textContent=statusText[calculation.status]||'';Object.keys(resultRows).forEach(function(name){resultRows[name].hidden=true;resultRows[name].classList.add('hidden');});return;}if(output)output.textContent='';showRow('gross',money(calculation.grossDifference));showRow('costs',money(calculation.tripCosts));showRow('net',money(calculation.netDifference));showRow('monthly',calculation.monthlyNetDifference===null?null:money(calculation.monthlyNetDifference));showRow('breakEvenKm',calculation.breakEvenAdditionalRoundTripKm===null?unavailable:numberFmt(calculation.breakEvenAdditionalRoundTripKm)+' km');showRow('breakEvenLiters',calculation.breakEvenLiters===null?unavailable:numberFmt(calculation.breakEvenLiters)+' L');if(!tracked&&event&&event.type==='input'){tracked=true;var layer=window.dataLayer=window.dataLayer||[];layer.push({event:'fuel_trip_calculated',fuel_type:root.getAttribute('data-fuel')||'unknown',render_path:'static',outcome:calculation.netDifference>0?'positive':calculation.netDifference<0?'negative':'break_even'});}}Object.keys(fields).forEach(function(name){fields[name].addEventListener('input',update);});update();});})();`;
}
