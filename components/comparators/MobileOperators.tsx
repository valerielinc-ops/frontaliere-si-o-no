import React, { useState, useMemo, Suspense } from 'react';
import { Smartphone, Wifi, Phone, MessageSquare, AlertCircle, CheckCircle2, Info, Euro, Globe } from 'lucide-react';
import Callout from '@/components/shared/Callout';
import ProviderLogo from '@/components/shared/ProviderLogo';
import { lazyRetry } from '@/services/lazyRetry';

const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import PartnerRecommendations from '@/components/shared/PartnerRecommendations';
import DataFreshness from '@/components/shared/DataFreshness';

interface MobileOperator {
 name: string;
 slug: string;
 country: 'IT' | 'CH';
 monthlyCost: number;
 dataGB: number | string; // number or"illimitati"
 minutes: number | string;
 sms: number | string;
 roamingInSwitzerland?: {
 included: boolean;
 costPerDay?: number;
 monthlyFee?: number;
 costPerMB?: number;
 costPerMinute?: number;
 dataLimit?: number | string;
 notes: string;
 };
 roamingInItaly?: {
 included: boolean;
 costPerDay?: number;
 monthlyFee?: number;
 costPerMB?: number;
 costPerMinute?: number;
 dataLimit?: number | string;
 notes: string;
 };
 color: string;
 features: string[];
 setupCost: number;
 contractType: 'prepagato' | 'abbonamento';
 website?: string;
}

const operators: MobileOperator[] = [
 // Italian Operators
 {
 name: 'Iliad',
 slug: 'iliad',
 country: 'IT',
 monthlyCost: 9.99,
 dataGB: 250,
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInSwitzerland: {
 included: false,
 monthlyFee: 4.99,
 dataLimit: 5,
 notes: 'Opzione "5 GB in Svizzera" 4.99€/mese per 5 GB dati. Attivabile una volta al mese, si disattiva dopo 30 gg. Senza opzione: tariffe Extra UE.'
 },
 setupCost: 9.99,
 contractType: 'prepagato',
 color: 'from-danger-strong to-warning-strong',
 features: ['Top 250 Plus — 250 GB + 5G', 'Opzione CH 4.99€ per 5 GB', 'Prezzo per sempre'],
 website: 'https://www.iliad.it/offerte-iliad-mobile.html'
 },
 {
 name: 'ho. Mobile',
 slug: 'ho-mobile',
 country: 'IT',
 monthlyCost: 6.95,
 dataGB: 150,
 minutes: 'illimitati',
 sms: 200,
 roamingInSwitzerland: {
 included: true,
 dataLimit: 11.4,
 notes: 'Roaming CH gratuito come UE dall\'8 settembre 2025 (Roam Like At Home esteso). FUP roaming UE/CH 11.4 GB per la fascia 6.95€ (calcolata sul prezzo del piano).'
 },
 setupCost: 2.99,
 contractType: 'prepagato',
 color: 'from-success-strong to-success-strong',
 features: ['Roam Like Home CH dal 09/2025', 'Rete Vodafone', '5G incluso', 'Da 6.95€ per sempre'],
 website: 'https://www.ho-mobile.it/tutte-le-offerte.html'
 },
 {
 name: 'Vodafone',
 slug: 'vodafone-it',
 country: 'IT',
 monthlyCost: 9.95,
 dataGB: 150,
 minutes: 'illimitati',
 sms: 200,
 roamingInSwitzerland: {
 included: true,
 dataLimit: 32,
 notes: 'Roaming CH come Italia dal 5 settembre 2025 per clienti offerte Privati. Vodafone Start: 32 GB UE+UK+Svizzera inclusi.'
 },
 setupCost: 10,
 contractType: 'prepagato',
 color: 'from-danger-strong to-danger-strong-hover',
 features: ['32 GB roaming CH inclusi', 'Roam Like Home CH dal 09/2025', '5G disponibile'],
 website: 'https://www.vodafone.it/offerte/mobile'
 },
 {
 name: 'TIM Mobile Digital',
 slug: 'tim',
 country: 'IT',
 monthlyCost: 9.99,
 dataGB: 150,
 minutes: 'illimitati',
 sms: 200,
 roamingInSwitzerland: {
 included: false,
 monthlyFee: 5,
 dataLimit: 5,
 notes: 'TIM Opzione Svizzera 5€/mese: 5 GB + 500 min (250 chiamate CH/IT, 250 in ricezione). Attivazione gratis, promo entro 28/06/2026. Solo prepagati TIM.'
 },
 setupCost: 10,
 contractType: 'prepagato',
 color: 'from-accent-strong to-accent-strong-hover',
 features: ['150 GB in 5G ULTRA', 'Opzione CH 5€ per 5 GB + 500 min', 'Copertura eccellente'],
 website: 'https://www.tim.it/offerte/mobile'
 },
 {
 name: 'WindTre',
 slug: 'windtre',
 country: 'IT',
 monthlyCost: 14.99,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 200,
 roamingInSwitzerland: {
 included: false,
 monthlyFee: 19.99,
 dataLimit: 15,
 notes: 'Travel Pass Svizzera Monthly 19.99€/30 gg: 15 GB + 200 min + 100 SMS. Attivazione 2.99€. Alternativa Weekly 9.99€/7 gg.'
 },
 setupCost: 0,
 contractType: 'abbonamento',
 color: 'from-warning-strong to-warning-strong-hover',
 features: ['Giga illimitati in Italia', 'Travel Pass CH 19.99€/15 GB', 'Buona copertura'],
 website: 'https://www.windtre.it/offerte-all-estero/travel-pass-svizzera'
 },
 {
 name: 'Very Mobile',
 slug: 'very-mobile',
 country: 'IT',
 monthlyCost: 6.99,
 dataGB: 200,
 minutes: 'illimitati',
 sms: 200,
 roamingInSwitzerland: {
 included: false,
 costPerMB: 4.88,
 costPerMinute: 0.49,
 notes: 'Roaming CH non in Roam-Like-Home, ma opzione "Giga Svizzera" 10 GB a 4.99€/settimana (attivazione gratis, si rinnova solo se usata). Senza opzione: tariffe Extra UE 0.49€/min, 0.16€/SMS, 4.88€/MB.'
 },
 setupCost: 0,
 contractType: 'prepagato',
 color: 'from-danger-strong to-danger-strong-hover',
 features: ['200 GB + 5G Full Speed', 'SIM e spedizione gratis', 'Rete WindTre', 'Opzione Giga Svizzera 10 GB 4.99€/sett'],
 website: 'https://www.verymobile.it/offerte'
 },
 {
 name: 'Fastweb Mobile',
 slug: 'fastweb-mobile',
 country: 'IT',
 monthlyCost: 9.95,
 dataGB: 150,
 minutes: 'illimitati',
 sms: 200,
 roamingInSwitzerland: {
 included: true,
 dataLimit: 32,
 notes: 'Fastweb Mobile Start: 32 GB roaming UE+UK+Svizzera (17 GB normativi + 15 GB extra). Min illim, 200 SMS in fair use.'
 },
 setupCost: 10,
 contractType: 'prepagato',
 color: 'from-warning-strong to-warning-strong-hover',
 features: ['32 GB roaming CH inclusi', 'Rete WindTre', 'Ottimo rapporto qualità/prezzo'],
 website: 'https://www.fastweb.it/adsl-fibra-ottica/fastweb-mobile-start/'
 },
 {
 name: 'Spusu Oltreconfine',
 slug: 'spusu-oltreconfine',
 country: 'IT',
 monthlyCost: 9.98,
 dataGB: 150,
 minutes: 2000,
 sms: 500,
 roamingInSwitzerland: {
 included: true,
 dataLimit: 10,
 notes: '10 GB inclusi in Svizzera + 2000 min verso numeri CH/IT/UE/UK. Bonus 2026: 14,87 GB UE roaming. Rete WindTre.'
 },
 setupCost: 0,
 contractType: 'prepagato',
 color: 'from-info-strong to-warning-strong',
 features: ['10 GB CH + 2000 min CH', 'Pensato per chi viaggia in CH', 'Rete WindTre IT (4G+)'],
 website: 'https://www.spusu.it/spusuoltreconfine'
 },

 // Swiss Operators
 {
 name: 'Swisscom blue M',
 slug: 'swisscom',
 country: 'CH',
 monthlyCost: 81.80,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 40,
 notes: '40 GB UE/UK a velocità max, poi throttle a 128 kbit/s. Min/SMS illim. Promo 12 mesi a 59.90 CHF.'
 },
 setupCost: 0,
 contractType: 'abbonamento',
 color: 'from-accent-strong-hover to-accent-strong-hover',
 features: ['Rete migliore CH', '40 GB UE alta velocità', 'Premium'],
 website: 'https://www.swisscom.ch/en/residential/mobile-subscription/blue-mobile-m.html'
 },
 {
 name: 'Salt Travel',
 slug: 'salt-travel',
 country: 'CH',
 monthlyCost: 29.95,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 20,
 notes: 'Dati illimitati UE/USA/CAN (20 GB high-speed) + 100 min in roaming. Sconto -68% a vita online.'
 },
 setupCost: 0,
 contractType: 'abbonamento',
 color: 'from-warning-strong to-warning-strong-hover',
 features: ['Dati illimitati CH+UE', '20 GB high-speed roaming', 'Sconto -68% a vita'],
 website: 'https://www.salt.ch/en/mobile/plans/travel'
 },
 {
 name: 'Salt Swiss Max',
 slug: 'salt-swiss-max',
 country: 'CH',
 monthlyCost: 22.95,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 1,
 notes: 'Solo 1 GB roaming UE incluso. Sconto -68% a vita online. Per chi usa poco il roaming.'
 },
 setupCost: 0,
 contractType: 'abbonamento',
 color: 'from-warning-strong to-warning-strong',
 features: ['Dati illimitati CH', 'Solo 1 GB roaming UE', 'Sconto -68% a vita'],
 website: 'https://www.salt.ch/en/mobile/plans/swiss-max'
 },
 {
 name: 'Sunrise Swiss Travel+',
 slug: 'sunrise',
 country: 'CH',
 monthlyCost: 39.90,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 'illimitati',
 notes: 'Dati/min illimitati in 8 paesi UE — Italia inclusa (DE/AT/FR/IT/LI/GR/ES/PT). + 3 GB extra nel resto di Europa/USA/CAN. Esente da rincaro 08/2026.'
 },
 setupCost: 0,
 contractType: 'abbonamento',
 color: 'from-warning-strong to-danger-strong-hover',
 features: ['Illim 8 paesi UE (Italia inclusa)', '+ 3 GB extra USA/CAN', 'Min/SMS illim'],
 website: 'https://www.sunrise.ch/en/mobile/swiss-travel-product-page'
 },
 {
 name: 'Yallo Europe',
 slug: 'yallo',
 country: 'CH',
 monthlyCost: 29.90,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 'illimitati',
 notes: 'Dati illimitati UE/USA/CAN/Turchia + 60 min chiamate in roaming. Rete Sunrise 5G fino a 2 Gbit/s.'
 },
 setupCost: 59,
 contractType: 'prepagato',
 color: 'from-warning to-warning-strong',
 features: ['Roaming UE illimitato', 'Rete Sunrise 5G', '60 min chiamate roaming'],
 website: 'https://www.yallo.ch/en/mobile-products/yallo_europe'
 },
 {
 name: 'Wingo Europe Go',
 slug: 'wingo',
 country: 'CH',
 monthlyCost: 27.95,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 8,
 notes: '8 GB UE/UK + 100 min chiamate UE/UK. Dati e chiamate illimitati in CH.'
 },
 setupCost: 59,
 contractType: 'prepagato',
 color: 'from-info-strong to-accent-strong-hover',
 features: ['Rete Swisscom 5G', 'Illim CH + 8 GB UE', '100 min roaming UE'],
 website: 'https://www.wingo.ch/it/mobile/wingo-europe-go'
 },
 {
 name: 'Aldi Mobile CH Swiss Unlimited Extra',
 slug: 'aldi-mobile-ch',
 country: 'CH',
 monthlyCost: 29.90,
 dataGB: 'illimitati',
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 5,
 notes: 'Dati illimitati CH + 5 GB roaming UE/USA/CAN. Min/SMS illim in CH.'
 },
 setupCost: 1,
 contractType: 'prepagato',
 color: 'from-surface-muted to-surface-muted-hover',
 features: ['Rete Sunrise 5G', 'Illim CH + 5 GB UE', 'Attivazione 1 CHF'],
 website: 'https://www.aldi-mobile.ch'
 },
 {
 name: 'M-Budget Mobile Maxi + europePLUS',
 slug: 'm-budget-mobile',
 country: 'CH',
 monthlyCost: 39,
 dataGB: 4,
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 4,
 notes: 'europePLUS (+10 CHF/mese): chiamate/SMS illim UE come a casa, 4 GB UE rigenerati. Base Maxi 29 CHF + europePLUS 10 CHF.'
 },
 setupCost: 0,
 contractType: 'abbonamento',
 color: 'from-info-strong to-success-strong',
 features: ['Rete Swisscom', 'Roam-Like-Home UE con europePLUS', 'MVNO Migros'],
 website: 'https://shop.m-budget.migros.ch/it/abbonamenti-mobili'
 },
 {
 name: 'Digitec Connect',
 slug: 'digitec-connect',
 country: 'CH',
 monthlyCost: 25,
 dataGB: 3,
 minutes: 'illimitati',
 sms: 'illimitati',
 roamingInItaly: {
 included: true,
 dataLimit: 1,
 notes: '1 GB roaming UE/USA. Family+Friends di 5: data flat nazionale a 25 CHF/sub. Senza attivazione.'
 },
 setupCost: 0,
 contractType: 'abbonamento',
 color: 'from-success-strong to-accent-strong-hover',
 features: ['Rete Sunrise', 'No attivazione', 'Sconto Family+Friends'],
 website: 'https://www.digitecconnect.ch'
 }
];

const MobileOperators: React.FC = () => {
 const { t } = useTranslation();
 const [filterCountry, setFilterCountry] = useState<'all' | 'IT' | 'CH'>('all');
 const [sortBy, setSortBy] = useState<'price' | 'roaming' | 'priceRoaming'>('roaming');
 const WORKING_DAYS_PER_MONTH = 20; // Giorni lavorativi medi per frontalieri

 // Calcola il costo mensile reale per un frontaliere
 const calculateRealMonthlyCost = (operator: MobileOperator): number => {
 let totalCost = operator.monthlyCost;
 
 // Se è un operatore italiano e il roaming in CH non è incluso, aggiungi i costi extra
 if (operator.country === 'IT' && !operator.roamingInSwitzerland?.included) {
 // Costi giornalieri (es. pass giornalieri)
 if (operator.roamingInSwitzerland?.costPerDay) {
 totalCost += operator.roamingInSwitzerland.costPerDay * WORKING_DAYS_PER_MONTH;
 }
 // Costi mensili fissi (es. Iliad 5€/mese)
 if (operator.roamingInSwitzerland?.monthlyFee) {
 totalCost += operator.roamingInSwitzerland.monthlyFee;
 }
 }
 
 // Se è un operatore svizzero e il roaming in IT non è incluso, aggiungi i costi extra
 if (operator.country === 'CH' && !operator.roamingInItaly?.included) {
 // Costi giornalieri
 if (operator.roamingInItaly?.costPerDay) {
 totalCost += operator.roamingInItaly.costPerDay * WORKING_DAYS_PER_MONTH;
 }
 // Costi mensili fissi
 if (operator.roamingInItaly?.monthlyFee) {
 totalCost += operator.roamingInItaly.monthlyFee;
 }
 }
 
 return totalCost;
 };

 const filteredOperators = useMemo(() => operators
 .filter(op => filterCountry === 'all' || op.country === filterCountry)
 .sort((a, b) => {
 if (sortBy === 'price') {
 return calculateRealMonthlyCost(a) - calculateRealMonthlyCost(b);
 } else if (sortBy === 'priceRoaming') {
 // Sort by price, but penalize operators without roaming (+999)
 const aHasRoaming = a.country === 'IT' ? a.roamingInSwitzerland?.included : a.roamingInItaly?.included;
 const bHasRoaming = b.country === 'IT' ? b.roamingInSwitzerland?.included : b.roamingInItaly?.included;
 const aCost = calculateRealMonthlyCost(a) + (aHasRoaming ? 0 : 999);
 const bCost = calculateRealMonthlyCost(b) + (bHasRoaming ? 0 : 999);
 return aCost - bCost;
 } else {
 // Sort by roaming availability
 const aHasRoaming = a.country === 'IT' ? a.roamingInSwitzerland?.included : a.roamingInItaly?.included;
 const bHasRoaming = b.country === 'IT' ? b.roamingInSwitzerland?.included : b.roamingInItaly?.included;
 if (aHasRoaming && !bHasRoaming) return -1;
 if (!aHasRoaming && bHasRoaming) return 1;
 return calculateRealMonthlyCost(a) - calculateRealMonthlyCost(b);
 }
 }), [filterCountry, sortBy]);

 // Limite dati roaming rilevante per il frontaliere (IT→CH oppure CH→IT)
 const roamingDataLimit = (op: MobileOperator): number | string | undefined =>
 op.country === 'IT' ? op.roamingInSwitzerland?.dataLimit : op.roamingInItaly?.dataLimit;

 // Ranking "migliori opzioni": roaming illimitato prima (più economico in cima),
 // poi miglior rapporto GB roaming / prezzo. NON solo GB: così non promuove i piani
 // costosi (es. Swisscom 81.80 CHF) né i micro-roaming da 1 GB.
 const bestForFrontierWorkers = operators
 .filter(op =>
 (op.country === 'IT' && op.roamingInSwitzerland?.included) ||
 (op.country === 'CH' && op.roamingInItaly?.included)
 )
 .sort((a, b) => {
 const aLimit = roamingDataLimit(a);
 const bLimit = roamingDataLimit(b);
 const aUnlimited = aLimit === 'illimitati';
 const bUnlimited = bLimit === 'illimitati';
 if (aUnlimited !== bUnlimited) return aUnlimited ? -1 : 1;
 if (aUnlimited && bUnlimited) return a.monthlyCost - b.monthlyCost;
 const aGB = typeof aLimit === 'number' ? aLimit : 0;
 const bGB = typeof bLimit === 'number' ? bLimit : 0;
 return bGB / (b.monthlyCost || 1) - aGB / (a.monthlyCost || 1);
 });

 // Riga compatta e scansionabile per il riepilogo "Migliori opzioni"
 const renderBestRow = (op: MobileOperator, rank: number) => {
 const limit = roamingDataLimit(op);
 const currency = op.country === 'IT' ? '€' : 'CHF';
 const roamingLabel = limit === 'illimitati' ? t('mobile.roamingUnlimited') : `${limit} GB`;
 return (
 <li key={op.name} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
 <span className="flex items-baseline gap-2 min-w-0">
 <span className="text-success font-bold tabular-nums">{rank}.</span>
 <strong className="text-strong truncate">{op.name}</strong>
 </span>
 <span className="flex items-baseline gap-2 min-w-0 pl-6 sm:pl-0 sm:flex-shrink-0">
 <span className="text-body font-bold tabular-nums whitespace-nowrap">{op.monthlyCost} {currency}</span>
 <span className="px-2 py-0.5 rounded-full bg-success-strong text-on-accent text-xs font-medium truncate">{roamingLabel}</span>
 </span>
 </li>
 );
 };

 return (
 <div className="space-y-6 pb-8">
 {/* Header */}
 <div className="bg-warning-subtle/80 rounded-2xl p-5 sm:p-8 border border-warning-border">
 <div className="flex items-center gap-3 mb-4">
 <Smartphone size={32} className="text-warning" />
 <h2 className="text-2xl sm:text-3xl font-bold font-display text-heading">{t('mobile.title')}</h2>
 </div>
 <p className="text-muted text-lg">
 {t('mobile.subtitle')}
 </p>
 <div className="mt-3"><DataFreshness lastUpdated="2026-06" source="Operatori ufficiali" variant="badge" /></div>
 </div>

 {/* Warning Banner */}
 <Callout status="warning" icon={<AlertCircle size={20} />}>
 <div className="text-sm text-warning">
 <p className="font-bold mb-1">⚠️ {t('mobile.roamingWarningTitle')}</p>
 <p>{t('mobile.roamingWarningDesc')}</p>
 </div>
 </Callout>

 {/* Filters */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <div className="flex flex-wrap gap-4 items-center">
 <div className="flex items-center gap-2">
 <label className="text-sm font-bold text-body">{t('mobile.country')}:</label>
 <div className="flex gap-2">
 <button
 onClick={() => { setFilterCountry('all'); Analytics.trackMobileOperator('filter', undefined, 'all'); }}
 className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
 filterCountry === 'all' 
 ? 'bg-warning-strong-hover text-on-accent'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {t('mobile.all')}
 </button>
 <button
 onClick={() => { setFilterCountry('IT'); Analytics.trackMobileOperator('filter', undefined, 'IT'); }}
 className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
 filterCountry === 'IT' 
 ? 'bg-success-strong text-on-accent' 
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 🇮🇹 {t('mobile.italy')}
 </button>
 <button
 onClick={() => { setFilterCountry('CH'); Analytics.trackMobileOperator('filter', undefined, 'CH'); }}
 className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
 filterCountry === 'CH' 
 ? 'bg-danger-strong text-on-accent' 
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 🇨🇭 {t('mobile.switzerland')}
 </button>
 </div>
 </div>

 <div className="flex items-center gap-2">
 <label htmlFor="mo-sort-by" className="text-sm font-bold text-body">{t('mobile.sortBy')}:</label>
 <select
 id="mo-sort-by"
 value={sortBy}
 onChange={(e) => { setSortBy(e.target.value as 'price' | 'roaming' | 'priceRoaming'); Analytics.trackMobileOperator('sort'); }}
 className="px-4 py-2 rounded-lg text-sm font-bold bg-surface-raised text-body border border-edge cursor-pointer"
 >
 <option value="roaming">{t('mobile.roamingIncluded')}</option>
 <option value="price">{t('mobile.price')}</option>
 <option value="priceRoaming">{t('mobile.priceWithRoaming')}</option>
 </select>
 </div>
 </div>
 </div>

 {/* Best Options Summary */}
 <div className="bg-success-subtle rounded-2xl border border-success-border p-6">
 <h3 className="text-xl font-bold font-display text-strong mb-1 flex items-center gap-2">
 <CheckCircle2 size={20} className="text-success" />
 {t('mobile.bestOptions')}
 </h3>
 <p className="text-sm text-muted mb-4">{t('mobile.bestOptionsHint')}</p>
 <div className="grid md:grid-cols-2 gap-4">
 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-success mb-3">🇮🇹 {t('mobile.italianWithRoaming')}</p>
 <ul className="space-y-2.5 text-sm">
 {bestForFrontierWorkers.filter(op => op.country === 'IT').slice(0, 3).map((op, i) => renderBestRow(op, i + 1))}
 </ul>
 </div>
 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-success mb-3">🇨🇭 {t('mobile.swissWithRoaming')}</p>
 <ul className="space-y-2.5 text-sm">
 {bestForFrontierWorkers.filter(op => op.country === 'CH').slice(0, 3).map((op, i) => renderBestRow(op, i + 1))}
 </ul>
 </div>
 </div>
 </div>

 {/* Operators Grid */}
 <div className="grid md:grid-cols-2 gap-6">
 {filteredOperators.map((operator) => {
 const roaming = operator.country === 'IT' ? operator.roamingInSwitzerland : operator.roamingInItaly;
 const hasGoodRoaming = roaming?.included === true;
 const realMonthlyCost = calculateRealMonthlyCost(operator);
 const hasExtraCost = realMonthlyCost > operator.monthlyCost;
 
 const CardWrapper = operator.website ? 'a' : 'div';
 const cardProps = operator.website ? {
 href: operator.website,
 target: '_blank',
 rel: 'noopener noreferrer',
 onClick: () => Analytics.trackMobileOperator('link_click', operator.name, operator.country),
 className: `block bg-surface rounded-2xl border-2 p-4 sm:p-6 hover:shadow-lg transition-[color,background-color,border-color,box-shadow] cursor-pointer ${
 hasGoodRoaming 
 ? 'border-success ring-2 ring-success/20 hover:ring-success/40' 
 : 'border-edge hover:border-warning'
 }`
 } : {
 className: `bg-surface rounded-2xl border-2 p-4 sm:p-6 hover:shadow-lg transition-[color,background-color,border-color,box-shadow] ${
 hasGoodRoaming 
 ? 'border-success ring-2 ring-success/20' 
 : 'border-edge'
 }`
 };

 return (
 <CardWrapper key={operator.name} {...cardProps}>
 {hasGoodRoaming && (
 <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-success-strong text-on-accent text-xs font-bold rounded-full">
 <CheckCircle2 size={14} />
 {t('mobile.roamingIncluded')}
 </div>
 )}

 <div className="flex items-start justify-between gap-4 mb-4">
 <div className="flex items-center gap-3">
 <div className={`p-3 bg-gradient-to-br ${operator.color} rounded-2xl flex items-center justify-center`}>
 <ProviderLogo slug={operator.slug} name={operator.name} size={28} />
 </div>
 <div>
 <h3 className="text-xl font-bold font-display text-strong">{operator.name}</h3>
 <p className="text-sm text-muted">
 {operator.country === 'IT' ? '🇮🇹 Italia' : '🇨🇭 Svizzera'} • {operator.contractType}
 </p>
 </div>
 </div>

 <div className="text-right">
 {hasExtraCost ? (
 <>
 <div className="text-sm text-muted line-through">
 {operator.country === 'IT' ? '€' : 'CHF'} {operator.monthlyCost.toFixed(2)}
 </div>
 <div className="text-2xl font-bold text-danger">
 {operator.country === 'IT' ? '€' : 'CHF'} {realMonthlyCost.toFixed(2)}
 </div>
 <div className="text-sm text-danger font-medium">{t('mobile.realCostMonth')}</div>
 </>
 ) : (
 <>
 <div className="text-2xl font-bold text-strong">
 {operator.country === 'IT' ? '€' : 'CHF'} {operator.monthlyCost.toFixed(2)}
 </div>
 <div className="text-xs text-muted">{t('mobile.perMonth')}</div>
 </>
 )}
 </div>
 </div>

 {/* Cost Breakdown se ci sono costi extra */}
 {hasExtraCost && (
 <div className="mb-4 p-3 bg-warning-subtle border border-warning-border rounded-lg">
 <p className="text-xs font-bold text-warning mb-2">💰 {t('mobile.costBreakdown')}:</p>
 <div className="space-y-1 text-sm text-warning">
 <div className="flex justify-between">
 <span>{t('mobile.basePlan')}:</span>
 <span className="font-medium">{operator.country === 'IT' ? '€' : 'CHF'} {operator.monthlyCost.toFixed(2)}</span>
 </div>
 {roaming?.costPerDay && (
 <div className="flex justify-between">
 <span>Pass giornaliero ({roaming.costPerDay}{operator.country === 'IT' ? '€' : 'CHF'} × {WORKING_DAYS_PER_MONTH} gg):</span>
 <span className="font-medium">+ {(roaming.costPerDay * WORKING_DAYS_PER_MONTH).toFixed(2)}{operator.country === 'IT' ? '€' : 'CHF'}</span>
 </div>
 )}
 {roaming?.monthlyFee && (
 <div className="flex justify-between">
 <span>Costo fisso roaming:</span>
 <span className="font-medium">+ {roaming.monthlyFee.toFixed(2)}{operator.country === 'IT' ? '€' : 'CHF'}</span>
 </div>
 )}
 <div className="flex justify-between border-t border-warning-border pt-1 mt-1">
 <span className="font-bold">{t('mobile.monthlyTotal')}:</span>
 <span className="font-bold">{operator.country === 'IT' ? '€' : 'CHF'} {realMonthlyCost.toFixed(2)}</span>
 </div>
 </div>
 </div>
 )}

 {/* Plan Details */}
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
 <div className="p-3 bg-surface-alt rounded-xl text-center">
 <Wifi className="mx-auto mb-1 text-warning" size={18} />
 <div className="text-xs text-muted mb-1">{t('mobile.data')}</div>
 <div className="text-sm font-bold text-strong">
 {operator.dataGB === 'illimitati' ? '∞' : `${operator.dataGB} GB`}
 </div>
 </div>

 <div className="p-3 bg-surface-alt rounded-xl text-center">
 <Phone className="mx-auto mb-1 text-success" size={18} />
 <div className="text-xs text-muted mb-1">{t('mobile.minutes')}</div>
 <div className="text-sm font-bold text-strong">
 {operator.minutes === 'illimitati' ? '∞' : operator.minutes}
 </div>
 </div>

 <div className="p-3 bg-surface-alt rounded-xl text-center">
 <MessageSquare className="mx-auto mb-1 text-danger" size={18} />
 <div className="text-xs text-muted mb-1">{t('mobile.sms')}</div>
 <div className="text-sm font-bold text-strong">
 {operator.sms === 'illimitati' ? '∞' : operator.sms}
 </div>
 </div>
 </div>

 {/* Roaming Details */}
 <div className={`p-4 rounded-xl mb-4 ${
 roaming?.included 
 ? 'bg-success-subtle border border-success-border' 
 : 'bg-danger-subtle border border-danger-border'
 }`}>
 <div className="flex items-start gap-2 mb-2">
 <Globe className={`flex-shrink-0 ${roaming?.included ? 'text-success' : 'text-danger'}`} size={18} />
 <div className="flex-1">
 <p className={`font-bold text-sm mb-1 ${roaming?.included ? 'text-success' : 'text-danger'}`}>
 {t('mobile.roamingIn')} {operator.country === 'IT' ? `${t('mobile.switzerland')} 🇨🇭` : `${t('mobile.italy')} 🇮🇹`}
 </p>
 <p className="text-sm text-body">
 {roaming?.notes}
 </p>
 {roaming?.costPerDay && (
 <p className="text-xs font-bold text-danger mt-1">
 ⚠️ Pass obbligatorio: +{(roaming.costPerDay * WORKING_DAYS_PER_MONTH).toFixed(2)}{operator.country === 'IT' ? '€' : 'CHF'}/mese ({roaming.costPerDay}{operator.country === 'IT' ? '€' : 'CHF'}/giorno × {WORKING_DAYS_PER_MONTH} giorni lavorativi)
 </p>
 )}
 {roaming?.monthlyFee && (
 <p className="text-xs font-bold text-danger mt-1">
 ⚠️ Costo fisso: +{roaming.monthlyFee.toFixed(2)}{operator.country === 'IT' ? '€' : 'CHF'}/mese
 </p>
 )}
 </div>
 </div>
 </div>

 {/* Setup Cost */}
 {operator.setupCost > 0 && (
 <div className="mb-4 p-3 bg-warning-subtle rounded-lg border border-warning-border">
 <p className="text-xs text-warning">
 <Euro className="inline" size={14} /> <strong>{t('mobile.setupCost')}:</strong> {operator.setupCost.toFixed(2)} {operator.country === 'IT' ? '€' : 'CHF'}
 </p>
 </div>
 )}

 {/* Features */}
 <div className="border-t border-edge pt-3">
 <div className="flex flex-wrap gap-2">
 {operator.features.map((feature, idx) => (
 <span
 key={idx}
 className="px-2.5 py-1 bg-surface-raised text-body text-xs font-medium rounded-lg"
 >
 {feature}
 </span>
 ))}
 </div>
 </div>
 </CardWrapper>
 );
 })}
 </div>

 {/* Educational Section */}
 <div className="bg-gradient-to-br from-warning-subtle to-warning-subtle rounded-2xl border border-warning-border p-6">
 <h3 className="text-xl font-bold font-display text-strong mb-4 flex items-center gap-2">
 <Info size={20} className="text-accent" />
 {t('mobile.tipsTitle')}
 </h3>
 
 <div className="space-y-4 text-sm text-body">
 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-accent mb-2">📱 {t('mobile.whichOperator')}</p>
 <ul className="space-y-2 ml-4 list-disc">
 <li>{t('mobile.operatorTip1')}</li>
 <li>{t('mobile.operatorTip2')}</li>
 <li>{t('mobile.operatorTip3')}</li>
 </ul>
 </div>

 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-accent mb-2">💡 {t('mobile.tricksTitle')}</p>
 <ul className="space-y-2 ml-4 list-disc">
 <li>{t('mobile.trick1')}</li>
 <li>{t('mobile.trick2')}</li>
 <li>{t('mobile.trick3')}</li>
 <li>{t('mobile.trick4')}</li>
 </ul>
 </div>

 <div className="p-4 bg-warning-subtle rounded-xl border border-warning-border">
 <p className="font-bold text-warning mb-2">⚠️ {t('mobile.hiddenCosts')}</p>
 <ul className="space-y-1 ml-4 list-disc text-warning">
 <li>{t('mobile.hiddenCost1')}</li>
 <li>{t('mobile.hiddenCost2')}</li>
 <li>{t('mobile.hiddenCost3')}</li>
 </ul>
 </div>
 </div>
 </div>

 <Suspense fallback={null}><RelatedTools context="comparison" /></Suspense>

 <PartnerRecommendations context="mobile" />
 </div>
 );
};

export default MobileOperators;
