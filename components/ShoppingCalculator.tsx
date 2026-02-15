import React, { useState, useMemo } from 'react';
import { ShoppingCart, TrendingDown, AlertCircle, Info, Euro, ArrowRight, Package, Fuel, Wine, Baby, Pill, Beef, Wheat, Coffee, Milk, Apple, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useExchangeRate } from '@/services/exchangeRateService';

interface Product {
  id: string;
  name: string;
  nameKey: string;
  category: string;
  categoryKey: string;
  icon: React.ReactNode;
  priceIT: number; // EUR
  priceCH: number; // CHF
  unit: string;
  storeCH: string;
  storeIT: string;
  notes?: string;
}

const PRODUCTS: Product[] = [
  // Alimentari base
  { id: 'milk', name: 'Latte intero 1L', nameKey: 'shopping.product.milk', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Milk size={16} />, priceIT: 1.29, priceCH: 1.85, unit: '1L', storeCH: 'Migros', storeIT: 'Esselunga' },
  { id: 'bread', name: 'Pane bianco 500g', nameKey: 'shopping.product.bread', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Wheat size={16} />, priceIT: 1.49, priceCH: 2.60, unit: '500g', storeCH: 'Coop', storeIT: 'Carrefour' },
  { id: 'pasta', name: 'Pasta Barilla 500g', nameKey: 'shopping.product.pasta', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Wheat size={16} />, priceIT: 0.89, priceCH: 2.10, unit: '500g', storeCH: 'Migros', storeIT: 'Lidl IT' },
  { id: 'rice', name: 'Riso Arborio 1kg', nameKey: 'shopping.product.rice', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Wheat size={16} />, priceIT: 2.29, priceCH: 4.50, unit: '1kg', storeCH: 'Coop', storeIT: 'Esselunga' },
  { id: 'tomato_sauce', name: 'Passata Mutti 700g', nameKey: 'shopping.product.tomato_sauce', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Apple size={16} />, priceIT: 1.39, priceCH: 3.20, unit: '700g', storeCH: 'Coop', storeIT: 'Carrefour' },
  { id: 'olive_oil', name: 'Olio EVO 1L', nameKey: 'shopping.product.olive_oil', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Coffee size={16} />, priceIT: 7.99, priceCH: 12.90, unit: '1L', storeCH: 'Migros', storeIT: 'Esselunga' },
  { id: 'eggs', name: 'Uova 10 pz', nameKey: 'shopping.product.eggs', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Apple size={16} />, priceIT: 2.49, priceCH: 5.30, unit: '10pz', storeCH: 'Migros', storeIT: 'Lidl IT' },
  { id: 'butter', name: 'Burro 250g', nameKey: 'shopping.product.butter', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Milk size={16} />, priceIT: 2.59, priceCH: 3.50, unit: '250g', storeCH: 'Coop', storeIT: 'Esselunga' },
  { id: 'chicken', name: 'Petto di pollo 1kg', nameKey: 'shopping.product.chicken', category: 'carne', categoryKey: 'shopping.cat.meat', icon: <Beef size={16} />, priceIT: 8.99, priceCH: 24.90, unit: '1kg', storeCH: 'Migros', storeIT: 'Carrefour' },
  { id: 'beef', name: 'Manzo macinato 500g', nameKey: 'shopping.product.beef', category: 'carne', categoryKey: 'shopping.cat.meat', icon: <Beef size={16} />, priceIT: 5.49, priceCH: 11.90, unit: '500g', storeCH: 'Coop', storeIT: 'Iper' },
  { id: 'salmon', name: 'Salmone fresco 200g', nameKey: 'shopping.product.salmon', category: 'carne', categoryKey: 'shopping.cat.meat', icon: <Beef size={16} />, priceIT: 5.99, priceCH: 10.80, unit: '200g', storeCH: 'Migros', storeIT: 'Esselunga' },
  { id: 'mozzarella', name: 'Mozzarella 125g', nameKey: 'shopping.product.mozzarella', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Milk size={16} />, priceIT: 0.89, priceCH: 2.20, unit: '125g', storeCH: 'Coop', storeIT: 'Lidl IT' },
  { id: 'parmigiano', name: 'Parmigiano Reggiano 200g', nameKey: 'shopping.product.parmigiano', category: 'alimentari', categoryKey: 'shopping.cat.food', icon: <Milk size={16} />, priceIT: 4.49, priceCH: 8.90, unit: '200g', storeCH: 'Migros', storeIT: 'Esselunga' },
  // Bevande
  { id: 'coffee', name: 'Caffè Lavazza 250g', nameKey: 'shopping.product.coffee', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Coffee size={16} />, priceIT: 3.49, priceCH: 7.90, unit: '250g', storeCH: 'Coop', storeIT: 'Carrefour' },
  { id: 'water', name: 'Acqua minerale 6x1.5L', nameKey: 'shopping.product.water', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Coffee size={16} />, priceIT: 1.89, priceCH: 4.50, unit: '6x1.5L', storeCH: 'Migros', storeIT: 'Lidl IT' },
  { id: 'wine', name: 'Vino Chianti 750ml', nameKey: 'shopping.product.wine', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Wine size={16} />, priceIT: 4.99, priceCH: 12.90, unit: '750ml', storeCH: 'Coop', storeIT: 'Esselunga' },
  { id: 'beer', name: 'Birra 6x330ml', nameKey: 'shopping.product.beer', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Wine size={16} />, priceIT: 4.49, priceCH: 9.80, unit: '6x330ml', storeCH: 'Migros', storeIT: 'Carrefour' },
  { id: 'cocacola', name: 'Coca-Cola 1.5L', nameKey: 'shopping.product.cocacola', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Coffee size={16} />, priceIT: 1.49, priceCH: 2.50, unit: '1.5L', storeCH: 'Lidl CH', storeIT: 'Lidl IT' },
  // Igiene e casa
  { id: 'detergent', name: 'Detersivo lavatrice 1L', nameKey: 'shopping.product.detergent', category: 'casa', categoryKey: 'shopping.cat.home', icon: <Package size={16} />, priceIT: 3.99, priceCH: 8.50, unit: '1L', storeCH: 'Migros', storeIT: 'Carrefour' },
  { id: 'shampoo', name: 'Shampoo 250ml', nameKey: 'shopping.product.shampoo', category: 'casa', categoryKey: 'shopping.cat.home', icon: <Package size={16} />, priceIT: 2.99, priceCH: 5.90, unit: '250ml', storeCH: 'Coop', storeIT: 'Esselunga' },
  { id: 'toilet_paper', name: 'Carta igienica 8 rotoli', nameKey: 'shopping.product.toilet_paper', category: 'casa', categoryKey: 'shopping.cat.home', icon: <Package size={16} />, priceIT: 3.29, priceCH: 7.50, unit: '8 rotoli', storeCH: 'Migros', storeIT: 'Lidl IT' },
  { id: 'diapers', name: 'Pannolini 30 pz', nameKey: 'shopping.product.diapers', category: 'bambini', categoryKey: 'shopping.cat.baby', icon: <Baby size={16} />, priceIT: 7.99, priceCH: 17.90, unit: '30pz', storeCH: 'Coop', storeIT: 'Carrefour' },
  // Carburante
  { id: 'gasoline', name: 'Benzina (al litro)', nameKey: 'shopping.product.gasoline', category: 'carburante', categoryKey: 'shopping.cat.fuel', icon: <Fuel size={16} />, priceIT: 1.75, priceCH: 1.85, unit: '1L', storeCH: 'Stazione', storeIT: 'Stazione' },
  { id: 'diesel', name: 'Diesel (al litro)', nameKey: 'shopping.product.diesel', category: 'carburante', categoryKey: 'shopping.cat.fuel', icon: <Fuel size={16} />, priceIT: 1.65, priceCH: 1.95, unit: '1L', storeCH: 'Stazione', storeIT: 'Stazione' },
  // Farmacia
  { id: 'ibuprofen', name: 'Ibuprofene 400mg 20cpr', nameKey: 'shopping.product.ibuprofen', category: 'farmacia', categoryKey: 'shopping.cat.pharma', icon: <Pill size={16} />, priceIT: 3.99, priceCH: 9.80, unit: '20cpr', storeCH: 'Farmacia', storeIT: 'Farmacia' },
  { id: 'paracetamol', name: 'Paracetamolo 500mg 20cpr', nameKey: 'shopping.product.paracetamol', category: 'farmacia', categoryKey: 'shopping.cat.pharma', icon: <Pill size={16} />, priceIT: 2.49, priceCH: 7.50, unit: '20cpr', storeCH: 'Farmacia', storeIT: 'Farmacia' },
];

const CATEGORIES = ['all', 'alimentari', 'carne', 'bevande', 'casa', 'bambini', 'carburante', 'farmacia'] as const;

const ShoppingCalculator: React.FC = () => {
  const { t } = useTranslation();
  const { rate: liveRate, loading: rateLoading } = useExchangeRate();
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  
  // Use live rate unless user manually overrode it
  const effectiveRate = exchangeRate ?? liveRate;
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedProducts, setSelectedProducts] = useState<Record<string, number>>({});
  const [showOnlySavings, setShowOnlySavings] = useState(false);

  const toggleProduct = (id: string) => {
    setSelectedProducts(prev => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        next[id] = 1;
      }
      return next;
    });
    Analytics.trackUIInteraction('guida', 'spesa', 'prodotto', 'toggle', id);
  };

  const updateQuantity = (id: string, qty: number) => {
    if (qty <= 0) {
      setSelectedProducts(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } else {
      setSelectedProducts(prev => ({ ...prev, [id]: qty }));
    }
  };

  const filteredProducts = PRODUCTS.filter(p => {
    if (selectedCategory !== 'all' && p.category !== selectedCategory) return false;
    if (showOnlySavings) {
      const priceCHinEUR = p.priceCH * effectiveRate;
      return priceCHinEUR > p.priceIT;
    }
    return true;
  });

  const stats = useMemo(() => {
    let totalIT = 0;
    let totalCH = 0;
    const selectedItems = Object.entries(selectedProducts);

    for (const [id, qty] of selectedItems) {
      const product = PRODUCTS.find(p => p.id === id);
      if (!product) continue;
      totalIT += product.priceIT * qty;
      totalCH += product.priceCH * qty;
    }

    const totalCHinEUR = totalCH * effectiveRate;
    const savings = totalCHinEUR - totalIT;
    const savingsPercent = totalCHinEUR > 0 ? (savings / totalCHinEUR) * 100 : 0;

    // Customs limits
    const CUSTOMS_LIMIT_CHF = 300;
    const exceedsCustoms = totalIT / effectiveRate > CUSTOMS_LIMIT_CHF;

    return {
      totalIT,
      totalCH,
      totalCHinEUR,
      savings,
      savingsPercent,
      selectedCount: selectedItems.length,
      exceedsCustoms,
      annualSavings: savings * 52, // weekly shopping
    };
  }, [selectedProducts, effectiveRate]);

  // Overall comparison
  const allProductStats = useMemo(() => {
    let totalIT = 0;
    let totalCH = 0;
    for (const p of PRODUCTS) {
      totalIT += p.priceIT;
      totalCH += p.priceCH;
    }
    const totalCHinEUR = totalCH * effectiveRate;
    const savings = totalCHinEUR - totalIT;
    const savingsPercent = totalCHinEUR > 0 ? (savings / totalCHinEUR) * 100 : 0;
    return { totalIT, totalCH, totalCHinEUR, savings, savingsPercent };
  }, [effectiveRate]);

  const selectAll = () => {
    const newSelected: Record<string, number> = {};
    filteredProducts.forEach(p => { newSelected[p.id] = selectedProducts[p.id] || 1; });
    setSelectedProducts(prev => ({ ...prev, ...newSelected }));
    Analytics.trackUIInteraction('guida', 'spesa', 'selezione', 'seleziona_tutti', selectedCategory);
  };

  const clearAll = () => {
    setSelectedProducts({});
    Analytics.trackUIInteraction('guida', 'spesa', 'selezione', 'deseleziona_tutti', '');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-orange-500 to-red-600 rounded-2xl p-6 text-white">
        <div className="flex items-center gap-3 mb-3">
          <ShoppingCart size={28} />
          <h3 className="text-2xl font-extrabold">{t('shopping.title')}</h3>
        </div>
        <p className="text-orange-100">{t('shopping.subtitle')}</p>
      </div>

      {/* Exchange Rate + Summary */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-2">
            {t('shopping.exchangeRate')}
            {rateLoading && <RefreshCw size={12} className="animate-spin text-orange-500" />}
          </label>
          <input
            type="number"
            step="0.01"
            value={effectiveRate}
            onChange={(e) => setExchangeRate(parseFloat(e.target.value) || null)}
            className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-lg font-bold"
          />
          <p className="text-xs text-slate-500 mt-1">1 CHF = {effectiveRate.toFixed(4)} EUR · <span className="text-orange-500">frankfurter.app</span></p>
        </div>

        <div className="bg-gradient-to-br from-emerald-500 to-green-600 rounded-xl p-4 text-white">
          <div className="text-xs font-bold uppercase tracking-wider text-white/70">{t('shopping.avgSavings')}</div>
          <div className="text-3xl font-black">{allProductStats.savingsPercent.toFixed(0)}%</div>
          <div className="text-xs text-white/80">{t('shopping.buyingInItaly')}</div>
        </div>

        {stats.selectedCount > 0 && (
          <div className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl p-4 text-white">
            <div className="text-xs font-bold uppercase tracking-wider text-white/70">{t('shopping.yourSavings')}</div>
            <div className="text-3xl font-black">€ {stats.savings.toFixed(2)}</div>
            <div className="text-xs text-white/80">{t('shopping.perTrip')} ({stats.selectedCount} {t('shopping.products')})</div>
          </div>
        )}
      </div>

      {/* Customs Warning */}
      <div className="bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <p className="font-bold mb-1">{t('shopping.customsTitle')}</p>
            <p>{t('shopping.customsDesc')}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap gap-2 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => { setSelectedCategory(cat); Analytics.trackUIInteraction('guida', 'spesa', 'filtro_categoria', 'click', cat); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  selectedCategory === cat
                    ? 'bg-orange-600 text-white'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {t(`shopping.cat.${cat === 'all' ? 'all' : cat === 'alimentari' ? 'food' : cat === 'carne' ? 'meat' : cat === 'bevande' ? 'drinks' : cat === 'casa' ? 'home' : cat === 'bambini' ? 'baby' : cat === 'carburante' ? 'fuel' : 'pharma'}`)}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" checked={showOnlySavings} onChange={e => setShowOnlySavings(e.target.checked)} className="w-4 h-4" />
              <span className="font-bold text-slate-700 dark:text-slate-300">{t('shopping.onlySavings')}</span>
            </label>
            <button onClick={selectAll} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 hover:bg-blue-200">
              {t('shopping.selectAll')}
            </button>
            <button onClick={clearAll} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200">
              {t('shopping.clearAll')}
            </button>
          </div>
        </div>
      </div>

      {/* Products Grid */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredProducts.map(product => {
          const priceCHinEUR = product.priceCH * effectiveRate;
          const saving = priceCHinEUR - product.priceIT;
          const savingPercent = priceCHinEUR > 0 ? (saving / priceCHinEUR) * 100 : 0;
          const isSelected = !!selectedProducts[product.id];
          const qty = selectedProducts[product.id] || 0;

          return (
            <div
              key={product.id}
              onClick={() => !isSelected && toggleProduct(product.id)}
              className={`bg-white dark:bg-slate-800 rounded-xl p-4 border-2 transition-all cursor-pointer ${
                isSelected
                  ? 'border-orange-500 ring-2 ring-orange-500/20 shadow-lg'
                  : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-orange-500">{product.icon}</span>
                  <div>
                    <div className="font-bold text-sm text-slate-800 dark:text-slate-100">{product.name}</div>
                    <div className="text-[10px] text-slate-500">{product.unit}</div>
                  </div>
                </div>
                {saving > 0 && (
                  <span className="px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 text-[10px] font-black rounded-full whitespace-nowrap">
                    -{savingPercent.toFixed(0)}%
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-sm">
                <div className="text-center">
                  <div className="text-[10px] text-slate-500 uppercase">🇮🇹 {product.storeIT}</div>
                  <div className="font-black text-emerald-600 text-lg">€ {product.priceIT.toFixed(2)}</div>
                </div>
                <ArrowRight size={14} className="text-slate-500" />
                <div className="text-center">
                  <div className="text-[10px] text-slate-500 uppercase">🇨🇭 {product.storeCH}</div>
                  <div className="font-black text-red-500 text-lg">{product.priceCH.toFixed(2)} CHF</div>
                  <div className="text-[10px] text-slate-500">≈ € {priceCHinEUR.toFixed(2)}</div>
                </div>
              </div>

              {isSelected && (
                <div className="mt-3 flex items-center justify-center gap-3 border-t border-slate-200 dark:border-slate-700 pt-3" onClick={e => e.stopPropagation()}>
                  <button onClick={() => updateQuantity(product.id, qty - 1)} className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 font-bold text-lg flex items-center justify-center hover:bg-red-200 dark:hover:bg-red-800">-</button>
                  <span className="text-lg font-black w-8 text-center">{qty}</span>
                  <button onClick={() => updateQuantity(product.id, qty + 1)} className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 font-bold text-lg flex items-center justify-center hover:bg-emerald-200 dark:hover:bg-emerald-800">+</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Cart Summary */}
      {stats.selectedCount > 0 && (
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 dark:from-slate-700 dark:to-slate-800 rounded-2xl p-6 text-white">
          <h4 className="font-extrabold text-lg mb-4 flex items-center gap-2">
            <ShoppingCart size={20} /> {t('shopping.cartSummary')}
          </h4>
          <div className="grid md:grid-cols-4 gap-4">
            <div className="bg-white/10 rounded-xl p-4">
              <div className="text-xs uppercase tracking-wider text-white/60">🇮🇹 {t('shopping.totalItaly')}</div>
              <div className="text-2xl font-black">€ {stats.totalIT.toFixed(2)}</div>
            </div>
            <div className="bg-white/10 rounded-xl p-4">
              <div className="text-xs uppercase tracking-wider text-white/60">🇨🇭 {t('shopping.totalSwitzerland')}</div>
              <div className="text-2xl font-black">{stats.totalCH.toFixed(2)} CHF</div>
              <div className="text-xs text-white/50">≈ € {stats.totalCHinEUR.toFixed(2)}</div>
            </div>
            <div className={`rounded-xl p-4 ${stats.savings > 0 ? 'bg-emerald-500/30' : 'bg-red-500/30'}`}>
              <div className="text-xs uppercase tracking-wider text-white/60">{t('shopping.savings')}</div>
              <div className="text-2xl font-black">€ {stats.savings.toFixed(2)}</div>
              <div className="text-xs text-white/80">{stats.savingsPercent.toFixed(0)}% {stats.savings > 0 ? t('shopping.cheaper') : t('shopping.moreExpensive')}</div>
            </div>
            <div className="bg-amber-500/30 rounded-xl p-4">
              <div className="text-xs uppercase tracking-wider text-white/60">{t('shopping.annualSavings')}</div>
              <div className="text-2xl font-black">€ {stats.annualSavings.toFixed(0)}</div>
              <div className="text-xs text-white/80">{t('shopping.weeklyTrips')}</div>
            </div>
          </div>

          {stats.exceedsCustoms && (
            <div className="mt-4 p-3 bg-red-500/30 border border-red-500/50 rounded-xl flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span className="text-sm">{t('shopping.customsWarning')}</span>
            </div>
          )}
        </div>
      )}

      {/* Supermarket Links */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <h4 className="font-bold text-sm text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
          <Info size={14} /> {t('shopping.sourcesTitle')}
        </h4>
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            { name: 'Esselunga', url: 'https://www.esselunga.it', flag: '🇮🇹' },
            { name: 'Carrefour', url: 'https://www.carrefour.it', flag: '🇮🇹' },
            { name: 'Lidl IT', url: 'https://www.lidl.it', flag: '🇮🇹' },
            { name: 'Iper', url: 'https://www.iper.it', flag: '🇮🇹' },
            { name: 'Tigros', url: 'https://www.tigros.it', flag: '🇮🇹' },
            { name: 'Migros', url: 'https://www.migros.ch', flag: '🇨🇭' },
            { name: 'Coop CH', url: 'https://www.coop.ch', flag: '🇨🇭' },
            { name: 'Lidl CH', url: 'https://www.lidl.ch', flag: '🇨🇭' },
          ].map(store => (
            <a key={store.name} href={store.url} target="_blank" rel="noopener noreferrer"
              className="px-3 py-1.5 bg-slate-100 dark:bg-slate-700 rounded-lg hover:bg-orange-100 dark:hover:bg-orange-900/30 transition-colors font-bold text-slate-700 dark:text-slate-300">
              {store.flag} {store.name}
            </a>
          ))}
        </div>
        <p className="text-[10px] text-slate-500 mt-2">{t('shopping.disclaimer')}</p>
      </div>
    </div>
  );
};

export default ShoppingCalculator;
