import React, { useState, useMemo, lazy, Suspense } from 'react';
import { Car, Train, Bike, TrendingDown, TrendingUp, AlertCircle, Calculator, Euro, Fuel, Clock, Zap } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import PartnerRecommendations from '@/components/shared/PartnerRecommendations';

interface TransportOption {
 type: 'car-benzina' | 'car-diesel' | 'car-electric' | 'train' | 'ebike';
 name: string;
 icon: React.JSX.Element;
 color: string;
}

const transportOptions: TransportOption[] = [
 { type: 'car-benzina', name: 'Auto Benzina', icon: <Car size={20} />, color: 'bg-red-600' },
 { type: 'car-diesel', name: 'Auto Diesel', icon: <Car size={20} />, color: 'bg-slate-600' },
 { type: 'car-electric', name: 'Auto Elettrica', icon: <Zap size={20} />, color: 'bg-emerald-600' },
 { type: 'train', name: 'Treno', icon: <Train size={20} />, color: 'bg-stripe-600' },
 { type: 'ebike', name: 'eBike', icon: <Bike size={20} />, color: 'bg-rose-600' }
];

const TransportCalculator: React.FC = () => {
 const { t } = useTranslation();
 const [kmOneWay, setKmOneWay] = useState<number>(30);
 const [workDaysPerMonth, setWorkDaysPerMonth] = useState<number>(20);
 const [fuelPriceCH, setFuelPriceCH] = useState<number>(1.85); // CHF/litro benzina
 const [fuelPriceIT, setFuelPriceIT] = useState<number>(1.75); // EUR/litro benzina
 const [consumptionPer100km, setConsumptionPer100km] = useState<number>(6.5);
 const [tollsCost, setTollsCost] = useState<number>(0);
 const [parkingCost, setParkingCost] = useState<number>(0);
 const [selectedTransport, setSelectedTransport] = useState<string>('car-benzina');

 // Costi fissi annuali auto
 const carInsuranceIT = 600; // EUR/anno
 const carInsuranceCH = 800; // CHF/anno
 const carMaintenance = 800; // EUR/anno
 const carTax = 200; // EUR/anno bollo
 const carDepreciation = 2000; // EUR/anno ammortamento

 // Prezzi elettricità
 const electricityPriceCH = 0.25; // CHF/kWh
 const electricityPriceIT = 0.35; // EUR/kWh
 const electricConsumptionPer100km = 18; // kWh/100km

 // Calcoli
 const kmPerDay = kmOneWay * 2;
 const kmPerMonth = kmPerDay * workDaysPerMonth;
 const kmPerYear = kmPerMonth * 12;

 const calculateCarCosts = (fuelType: 'benzina' | 'diesel' | 'electric', buyFuelIn: 'CH' | 'IT') => {
 let fuelCostPerMonth = 0;
 
 if (fuelType === 'electric') {
 const kWhPerMonth = (kmPerMonth / 100) * electricConsumptionPer100km;
 const pricePerKWh = buyFuelIn === 'CH' ? electricityPriceCH : electricityPriceIT;
 fuelCostPerMonth = kWhPerMonth * pricePerKWh;
 } else {
 const litersPerMonth = (kmPerMonth / 100) * consumptionPer100km;
 const pricePerLiter = buyFuelIn === 'CH' ? fuelPriceCH : (fuelType === 'diesel' ? fuelPriceIT * 0.95 : fuelPriceIT);
 fuelCostPerMonth = litersPerMonth * pricePerLiter;
 }

 const maintenancePerMonth = (carMaintenance / 12);
 const insurancePerMonth = buyFuelIn === 'CH' ? (carInsuranceCH / 12) : (carInsuranceIT / 12);
 const taxPerMonth = (carTax / 12);
 const depreciationPerMonth = (carDepreciation / 12);
 const wearCostPerMonth = (kmPerMonth * 0.05); // 5 cent/km usura gomme, freni, etc

 return {
 fuelCost: fuelCostPerMonth,
 maintenance: maintenancePerMonth,
 insurance: insurancePerMonth,
 tax: taxPerMonth,
 depreciation: depreciationPerMonth,
 wear: wearCostPerMonth,
 tolls: tollsCost,
 parking: parkingCost,
 total: fuelCostPerMonth + maintenancePerMonth + insurancePerMonth + taxPerMonth + depreciationPerMonth + wearCostPerMonth + tollsCost + parkingCost
 };
 };

 const trainCostPerMonth = kmPerMonth * 0.15; // ~15 cent/km tariffa media treno
 const ebikeCostPerMonth = 50; // Manutenzione + ricarica batteria
 const ebikePurchaseCost = 2500; // Costo eBike ammortizzato su 5 anni = 500/anno = 42/mese

 const results = useMemo(() => {
 const costsBenzinaIT = calculateCarCosts('benzina', 'IT');
 const costsBenzinaCH = calculateCarCosts('benzina', 'CH');
 const costsDieselIT = calculateCarCosts('diesel', 'IT');
 const costsElectricIT = calculateCarCosts('electric', 'IT');
 const costsElectricCH = calculateCarCosts('electric', 'CH');

 return [
 {
 name: 'Auto Benzina (rifornimento IT)',
 type: 'car-benzina',
 costPerMonth: costsBenzinaIT.total,
 costPerYear: costsBenzinaIT.total * 12,
 details: costsBenzinaIT,
 color: 'bg-red-600',
 icon: <Car size={24} />,
 fuelLocation: 'IT'
 },
 {
 name: 'Auto Benzina (rifornimento CH)',
 type: 'car-benzina',
 costPerMonth: costsBenzinaCH.total,
 costPerYear: costsBenzinaCH.total * 12,
 details: costsBenzinaCH,
 color: 'bg-red-600',
 icon: <Car size={24} />,
 fuelLocation: 'CH'
 },
 {
 name: 'Auto Diesel (rifornimento IT)',
 type: 'car-diesel',
 costPerMonth: costsDieselIT.total,
 costPerYear: costsDieselIT.total * 12,
 details: costsDieselIT,
 color: 'bg-slate-600',
 icon: <Car size={24} />,
 fuelLocation: 'IT'
 },
 {
 name: 'Auto Elettrica (ricarica casa IT)',
 type: 'car-electric',
 costPerMonth: costsElectricIT.total,
 costPerYear: costsElectricIT.total * 12,
 details: costsElectricIT,
 color: 'bg-emerald-600',
 icon: <Zap size={24} />,
 fuelLocation: 'IT'
 },
 {
 name: 'Auto Elettrica (ricarica CH)',
 type: 'car-electric',
 costPerMonth: costsElectricCH.total,
 costPerYear: costsElectricCH.total * 12,
 details: costsElectricCH,
 color: 'bg-emerald-600',
 icon: <Zap size={24} />,
 fuelLocation: 'CH'
 },
 {
 name: 'Treno',
 type: 'train',
 costPerMonth: trainCostPerMonth,
 costPerYear: trainCostPerMonth * 12,
 details: null,
 color: 'bg-stripe-600',
 icon: <Train size={24} />,
 fuelLocation: null
 },
 {
 name: 'eBike + Treno (giorni pioggia)',
 type: 'ebike',
 costPerMonth: ebikeCostPerMonth + ebikePurchaseCost,
 costPerYear: (ebikeCostPerMonth + ebikePurchaseCost) * 12,
 details: null,
 color: 'bg-rose-600',
 icon: <Bike size={24} />,
 fuelLocation: null
 }
 ].sort((a, b) => a.costPerMonth - b.costPerMonth);
 }, [kmOneWay, workDaysPerMonth, fuelPriceIT, fuelPriceCH, consumptionPer100km, tollsCost, parkingCost]);

 const cheapest = results[0];
 const mostExpensive = results[results.length - 1];
 const savings = mostExpensive.costPerMonth - cheapest.costPerMonth;

 return (
 <div className="space-y-6 pb-8">
 {/* Experimental Warning Banner */}
 <div className="bg-warning-subtle border-2 border-warning-border rounded-xl p-4">
 <div className="flex items-start gap-3">
 <AlertCircle className="text-warning flex-shrink-0 mt-0.5" size={22} />
 <div>
 <p className="font-bold text-warning mb-1">
 ⚠️ {t('transport.experimental')}
 </p>
 <p className="text-sm text-warning">
 {t('transport.experimentalDesc')}
 </p>
 </div>
 </div>
 </div>

 {/* Header */}
 <div className="bg-success rounded-2xl p-5 sm:p-8 text-white">
 <div className="flex items-center gap-3 mb-4">
 <Car size={32} />
 <h2 className="text-2xl sm:text-3xl font-bold">{t('transport.title')}</h2>
 </div>
 <p className="text-emerald-100 text-lg">
 {t('transport.subtitle')}
 </p>
 </div>

 {/* Input Section */}
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
 <h3 className="text-xl font-bold text-strong mb-4 flex items-center gap-2">
 <Calculator size={20} />
 {t('transport.travelData')}
 </h3>

 <div className="grid md:grid-cols-2 gap-6">
 <div>
 <label htmlFor="tc-km" className="block text-sm font-bold text-body mb-2">
 {t('transport.distanceOneWay')}
 </label>
 <div className="flex items-center gap-2">
 <input
 id="tc-km"
 type="number"
 inputMode="numeric"
 value={kmOneWay}
 onChange={(e) => { setKmOneWay(Number(e.target.value)); Analytics.trackTransportCalculator('change_param', 'km', Number(e.target.value)); }}
 className="flex-1 px-4 py-2 rounded-lg border border-edge bg-surface-alt text-strong"
 />
 <span className="text-sm font-bold text-subtle">km</span>
 </div>
 <p className="text-sm text-muted mt-1">
 {t('transport.roundTrip')}: {kmPerDay} km/{t('transport.day')}
 </p>
 </div>

 <div>
 <label htmlFor="tc-days" className="block text-sm font-bold text-body mb-2">
 {t('transport.workDaysPerMonth')}
 </label>
 <div className="flex items-center gap-2">
 <input
 id="tc-days"
 type="number"
 inputMode="numeric"
 value={workDaysPerMonth}
 onChange={(e) => { setWorkDaysPerMonth(Number(e.target.value)); Analytics.trackTransportCalculator('change_param', 'workDays', Number(e.target.value)); }}
 className="flex-1 px-4 py-2 rounded-lg border border-edge bg-surface-alt text-strong"
 />
 <span className="text-sm font-bold text-subtle">{t('transport.days')}</span>
 </div>
 <p className="text-sm text-muted mt-1">
 {t('transport.total')}: {kmPerMonth.toLocaleString()} km/{t('transport.month')}, {kmPerYear.toLocaleString()} km/{t('transport.year')}
 </p>
 </div>

 <div>
 <label htmlFor="tc-consumption" className="block text-sm font-bold text-body mb-2">
 {t('transport.fuelConsumption')}
 </label>
 <input
 id="tc-consumption"
 type="number"
 inputMode="decimal"
 step="0.1"
 value={consumptionPer100km}
 onChange={(e) => setConsumptionPer100km(Number(e.target.value))}
 className="w-full px-4 py-2 rounded-lg border border-edge bg-surface-alt text-strong"
 />
 </div>

 <div>
 <label htmlFor="tc-tolls" className="block text-sm font-bold text-body mb-2">
 {t('transport.tollsMonthly')}
 </label>
 <div className="flex items-center gap-2">
 <input
 id="tc-tolls"
 type="number"
 inputMode="numeric"
 value={tollsCost}
 onChange={(e) => setTollsCost(Number(e.target.value))}
 className="flex-1 px-4 py-2 rounded-lg border border-edge bg-surface-alt text-strong"
 />
 <span className="text-sm font-bold text-subtle">€</span>
 </div>
 </div>

 <div>
 <label htmlFor="tc-fuel-it" className="block text-sm font-bold text-body mb-2">
 {t('transport.fuelPriceIT')}
 </label>
 <input
 id="tc-fuel-it"
 type="number"
 inputMode="decimal"
 step="0.01"
 value={fuelPriceIT}
 onChange={(e) => setFuelPriceIT(Number(e.target.value))}
 className="w-full px-4 py-2 rounded-lg border border-edge bg-surface-alt text-strong"
 />
 </div>

 <div>
 <label htmlFor="tc-fuel-ch" className="block text-sm font-bold text-body mb-2">
 {t('transport.fuelPriceCH')}
 </label>
 <input
 id="tc-fuel-ch"
 type="number"
 inputMode="decimal"
 step="0.01"
 value={fuelPriceCH}
 onChange={(e) => setFuelPriceCH(Number(e.target.value))}
 className="w-full px-4 py-2 rounded-lg border border-edge bg-surface-alt text-strong"
 />
 </div>

 <div>
 <label htmlFor="tc-parking" className="block text-sm font-bold text-body mb-2">
 {t('transport.parkingMonthly')}
 </label>
 <div className="flex items-center gap-2">
 <input
 id="tc-parking"
 type="number"
 inputMode="numeric"
 value={parkingCost}
 onChange={(e) => setParkingCost(Number(e.target.value))}
 className="flex-1 px-4 py-2 rounded-lg border border-edge bg-surface-alt text-strong"
 />
 <span className="text-sm font-bold text-subtle">CHF</span>
 </div>
 </div>
 </div>
 </div>

 {/* Summary Cards */}
 <div className="grid md:grid-cols-2 gap-6">
 <div className="bg-gradient-to-br from-success-subtle to-success-subtle rounded-2xl border border-success-border p-6">
 <div className="flex items-center gap-3 mb-3">
 <div className="p-3 bg-emerald-700 rounded-xl text-white">
 <TrendingDown size={24} />
 </div>
 <div>
 <p className="text-sm font-bold text-success">{t('transport.cheapestOption')}</p>
 <h3 className="text-2xl font-bold text-strong">{cheapest.name}</h3>
 </div>
 </div>
 <div className="text-2xl sm:text-3xl font-bold text-emerald-700 mb-2">
 € {cheapest.costPerMonth.toFixed(2)}/mese
 </div>
 <p className="text-sm text-subtle">
 {cheapest.costPerYear.toFixed(2)} €/anno
 </p>
 </div>

 <div className="bg-gradient-to-br from-danger-subtle to-warning-subtle rounded-2xl border border-danger-border p-6">
 <div className="flex items-center gap-3 mb-3">
 <div className="p-3 bg-red-500 rounded-xl text-white">
 <TrendingUp size={24} />
 </div>
 <div>
 <p className="text-sm font-bold text-danger">{t('transport.mostExpensive')}</p>
 <h3 className="text-2xl font-bold text-strong">{mostExpensive.name}</h3>
 </div>
 </div>
 <div className="text-2xl sm:text-3xl font-bold text-red-600 mb-2">
 € {mostExpensive.costPerMonth.toFixed(2)}/mese
 </div>
 <p className="text-sm text-subtle">
 {t('transport.youSave')} <strong className="text-emerald-700">{savings.toFixed(2)} €/{t('transport.month')}</strong> {t('transport.with')} {cheapest.name}
 </p>
 </div>
 </div>

 {/* Results Grid */}
 <div className="grid md:grid-cols-2 gap-6">
 {results.map((result) => (
 <div
 key={result.name}
 className={`bg-surface rounded-2xl border-2 p-4 sm:p-6 hover:shadow-lg transition-[color,background-color,border-color,box-shadow] ${
 result.name === cheapest.name 
 ? 'border-emerald-500 ring-2 ring-emerald-500/20' 
 : 'border-edge'
 }`}
 >
 {result.name === cheapest.name && (
 <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 text-white text-xs font-bold rounded-full">
 ✓ {t('transport.cheapest')}
 </div>
 )}

 <div className="flex items-start justify-between gap-4 mb-4">
 <div className="flex items-center gap-3">
 <div className={`text-white p-3 ${result.color} rounded-2xl`}>
 {result.icon}
 </div>
 <div>
 <h3 className="text-lg font-bold text-strong">{result.name}</h3>
 <p className="text-sm text-muted">
 {result.type.includes('car') ? `${kmPerYear.toLocaleString()} km/${t('transport.year')}` : t('transport.publicTransport')}
 </p>
 </div>
 </div>

 <div className="text-right">
 <div className="text-2xl font-bold text-strong">
 € {result.costPerMonth.toFixed(2)}
 </div>
 <div className="text-sm text-muted">{t('transport.perMonth')}</div>
 </div>
 </div>

 {result.details && (
 <div className="space-y-2 mt-4 pt-4 border-t border-edge">
 <div className="flex justify-between text-sm">
 <span className="text-subtle">{t('transport.fuelEnergy')}</span>
 <span className="font-bold text-strong">€ {result.details.fuelCost.toFixed(2)}</span>
 </div>
 <div className="flex justify-between text-sm">
 <span className="text-subtle">{t('transport.insurance')}</span>
 <span className="font-bold text-strong">€ {result.details.insurance.toFixed(2)}</span>
 </div>
 <div className="flex justify-between text-sm">
 <span className="text-subtle">{t('transport.maintenance')}</span>
 <span className="font-bold text-strong">€ {result.details.maintenance.toFixed(2)}</span>
 </div>
 <div className="flex justify-between text-sm">
 <span className="text-subtle">{t('transport.wear')}</span>
 <span className="font-bold text-strong">€ {result.details.wear.toFixed(2)}</span>
 </div>
 <div className="flex justify-between text-sm">
 <span className="text-subtle">{t('transport.depreciation')}</span>
 <span className="font-bold text-strong">€ {result.details.depreciation.toFixed(2)}</span>
 </div>
 {result.details.tolls > 0 && (
 <div className="flex justify-between text-sm">
 <span className="text-subtle">{t('transport.tolls')}</span>
 <span className="font-bold text-strong">€ {result.details.tolls.toFixed(2)}</span>
 </div>
 )}
 {result.details.parking > 0 && (
 <div className="flex justify-between text-sm">
 <span className="text-subtle">{t('transport.parking')}</span>
 <span className="font-bold text-strong">CHF {result.details.parking.toFixed(2)}</span>
 </div>
 )}
 </div>
 )}

 {result.type === 'train' && (
 <div className="mt-4 p-3 bg-accent-subtle rounded-lg">
 <p className="text-xs text-accent">
 💡 {t('transport.trainTip')}
 </p>
 </div>
 )}

 {result.type === 'ebike' && (
 <div className="mt-4 p-3 bg-neutral-subtle rounded-lg border border-neutral-border">
 <p className="text-xs text-neutral">
 💡 {t('transport.ebikeTip')}
 </p>
 </div>
 )}
 </div>
 ))}
 </div>

 {/* Tips Section */}
 <div className="bg-gradient-to-br from-warning-subtle to-warning-subtle rounded-2xl border border-warning-border p-6">
 <h3 className="text-xl font-bold text-strong mb-4 flex items-center gap-2">
 <AlertCircle size={20} className="text-amber-700" />
 {t('transport.savingTips')}
 </h3>
 
 <div className="grid md:grid-cols-2 gap-4">
 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-warning mb-2">⛽ {t('transport.whereToFuel')}</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>{t('transport.fuelTip1')}</li>
 <li>{t('transport.fuelTip2')}</li>
 <li>{t('transport.fuelTip3')}</li>
 </ul>
 </div>

 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-warning mb-2">🚗 {t('transport.electricWorth')}</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>{t('transport.electricTip1')}</li>
 <li>{t('transport.electricTip2')}</li>
 <li>{t('transport.electricTip3')}</li>
 </ul>
 </div>

 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-warning mb-2">🚆 {t('transport.trainAlternative')}</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>{t('transport.trainAltTip1')}</li>
 <li>{t('transport.trainAltTip2')}</li>
 <li>{t('transport.trainAltTip3')}</li>
 </ul>
 </div>

 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-warning mb-2">💰 {t('transport.taxDeductions')}</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>{t('transport.taxTip1')}</li>
 <li>{t('transport.taxTip2')}</li>
 <li>{t('transport.taxTip3')}</li>
 </ul>
 </div>
 </div>
 </div>

 <Suspense fallback={null}><RelatedTools context="guide" /></Suspense>

 <PartnerRecommendations context="transport" />
 </div>
 );
};

export default TransportCalculator;
