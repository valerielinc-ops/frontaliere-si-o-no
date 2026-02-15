import React, { useState, useMemo } from 'react';
import { Briefcase, Plus, Trash2, Trophy, Car, Clock, DollarSign, TrendingUp, Home, Coffee, ParkingCircle, Info, Calculator, MapPin } from 'lucide-react';
import { calculateSimulation } from '@/services/calculationService';
import { Analytics } from '@/services/analytics';
import { DEFAULT_INPUTS, DEFAULT_EXCHANGE_RATE } from '@/constants';
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
  grossSalaryCHF: 80000,
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

const JobComparator: React.FC = () => {
  const { t } = useTranslation();
  const [offers, setOffers] = useState<JobOffer[]>([
    { ...defaultOffer(), companyName: '', grossSalaryCHF: 85000, country: 'CH' },
    { ...defaultOffer(), companyName: '', grossSalaryCHF: 95000, distanceKm: 50, travelTimeMin: 60, country: 'CH' },
  ]);

  const addOffer = () => {
    if (offers.length >= 4) return;
    setOffers([...offers, { ...defaultOffer(), companyName: `${t('jobs.offer')} ${offers.length + 1}` }]);
    Analytics.trackUIInteraction('comparatori', 'offerte_lavoro', 'bottone_aggiungi', 'click', String(offers.length + 1));
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
        : offer.otherBenefitsCHF / 12 / DEFAULT_EXCHANGE_RATE;

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

  const offerColors = ['indigo', 'emerald', 'amber', 'rose'];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-indigo-600 via-blue-600 to-cyan-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <Briefcase size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">{t('jobs.title')}</h1>
            <p className="text-indigo-100 mt-1">{t('jobs.subtitle')}</p>
          </div>
        </div>
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
                className="text-lg font-bold text-slate-800 dark:text-slate-100 bg-transparent border-none outline-none w-full"
                placeholder={t('jobs.companyName')}
              />
              {offers.length > 2 && (
                <button onClick={() => removeOffer(offer.id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors">
                  <Trash2 size={16} />
                </button>
              )}
            </div>

            <div className="space-y-3">
              {/* Country selector */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1">
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
                <label className="text-xs font-bold text-slate-500 uppercase">
                  {offer.country === 'CH' ? t('jobs.grossSalary') : t('jobs.grossSalaryIT')}
                </label>
                <input type="number" value={offer.grossSalaryCHF} onChange={(e) => updateOffer(offer.id, 'grossSalaryCHF', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  min={0} step={1000} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase">{t('jobs.distance')}</label>
                  <input type="number" value={offer.distanceKm} onChange={(e) => updateOffer(offer.id, 'distanceKm', Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    min={0} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase">{t('jobs.travelTime')}</label>
                  <input type="number" value={offer.travelTimeMin} onChange={(e) => updateOffer(offer.id, 'travelTimeMin', Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    min={0} />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">{t('jobs.homeOffice')}</label>
                <input type="range" min={0} max={5} value={offer.homeOfficeDays} onChange={(e) => updateOffer(offer.id, 'homeOfficeDays', Number(e.target.value))}
                  className="w-full accent-indigo-600" />
                <div className="text-center text-sm font-bold text-slate-700 dark:text-slate-300">{offer.homeOfficeDays} {t('jobs.days')}</div>
              </div>

              {offer.country === 'IT' && (
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={offer.hasMealVouchers} onChange={(e) => updateOffer(offer.id, 'hasMealVouchers', e.target.checked)}
                    className="w-4 h-4 text-indigo-600 rounded" />
                  <label className="text-xs font-bold text-slate-600 dark:text-slate-500">{t('jobs.mealVouchers')} (€{offer.mealVoucherValue}/{t('common.day') || 'gg'})</label>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input type="checkbox" checked={offer.hasParking} onChange={(e) => updateOffer(offer.id, 'hasParking', e.target.checked)}
                  className="w-4 h-4 text-indigo-600 rounded" />
                <label className="text-xs font-bold text-slate-600 dark:text-slate-500">{t('jobs.parking')}</label>
              </div>
            </div>
          </div>
        ))}

        {offers.length < 4 && (
          <button
            onClick={addOffer}
            className="rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-600 p-6 flex flex-col items-center justify-center gap-3 text-slate-500 hover:text-indigo-600 hover:border-indigo-400 transition-all min-h-[200px]"
          >
            <Plus size={32} />
            <span className="font-bold">{t('jobs.addOffer')}</span>
          </button>
        )}
      </div>

      {/* Results */}
      <div className="space-y-4">
        <h2 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <Trophy size={24} className="text-amber-500" />
          {t('jobs.ranking')}
        </h2>

        {results.map((r, idx) => {
          const isBest = idx === 0;
          return (
            <div
              key={r.offer.id}
              className={`bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 transition-all ${
                isBest ? 'border-emerald-500 ring-2 ring-emerald-500/20 shadow-lg' : 'border-slate-200 dark:border-slate-700'
              }`}
            >
              {isBest && (
                <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-xs font-bold rounded-full">
                  <Trophy size={14} />
                  {t('jobs.bestChoice')}
                </div>
              )}

              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{r.offer.companyName || `${t('jobs.offer')} ${idx + 1}`}</h3>
                  <p className="text-sm text-slate-500">RAL CHF {r.offer.grossSalaryCHF.toLocaleString('it-IT')} • {r.offer.distanceKm} km • {r.offer.travelTimeMin} min</p>
                </div>
                <div className="text-right">
                  <div className="text-xs font-bold text-slate-500 uppercase">{t('jobs.effectiveNet')}</div>
                  <div className={`text-3xl font-extrabold ${isBest ? 'text-emerald-600' : 'text-slate-800 dark:text-slate-100'}`}>
                    € {Math.round(r.effectiveNetMonthly).toLocaleString('it-IT')}
                  </div>
                  <div className="text-xs text-slate-500">/mese</div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
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
                  <div className="flex items-center gap-1.5 text-xs text-amber-600 mb-1">
                    <Clock size={12} />
                    {t('jobs.timeValue')}
                  </div>
                  <div className="font-bold text-amber-600">-€ {Math.round(r.timeCostMonthly).toLocaleString('it-IT')}</div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600 mb-1">
                    <Coffee size={12} />
                    {t('jobs.benefits')}
                  </div>
                  <div className="font-bold text-emerald-600">+€ {Math.round(r.totalBenefits).toLocaleString('it-IT')}</div>
                </div>
              </div>

              {!isBest && bestResult && (
                <div className="mt-3 p-3 bg-orange-50 dark:bg-orange-950/30 rounded-xl text-sm">
                  <span className="text-orange-600 font-bold">
                    {t('jobs.difference')}: -€ {Math.round(bestResult.effectiveNetMonthly - r.effectiveNetMonthly).toLocaleString('it-IT')}/{t('common.monthly').toLowerCase()}
                  </span>
                  <span className="text-slate-500 ml-2">
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
    </div>
  );
};

export default JobComparator;
