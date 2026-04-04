import React, { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import type { UserProfileData } from '@/components/pages/UserProfile';
import { Briefcase, Plus, Trash2, Trophy, Car, Clock, DollarSign, TrendingUp, Home, Coffee, ParkingCircle, Info, Calculator, MapPin } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { calculateSimulation } from '@/services/calculationService';
import { Analytics } from '@/services/analytics';
import { DEFAULT_INPUTS } from '@/constants';
import { useExchangeRate } from '@/services/exchangeRateService';
import { useTranslation } from '@/services/i18n';

interface JobOffer {
  id: string;
  companyName: string;
  country: 'CH' | 'IT';
  grossSalaryCHF: number;
  distanceKm: number;
  travelTimeMin: number;
  hasMealVouchers: boolean;
  mealVoucherValue: number;
  hasParking: boolean;
  parkingCostMonthly: number;
  homeOfficeDays: number;
  otherBenefitsCHF: number;
  canton: string;
}

const defaultOffer = (): JobOffer => ({
  id: Math.random().toString(36).substr(2, 9),
  companyName: '',
  country: 'CH',
  grossSalaryCHF: 100000,
  distanceKm: 30,
  travelTimeMin: 45,
  hasMealVouchers: false,
  mealVoucherValue: 8,
  hasParking: false,
  parkingCostMonthly: 150,
  homeOfficeDays: 0,
  otherBenefitsCHF: 0,
  canton: 'TI',
});

const JobComparator: React.FC<{ userProfile?: UserProfileData | null }> = ({ userProfile }) => {
  const { t } = useTranslation();
  const { rate: exchangeRate } = useExchangeRate();
  const [offers, setOffers] = useState<JobOffer[]>([
    { ...defaultOffer(), companyName: '', grossSalaryCHF: 100000, country: 'CH' },
    { ...defaultOffer(), companyName: '', grossSalaryCHF: 110000, distanceKm: 50, travelTimeMin: 60, country: 'CH' },
  ]);

  // Prefill salary from user profile
  useEffect(() => {
    if (userProfile?.grossSalary) {
      const s = parseFloat(userProfile.grossSalary);
      if (!isNaN(s) && s > 0) {
        setOffers(prev => prev.map((o, i) => i === 0 ? { ...o, grossSalaryCHF: s } : { ...o, grossSalaryCHF: Math.round(s * 1.1) }));
      }
    }
  }, [userProfile]);

  const addOffer = () => {
    if (offers.length >= 4) return;
    setOffers([...offers, { ...defaultOffer(), companyName: `${t('jobs.offer')} ${offers.length + 1}` }]);
    Analytics.trackJobComparison('add_job', offers.length + 1);
  };

  const removeOffer = (id: string) => {
    if (offers.length <= 2) return;
    setOffers(offers.filter(o => o.id !== id));
  };

  const updateOffer = (id: string, field: keyof JobOffer, value: any) => {
    setOffers(offers.map(o => o.id === id ? { ...o, [field]: value } : o));
  };

  const results = useMemo(() => {
    return offers.map(offer => {
      // Calculate net salary using the simulator
      const inputs = {
        ...DEFAULT_INPUTS,
        annualIncomeCHF: offer.grossSalaryCHF,
        frontierWorkerType: 'NEW' as const,
      };
      const sim = calculateSimulation(inputs);
      
      // For CH positions: use standard frontaliere calculation
      // For IT positions: salary is in EUR, different tax model
      const isIT = offer.country === 'IT';
      const netMonthlyIT = isIT 
        ? offer.grossSalaryCHF * 0.65 / 12 // Rough IT net estimate (~65% of gross for IT contracts)
        : sim.itResident.netIncomeMonthly;
      const netMonthlyCH = isIT ? 0 : sim.chResident.netIncomeMonthly;

      // Transport costs (monthly)
      const workDays = 22 - (offer.homeOfficeDays * 4.33);
      const fuelCostPerKm = 0.15; // EUR
      const tollsPerDay = offer.distanceKm > 40 ? 5 : 0;
      const transportCostMonthly = (offer.distanceKm * 2 * fuelCostPerKm * workDays) + (tollsPerDay * workDays);

      // Parking costs
      const parkingCost = offer.hasParking ? 0 : offer.parkingCostMonthly;

      // Meal savings (only for IT positions)
      const mealSaving = (offer.hasMealVouchers && isIT) ? offer.mealVoucherValue * workDays : 0;

      // Time cost (value at €15/hour)
      const timeCostMonthly = (offer.travelTimeMin / 60 * 2 * workDays) * 15;

      // Other benefits
      const otherBenefitsMonthly = isIT 
        ? offer.otherBenefitsCHF / 12 
        : offer.otherBenefitsCHF / 12 / exchangeRate;

      // Net advantage (IT resident perspective)
      const totalCosts = transportCostMonthly + parkingCost + timeCostMonthly;
      const totalBenefits = mealSaving + otherBenefitsMonthly;
      const effectiveNetMonthly = netMonthlyIT - totalCosts + totalBenefits;

      return {
        offer,
        netMonthlyIT,
        netMonthlyCH,
        transportCostMonthly,
        parkingCost,
        mealSaving,
        timeCostMonthly,
        otherBenefitsMonthly,
        totalCosts,
        totalBenefits,
        effectiveNetMonthly,
        workDays,
      };
    }).sort((a, b) => b.effectiveNetMonthly - a.effectiveNetMonthly);
  }, [offers]);

  const bestResult = results[0];

  const offerColors = ['amber', 'emerald', 'stone', 'rose'];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="pb-6 border-b-2 border-amber-200 dark:border-amber-800">
        <div className="flex items-center gap-3 mb-3">
          <Briefcase size={28} className="text-amber-700 dark:text-amber-400" />
          <h1 className="text-3xl sm:text-4xl font-extrabold text-stone-800 dark:text-stone-100">{t('jobs.title')}</h1>
        </div>
        <p className="text-lg text-stone-500 dark:text-stone-400">{t('jobs.subtitle')}</p>
      </div>

      {/* Offers Input */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {offers.map((offer, idx) => (
          <div key={offer.id} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <input
                type="text"
                value={offer.companyName}
                onChange={(e) => updateOffer(offer.id, 'companyName', e.target.value)}
                className="text-lg font-bold text-slate-800 dark:text-slate-100 bg-transparent border-none outline-none focus:ring-2 focus:ring-amber-500 w-full"
                placeholder={t('jobs.companyName')}
                aria-label="Nome azienda"
              />
              {offers.length > 2 && (
                <button onClick={() => removeOffer(offer.id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2" aria-label={t('jobs.removeOffer')}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>

            <div className="space-y-3">
              {/* Country selector */}
              <div>
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                  <MapPin size={12} />
                  {t('jobs.country') || 'Paese posizione'}
                </label>
                <div className="flex gap-1 mt-1">
                  <button
                    onClick={() => {
                      updateOffer(offer.id, 'country', 'CH');
                      if (offer.hasMealVouchers) updateOffer(offer.id, 'hasMealVouchers', false);
                    }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold transition-colors ${
                      offer.country === 'CH'
                        ? 'bg-red-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    🇨🇭 Svizzera
                  </button>
                  <button
                    onClick={() => updateOffer(offer.id, 'country', 'IT')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold transition-colors ${
                      offer.country === 'IT'
                        ? 'bg-green-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    🇮🇹 Italia
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">
                  {offer.country === 'CH' ? t('jobs.grossSalary') : t('jobs.grossSalaryIT')}
                </label>
                <input type="number" value={offer.grossSalaryCHF} onChange={(e) => updateOffer(offer.id, 'grossSalaryCHF', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  min={0} step={1000} aria-label="Stipendio lordo annuo" />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('jobs.distance')}</label>
                  <input type="number" value={offer.distanceKm} onChange={(e) => updateOffer(offer.id, 'distanceKm', Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    min={0} aria-label="Distanza in km" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('jobs.travelTime')}</label>
                  <input type="number" value={offer.travelTimeMin} onChange={(e) => updateOffer(offer.id, 'travelTimeMin', Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    min={0} aria-label="Tempo di viaggio in minuti" />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('jobs.homeOffice')}</label>
                <input type="range" min={0} max={5} value={offer.homeOfficeDays} onChange={(e) => updateOffer(offer.id, 'homeOfficeDays', Number(e.target.value))}
                  className="w-full accent-amber-600" aria-label="Giorni di home office a settimana" />
                <div className="text-center text-sm font-bold text-slate-700 dark:text-slate-300">{offer.homeOfficeDays} {t('jobs.days')}</div>
              </div>

              {offer.country === 'IT' && (
                <div className="flex items-center gap-2">
                  <input type="checkbox" id={`meal-vouchers-${offer.id}`} checked={offer.hasMealVouchers} onChange={(e) => updateOffer(offer.id, 'hasMealVouchers', e.target.checked)}
                    className="w-4 h-4 text-amber-600 rounded" />
                  <label htmlFor={`meal-vouchers-${offer.id}`} className="text-xs font-bold text-slate-600 dark:text-slate-400">{t('jobs.mealVouchers')} (€{offer.mealVoucherValue}/{t('common.day') || 'gg'})</label>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input type="checkbox" id={`parking-${offer.id}`} checked={offer.hasParking} onChange={(e) => updateOffer(offer.id, 'hasParking', e.target.checked)}
                  className="w-4 h-4 text-amber-600 rounded" />
                <label htmlFor={`parking-${offer.id}`} className="text-xs font-bold text-slate-600 dark:text-slate-400">{t('jobs.parking')}</label>
              </div>
            </div>
          </div>
        ))}

        {offers.length < 4 && (
          <button
            onClick={addOffer}
            className="rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-600 p-4 sm:p-6 flex flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400 hover:text-amber-600 hover:border-amber-400 transition-colors min-h-[200px]"
          >
            <Plus size={32} />
            <span className="font-bold">{t('jobs.addOffer')}</span>
          </button>
        )}
      </div>

      {/* Results */}
      <div className="space-y-4">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <Trophy size={24} className="text-amber-500" />
          {t('jobs.ranking')}
        </h2>

        {results.map((r, idx) => {
          const isBest = idx === 0;
          return (
            <div
              key={r.offer.id}
              className={`bg-white dark:bg-slate-800 rounded-2xl border-2 p-4 sm:p-6 transition-[color,background-color,border-color,box-shadow] ${
                isBest ? 'border-emerald-500 ring-2 ring-emerald-500/20 shadow-lg' : 'border-slate-200 dark:border-slate-700'
              }`}
            >
              {isBest && (
                <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 text-white text-xs font-bold rounded-full">
                  <Trophy size={14} />
                  {t('jobs.bestChoice')}
                </div>
              )}

              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{r.offer.companyName || `${t('jobs.offer')} ${idx + 1}`}</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">RAL CHF {r.offer.grossSalaryCHF.toLocaleString('it-IT')} • {r.offer.distanceKm} km • {r.offer.travelTimeMin} min</p>
                </div>
                <div className="text-right">
                  <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('jobs.effectiveNet')}</div>
                  <div className={`text-3xl font-bold ${isBest ? 'text-emerald-700' : 'text-slate-800 dark:text-slate-100'}`}>
                    € {Math.round(r.effectiveNetMonthly).toLocaleString('it-IT')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">/mese</div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mb-1">
                    <DollarSign size={12} />
                    {t('jobs.netTaxes')}
                  </div>
                  <div className="font-bold text-slate-800 dark:text-slate-100">€ {Math.round(r.netMonthlyIT).toLocaleString('it-IT')}</div>
                </div>
                <div className="p-3 bg-red-50 dark:bg-red-950/30 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-red-600 mb-1">
                    <Car size={12} />
                    {t('jobs.transport')}
                  </div>
                  <div className="font-bold text-red-600">-€ {Math.round(r.transportCostMonthly).toLocaleString('it-IT')}</div>
                </div>
                <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-amber-700 mb-1">
                    <Clock size={12} />
                    {t('jobs.timeValue')}
                  </div>
                  <div className="font-bold text-amber-700">-€ {Math.round(r.timeCostMonthly).toLocaleString('it-IT')}</div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-emerald-700 mb-1">
                    <Coffee size={12} />
                    {t('jobs.benefits')}
                  </div>
                  <div className="font-bold text-emerald-700">+€ {Math.round(r.totalBenefits).toLocaleString('it-IT')}</div>
                </div>
              </div>

              {!isBest && bestResult && (
                <div className="mt-3 p-3 bg-orange-50 dark:bg-orange-950/30 rounded-xl text-sm">
                  <span className="text-orange-600 font-bold">
                    {t('jobs.difference')}: -€ {Math.round(bestResult.effectiveNetMonthly - r.effectiveNetMonthly).toLocaleString('it-IT')}/{t('common.monthly').toLowerCase()}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400 ml-2">
                    (-€ {Math.round((bestResult.effectiveNetMonthly - r.effectiveNetMonthly) * 12).toLocaleString('it-IT')}/{t('common.annual').toLowerCase()})
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Info */}
      <div className="bg-blue-50 dark:bg-blue-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-5">
        <div className="flex items-start gap-3">
          <Info size={20} className="text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-slate-700 dark:text-slate-300">
            <p className="font-bold mb-1">{t('jobs.howItWorks')}</p>
            <ul className="space-y-1 text-xs list-disc ml-4">
              <li>{t('jobs.howItWorks1')}</li>
              <li>{t('jobs.howItWorks2')}</li>
              <li>{t('jobs.howItWorks3')}</li>
              <li>{t('jobs.howItWorks4')}</li>
            </ul>
          </div>
        </div>
      </div>
      <Suspense fallback={null}><RelatedTools context="salary" /></Suspense>
    </div>
  );
};

export default JobComparator;
