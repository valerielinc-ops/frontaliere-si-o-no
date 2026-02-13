import React, { useState } from 'react';
import { Car, Train, Bike, TrendingDown, TrendingUp, AlertCircle, Calculator, Euro, Fuel, Clock, Zap } from 'lucide-react';

interface TransportOption {
  type: 'car-benzina' | 'car-diesel' | 'car-electric' | 'train' | 'ebike';
  name: string;
  icon: JSX.Element;
  color: string;
}

const transportOptions: TransportOption[] = [
  { type: 'car-benzina', name: 'Auto Benzina', icon: <Car size={20} />, color: 'from-red-500 to-orange-600' },
  { type: 'car-diesel', name: 'Auto Diesel', icon: <Car size={20} />, color: 'from-slate-600 to-gray-700' },
  { type: 'car-electric', name: 'Auto Elettrica', icon: <Zap size={20} />, color: 'from-green-500 to-emerald-600' },
  { type: 'train', name: 'Treno', icon: <Train size={20} />, color: 'from-blue-500 to-indigo-600' },
  { type: 'ebike', name: 'eBike', icon: <Bike size={20} />, color: 'from-purple-500 to-pink-600' }
];

const TransportCalculator: React.FC = () => {
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

  const costsBenzinaIT = calculateCarCosts('benzina', 'IT');
  const costsBenzinaCH = calculateCarCosts('benzina', 'CH');
  const costsDieselIT = calculateCarCosts('diesel', 'IT');
  const costsElectricIT = calculateCarCosts('electric', 'IT');
  const costsElectricCH = calculateCarCosts('electric', 'CH');

  const results = [
    {
      name: 'Auto Benzina (rifornimento IT)',
      type: 'car-benzina',
      costPerMonth: costsBenzinaIT.total,
      costPerYear: costsBenzinaIT.total * 12,
      details: costsBenzinaIT,
      color: 'from-red-500 to-orange-600',
      icon: <Car size={24} />,
      fuelLocation: 'IT'
    },
    {
      name: 'Auto Benzina (rifornimento CH)',
      type: 'car-benzina',
      costPerMonth: costsBenzinaCH.total,
      costPerYear: costsBenzinaCH.total * 12,
      details: costsBenzinaCH,
      color: 'from-red-600 to-rose-700',
      icon: <Car size={24} />,
      fuelLocation: 'CH'
    },
    {
      name: 'Auto Diesel (rifornimento IT)',
      type: 'car-diesel',
      costPerMonth: costsDieselIT.total,
      costPerYear: costsDieselIT.total * 12,
      details: costsDieselIT,
      color: 'from-slate-600 to-gray-700',
      icon: <Car size={24} />,
      fuelLocation: 'IT'
    },
    {
      name: 'Auto Elettrica (ricarica casa IT)',
      type: 'car-electric',
      costPerMonth: costsElectricIT.total,
      costPerYear: costsElectricIT.total * 12,
      details: costsElectricIT,
      color: 'from-green-500 to-emerald-600',
      icon: <Zap size={24} />,
      fuelLocation: 'IT'
    },
    {
      name: 'Auto Elettrica (ricarica CH)',
      type: 'car-electric',
      costPerMonth: costsElectricCH.total,
      costPerYear: costsElectricCH.total * 12,
      details: costsElectricCH,
      color: 'from-green-600 to-teal-700',
      icon: <Zap size={24} />,
      fuelLocation: 'CH'
    },
    {
      name: 'Treno',
      type: 'train',
      costPerMonth: trainCostPerMonth,
      costPerYear: trainCostPerMonth * 12,
      details: null,
      color: 'from-blue-500 to-indigo-600',
      icon: <Train size={24} />,
      fuelLocation: null
    },
    {
      name: 'eBike + Treno (giorni pioggia)',
      type: 'ebike',
      costPerMonth: ebikeCostPerMonth + ebikePurchaseCost,
      costPerYear: (ebikeCostPerMonth + ebikePurchaseCost) * 12,
      details: null,
      color: 'from-purple-500 to-pink-600',
      icon: <Bike size={24} />,
      fuelLocation: null
    }
  ].sort((a, b) => a.costPerMonth - b.costPerMonth);

  const cheapest = results[0];
  const mostExpensive = results[results.length - 1];
  const savings = mostExpensive.costPerMonth - cheapest.costPerMonth;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-600 to-cyan-700 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Car size={32} />
          <h2 className="text-3xl font-extrabold">Calcolatore Costi Trasporto</h2>
        </div>
        <p className="text-blue-100 text-lg">
          Calcola quanto ti costa andare al lavoro ogni mese: auto, treno, eBike
        </p>
      </div>

      {/* Input Section */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Calculator size={20} />
          I tuoi dati di viaggio
        </h3>

        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Distanza casa-lavoro (andata)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={kmOneWay}
                onChange={(e) => setKmOneWay(Number(e.target.value))}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
              />
              <span className="text-sm font-bold text-slate-600 dark:text-slate-400">km</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Andata + ritorno: {kmPerDay} km/giorno
            </p>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Giorni lavorativi al mese
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={workDaysPerMonth}
                onChange={(e) => setWorkDaysPerMonth(Number(e.target.value))}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
              />
              <span className="text-sm font-bold text-slate-600 dark:text-slate-400">giorni</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Totale: {kmPerMonth.toLocaleString()} km/mese, {kmPerYear.toLocaleString()} km/anno
            </p>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Consumo auto (l/100km)
            </label>
            <input
              type="number"
              step="0.1"
              value={consumptionPer100km}
              onChange={(e) => setConsumptionPer100km(Number(e.target.value))}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Pedaggi autostradali (al mese)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={tollsCost}
                onChange={(e) => setTollsCost(Number(e.target.value))}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
              />
              <span className="text-sm font-bold text-slate-600 dark:text-slate-400">€</span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Prezzo benzina IT (€/litro)
            </label>
            <input
              type="number"
              step="0.01"
              value={fuelPriceIT}
              onChange={(e) => setFuelPriceIT(Number(e.target.value))}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Prezzo benzina CH (CHF/litro)
            </label>
            <input
              type="number"
              step="0.01"
              value={fuelPriceCH}
              onChange={(e) => setFuelPriceCH(Number(e.target.value))}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Parcheggio (al mese)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={parkingCost}
                onChange={(e) => setParkingCost(Number(e.target.value))}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
              />
              <span className="text-sm font-bold text-slate-600 dark:text-slate-400">CHF</span>
            </div>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-950/30 dark:to-green-950/30 rounded-2xl border border-emerald-200 dark:border-emerald-800 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 bg-emerald-500 rounded-xl text-white">
              <TrendingDown size={24} />
            </div>
            <div>
              <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">Opzione più economica</p>
              <h3 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{cheapest.name}</h3>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-emerald-600 mb-2">
            € {cheapest.costPerMonth.toFixed(2)}/mese
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {cheapest.costPerYear.toFixed(2)} €/anno
          </p>
        </div>

        <div className="bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-950/30 dark:to-orange-950/30 rounded-2xl border border-red-200 dark:border-red-800 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 bg-red-500 rounded-xl text-white">
              <TrendingUp size={24} />
            </div>
            <div>
              <p className="text-sm font-bold text-red-700 dark:text-red-400">Opzione più costosa</p>
              <h3 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{mostExpensive.name}</h3>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-red-600 mb-2">
            € {mostExpensive.costPerMonth.toFixed(2)}/mese
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Risparmi <strong className="text-emerald-600">{savings.toFixed(2)} €/mese</strong> con {cheapest.name}
          </p>
        </div>
      </div>

      {/* Results Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        {results.map((result) => (
          <div
            key={result.name}
            className={`bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all ${
              result.name === cheapest.name 
                ? 'border-emerald-500 ring-2 ring-emerald-500/20' 
                : 'border-slate-200 dark:border-slate-700'
            }`}
          >
            {result.name === cheapest.name && (
              <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-xs font-bold rounded-full">
                ✓ Più Economico
              </div>
            )}

            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex items-center gap-3">
                <div className={`text-white p-3 bg-gradient-to-br ${result.color} rounded-2xl`}>
                  {result.icon}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{result.name}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {result.type.includes('car') ? `${kmPerYear.toLocaleString()} km/anno` : 'Trasporto pubblico'}
                  </p>
                </div>
              </div>

              <div className="text-right">
                <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                  € {result.costPerMonth.toFixed(2)}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">al mese</div>
              </div>
            </div>

            {result.details && (
              <div className="space-y-2 mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Carburante/Energia</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">€ {result.details.fuelCost.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Assicurazione</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">€ {result.details.insurance.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Manutenzione</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">€ {result.details.maintenance.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Usura (gomme, freni)</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">€ {result.details.wear.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Ammortamento</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">€ {result.details.depreciation.toFixed(2)}</span>
                </div>
                {result.details.tolls > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600 dark:text-slate-400">Pedaggi</span>
                    <span className="font-bold text-slate-800 dark:text-slate-100">€ {result.details.tolls.toFixed(2)}</span>
                  </div>
                )}
                {result.details.parking > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600 dark:text-slate-400">Parcheggio</span>
                    <span className="font-bold text-slate-800 dark:text-slate-100">CHF {result.details.parking.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            {result.type === 'train' && (
              <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
                <p className="text-xs text-blue-800 dark:text-blue-300">
                  💡 Stima basata su ~0.15€/km. Controlla abbonamenti mensili/annuali per risparmiare.
                </p>
              </div>
            )}

            {result.type === 'ebike' && (
              <div className="mt-4 p-3 bg-purple-50 dark:bg-purple-950/30 rounded-lg">
                <p className="text-xs text-purple-800 dark:text-purple-300">
                  💡 Include costo eBike (2500€ ammortizzato su 5 anni) + manutenzione
                </p>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Tips Section */}
      <div className="bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 rounded-2xl border border-amber-200 dark:border-amber-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <AlertCircle size={20} className="text-amber-600" />
          Consigli per risparmiare
        </h3>
        
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-amber-700 dark:text-amber-400 mb-2">⛽ Dove fare benzina?</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Italia: benzina più economica (~10-15 cent/litro)</li>
              <li>Fai rifornimento vicino al confine prima di tornare</li>
              <li>App Prezzi Benzina per trovare stazioni più economiche</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-amber-700 dark:text-amber-400 mb-2">🚗 Elettrico conviene?</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Ricarica a casa IT: ~35€/mese vs 180€ benzina</li>
              <li>Manutenzione ridotta (no olio, filtri, frizione)</li>
              <li>Considera costo acquisto: break-even dopo 5-7 anni</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-amber-700 dark:text-amber-400 mb-2">🚆 Treno come alternativa</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Nessun stress traffico e parcheggio</li>
              <li>Puoi lavorare/leggere durante il viaggio</li>
              <li>Abbonamenti mensili convenienti (Tilo, SBB)</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-amber-700 dark:text-amber-400 mb-2">💰 Deduzioni fiscali</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Spese trasporto deducibili in dichiarazione</li>
              <li>Conserva ricevute abbonamenti treno</li>
              <li>Auto: deducibile forfettario 0.30€/km</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TransportCalculator;
