import React, { useState, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { Car, Download, Info, AlertTriangle, CheckCircle, ArrowRight } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { useNavigation } from '@/services/NavigationContext';

type VehicleType = 'small' | 'medium' | 'large' | 'electric';
type FuelType = 'petrol' | 'diesel' | 'electric';

// ── Italian cost data (annual estimates 2025) ──

const IT_INSURANCE: Record<VehicleType, number> = {
  small: 550, medium: 750, large: 1100, electric: 500,
};
const IT_BOLLO: Record<VehicleType, number> = {
  small: 180, medium: 330, large: 520, electric: 0, // EV exempt first 5 yrs
};
const IT_FUEL_PER_KM: Record<FuelType, number> = {
  petrol: 0.11, diesel: 0.085, electric: 0.035, // EUR/km
};
const IT_MAINTENANCE_BASE: Record<VehicleType, number> = {
  small: 400, medium: 650, large: 900, electric: 280,
};
const IT_INSPECTION = 80; // revisione every 2y → annualized

// ── Swiss cost data (annual estimates 2025, in CHF) ──

const CH_INSURANCE: Record<VehicleType, number> = {
  small: 900, medium: 1350, large: 2000, electric: 850,
};
const CH_VEHICLE_TAX: Record<VehicleType, number> = {
  small: 250, medium: 420, large: 650, electric: 150,
};
const CH_FUEL_PER_KM: Record<FuelType, number> = {
  petrol: 0.14, diesel: 0.11, electric: 0.04, // CHF/km
};
const CH_MAINTENANCE_BASE: Record<VehicleType, number> = {
  small: 600, medium: 950, large: 1350, electric: 400,
};
const CH_MFK = 100; // MFK every 2–3y → annualized

// Sdoganamento (customs clearance) rates
const SDOGANAMENTO_IVA = 0.081;    // 8.1% Swiss VAT
const SDOGANAMENTO_DUTY_MIN = 0;
const SDOGANAMENTO_DUTY_MAX = 0.15; // 0-15% depending on origin

// Age multiplier for maintenance
function maintenanceMultiplier(age: number): number {
  if (age <= 2) return 0.6;
  if (age <= 5) return 1.0;
  if (age <= 10) return 1.4;
  return 1.8;
}

// Vehicle value estimate for sdoganamento
function estimateVehicleValue(type: VehicleType, age: number): number {
  const newValue: Record<VehicleType, number> = {
    small: 18000, medium: 32000, large: 50000, electric: 38000,
  };
  const depreciation = Math.min(age * 0.12, 0.8); // 12%/yr, max 80%
  return Math.round(newValue[type] * (1 - depreciation));
}

interface CostBreakdown {
  insurance: number;
  tax: number;
  fuel: number;
  maintenance: number;
  inspection: number;
  total: number;
}

function calculateCosts(
  vehicleType: VehicleType,
  vehicleAge: number,
  annualKm: number,
  fuelType: FuelType,
): { italy: CostBreakdown; switzerland: CostBreakdown; sdoganamento: number } {
  const mMult = maintenanceMultiplier(vehicleAge);

  const italy: CostBreakdown = {
    insurance: IT_INSURANCE[vehicleType],
    tax: vehicleType === 'electric' && vehicleAge <= 5 ? 0 : IT_BOLLO[vehicleType],
    fuel: Math.round(annualKm * IT_FUEL_PER_KM[fuelType]),
    maintenance: Math.round(IT_MAINTENANCE_BASE[vehicleType] * mMult),
    inspection: IT_INSPECTION,
    total: 0,
  };
  italy.total = italy.insurance + italy.tax + italy.fuel + italy.maintenance + italy.inspection;

  const switzerland: CostBreakdown = {
    insurance: CH_INSURANCE[vehicleType],
    tax: CH_VEHICLE_TAX[vehicleType],
    fuel: Math.round(annualKm * CH_FUEL_PER_KM[fuelType]),
    maintenance: Math.round(CH_MAINTENANCE_BASE[vehicleType] * mMult),
    inspection: CH_MFK,
    total: 0,
  };
  switzerland.total = switzerland.insurance + switzerland.tax + switzerland.fuel + switzerland.maintenance + switzerland.inspection;

  const vehicleValue = estimateVehicleValue(vehicleType, vehicleAge);
  const sdoganamento = Math.round(vehicleValue * (SDOGANAMENTO_IVA + 0.05)); // avg 5% duty

  return { italy, switzerland, sdoganamento };
}

export default function CarCostCalculator() {
  const { t } = useTranslation();
  const nav = useNavigation();
  const [vehicleType, setVehicleType] = useState<VehicleType>('medium');
  const [vehicleAge, setVehicleAge] = useState(3);
  const [annualKm, setAnnualKm] = useState(15000);
  const [fuelType, setFuelType] = useState<FuelType>('petrol');
  const [showSdoganamento, setShowSdoganamento] = useState(false);

  const fuelForVehicle: FuelType = vehicleType === 'electric' ? 'electric' : fuelType;

  const result = useMemo(
    () => calculateCosts(vehicleType, vehicleAge, annualKm, fuelForVehicle),
    [vehicleType, vehicleAge, annualKm, fuelForVehicle],
  );

  const diff = result.italy.total - result.switzerland.total;

  const handleExportPDF = async () => {
    const { default: jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(t('carCost.title'), 14, 20);
    doc.setFontSize(10);

    const rows = [
      [t('carCost.insurance'), `€${result.italy.insurance}`, `CHF ${result.switzerland.insurance}`],
      [t('carCost.tax'), `€${result.italy.tax}`, `CHF ${result.switzerland.tax}`],
      [t('carCost.fuel'), `€${result.italy.fuel}`, `CHF ${result.switzerland.fuel}`],
      [t('carCost.maintenance'), `€${result.italy.maintenance}`, `CHF ${result.switzerland.maintenance}`],
      [t('carCost.inspection'), `€${result.italy.inspection}`, `CHF ${result.switzerland.inspection}`],
      [t('carCost.total'), `€${result.italy.total}`, `CHF ${result.switzerland.total}`],
    ];

    autoTable(doc, {
      startY: 30,
      head: [['', t('carCost.italy'), t('carCost.switzerland')]],
      body: rows,
    });

    doc.save('car-cost-comparison.pdf');
  };

  const costRows: { label: string; it: number; ch: number; unit: [string, string] }[] = [
    { label: t('carCost.insurance'), it: result.italy.insurance, ch: result.switzerland.insurance, unit: ['€', 'CHF'] },
    { label: t('carCost.tax'), it: result.italy.tax, ch: result.switzerland.tax, unit: ['€', 'CHF'] },
    { label: t('carCost.fuel'), it: result.italy.fuel, ch: result.switzerland.fuel, unit: ['€', 'CHF'] },
    { label: t('carCost.maintenance'), it: result.italy.maintenance, ch: result.switzerland.maintenance, unit: ['€', 'CHF'] },
    { label: t('carCost.inspection'), it: result.italy.inspection, ch: result.switzerland.inspection, unit: ['€', 'CHF'] },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-surface rounded-xl shadow-lg p-6">
        <div className="flex items-center gap-3 mb-2">
          <Car className="text-amber-600 dark:text-amber-400" size={28} />
          <h2 className="text-2xl font-bold text-slate-800 dark:text-white">{t('carCost.title')}</h2>
        </div>
        <p className="text-subtle">{t('carCost.subtitle')}</p>
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* ── Inputs ── */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-surface rounded-xl shadow p-5 space-y-4">
            {/* Vehicle Type */}
            <div>
              <label htmlFor="cc-vtype" className="block text-sm font-medium text-body mb-1">
                {t('carCost.vehicleType')}
              </label>
              <select
                id="cc-vtype"
                value={vehicleType}
                onChange={(e) => setVehicleType(e.target.value as VehicleType)}
                className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-slate-800 dark:text-white"
              >
                <option value="small">{t('carCost.smallCar')}</option>
                <option value="medium">{t('carCost.mediumCar')}</option>
                <option value="large">{t('carCost.largeCar')}</option>
                <option value="electric">{t('carCost.electric')}</option>
              </select>
            </div>

            {/* Vehicle Age */}
            <div>
              <label htmlFor="cc-age" className="block text-sm font-medium text-body mb-1">
                {t('carCost.vehicleAge')}: <span className="font-bold text-amber-600 dark:text-amber-400">{vehicleAge}</span>
              </label>
              <input
                id="cc-age"
                type="range"
                min={0}
                max={20}
                value={vehicleAge}
                onChange={(e) => setVehicleAge(Number(e.target.value))}
                className="w-full accent-amber-600"
              />
            </div>

            {/* Annual Km */}
            <div>
              <label htmlFor="cc-km" className="block text-sm font-medium text-body mb-1">
                {t('carCost.annualKm')}: <span className="font-bold text-amber-600 dark:text-amber-400">{annualKm.toLocaleString()}</span>
              </label>
              <input
                id="cc-km"
                type="range"
                min={5000}
                max={50000}
                step={1000}
                value={annualKm}
                onChange={(e) => setAnnualKm(Number(e.target.value))}
                className="w-full accent-amber-600"
              />
            </div>

            {/* Fuel Type (hidden if electric) */}
            {vehicleType !== 'electric' && (
              <div>
                <label htmlFor="cc-fuel" className="block text-sm font-medium text-body mb-1">
                  {t('carCost.fuelType')}
                </label>
                <select
                  id="cc-fuel"
                  value={fuelType}
                  onChange={(e) => setFuelType(e.target.value as FuelType)}
                  className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-slate-800 dark:text-white"
                >
                  <option value="petrol">{t('carCost.petrol')}</option>
                  <option value="diesel">{t('carCost.diesel')}</option>
                </select>
              </div>
            )}

            {/* Sdoganamento toggle */}
            <button
              onClick={() => setShowSdoganamento(!showSdoganamento)}
              className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400 hover:underline"
              aria-label={t('carCost.sdoganamento')}
            >
              <Info size={16} />
              {t('carCost.sdoganamento')}
            </button>

            {showSdoganamento && (
              <div className="bg-amber-50 dark:bg-amber-900/30 rounded-lg p-4 text-sm">
                <p className="font-semibold text-amber-800 dark:text-amber-300 mb-2">{t('carCost.sdoganamento')}</p>
                <p className="text-body mb-2">{t('carCost.sdoganamentoDesc')}</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-amber-700 dark:text-amber-300">
                    CHF {result.sdoganamento.toLocaleString()}
                  </span>
                  <span className="text-muted text-xs">
                    ({t('carCost.sdoganamentoNote')})
                  </span>
                </div>
                <button
                  onClick={() => { nav.setActiveTab('guida' as any); nav.setGuidaSubTab('car-transfer' as any); }}
                  className="mt-3 flex items-center gap-1.5 text-sm font-medium text-blue-700 dark:text-blue-400 hover:underline"
                  aria-label={t('carTransfer.title')}
                >
                  <ArrowRight size={14} />
                  {t('carTransfer.title')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Results ── */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-surface rounded-xl shadow p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">{t('carCost.resultTitle')}</h3>
              <button
                onClick={handleExportPDF}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 transition"
                aria-label="Export PDF"
              >
                <Download size={14} /> PDF
              </button>
            </div>

            {/* Cost comparison table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-edge">
                    <th className="text-left py-2 pr-4 text-subtle"></th>
                    <th className="text-right py-2 px-4 text-subtle">🇮🇹 {t('carCost.italy')}</th>
                    <th className="text-right py-2 pl-4 text-subtle">🇨🇭 {t('carCost.switzerland')}</th>
                  </tr>
                </thead>
                <tbody>
                  {costRows.map((row) => (
                    <tr key={row.label} className="border-b border-slate-100 dark:border-slate-700/50">
                      <td className="py-2.5 pr-4 text-body">{row.label}</td>
                      <td className="py-2.5 px-4 text-right font-mono text-strong">
                        {row.unit[0]} {row.it.toLocaleString()}
                      </td>
                      <td className="py-2.5 pl-4 text-right font-mono text-strong">
                        {row.unit[1]} {row.ch.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold text-base">
                    <td className="py-3 pr-4 text-slate-800 dark:text-white">{t('carCost.total')}</td>
                    <td className="py-3 px-4 text-right text-slate-800 dark:text-white">
                      € {result.italy.total.toLocaleString()}
                    </td>
                    <td className="py-3 pl-4 text-right text-slate-800 dark:text-white">
                      CHF {result.switzerland.total.toLocaleString()}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Visual bars */}
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3">
                <span className="w-6 text-center">🇮🇹</span>
                <div className="flex-1 bg-surface-raised rounded-full h-6 overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded-full flex items-center justify-end pr-2 text-xs font-bold text-white"
                    style={{ width: `${Math.min((result.italy.total / Math.max(result.italy.total, result.switzerland.total)) * 100, 100)}%` }}
                  >
                    € {result.italy.total.toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-center">🇨🇭</span>
                <div className="flex-1 bg-surface-raised rounded-full h-6 overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full flex items-center justify-end pr-2 text-xs font-bold text-white"
                    style={{ width: `${Math.min((result.switzerland.total / Math.max(result.italy.total, result.switzerland.total)) * 100, 100)}%` }}
                  >
                    CHF {result.switzerland.total.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            {/* Verdict */}
            <div className={`mt-5 rounded-lg p-4 flex items-start gap-3 ${diff > 0 ? 'bg-emerald-50 dark:bg-emerald-900/30' : 'bg-orange-50 dark:bg-orange-900/30'}`}>
              {diff > 0 ? (
                <CheckCircle className="text-emerald-700 dark:text-emerald-400 flex-shrink-0 mt-0.5" size={20} />
              ) : (
                <AlertTriangle className="text-orange-600 dark:text-orange-400 flex-shrink-0 mt-0.5" size={20} />
              )}
              <div>
                <p className="font-semibold text-slate-800 dark:text-white">{t('carCost.switchPlates')}</p>
                <p className="text-sm text-subtle mt-1">
                  {diff > 0
                    ? `${t('carCost.savings')}: € ${Math.abs(diff).toLocaleString()}/anno con targhe IT`
                    : `${t('carCost.savings')}: CHF ${Math.abs(diff).toLocaleString()}/anno con targhe CH`}
                </p>
                {showSdoganamento && diff < 0 && (
                  <p className="text-sm text-muted mt-1">
                    Ammortamento sdoganamento: ~{Math.ceil(result.sdoganamento / Math.abs(diff))} anni
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Disclaimer */}
          <div className="flex items-start gap-2 text-xs text-muted">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <p>{t('carCost.disclaimer')}</p>
          </div>
        </div>
      </div>
      <Suspense fallback={null}><RelatedTools context="guide" /></Suspense>
    </div>
  );
}
