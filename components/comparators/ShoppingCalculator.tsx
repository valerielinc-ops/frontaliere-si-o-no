import React, { useState, useMemo, lazy, Suspense } from 'react';
import {
 ShoppingCart, TrendingDown, AlertCircle, Info, Euro, ArrowRight,
 Package, Fuel, Wine, Baby, Pill, Beef, Wheat, Coffee, Milk, Apple,
 RefreshCw, MapPin, BarChart3, ChevronDown, BookOpen, Car, Navigation,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useExchangeRate } from '@/services/exchangeRateService';
import DataFreshness from '@/components/shared/DataFreshness';
import {
 SUPERMARKETS, ZONES, ZONE_CONVENIENCE, CHAIN_COLORS,
 TOTAL_SUPERMARKETS, TOTAL_CH, TOTAL_IT,
 getChains, filterSupermarkets, type Supermarket,
} from '@/data/supermarketData';

// Lazy-load Leaflet map to avoid loading ~200KB on initial render
const SupermarketMap = lazy(() => import('@/components/vita/SupermarketMap'));
const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));

// ── Product data ─────────────────────────────────────────────

interface Product {
 id: string;
 name: string;
 nameKey: string;
 category: string;
 categoryKey: string;
 icon: React.ReactNode;
 priceIT: number;
 priceCH: number;
 unit: string;
 storeCH: string;
 storeIT: string;
}

const PRODUCTS: Product[] = [
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
 { id: 'coffee', name: 'Caffè Lavazza 250g', nameKey: 'shopping.product.coffee', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Coffee size={16} />, priceIT: 3.49, priceCH: 7.90, unit: '250g', storeCH: 'Coop', storeIT: 'Carrefour' },
 { id: 'water', name: 'Acqua minerale 6x1.5L', nameKey: 'shopping.product.water', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Coffee size={16} />, priceIT: 1.89, priceCH: 4.50, unit: '6x1.5L', storeCH: 'Migros', storeIT: 'Lidl IT' },
 { id: 'wine', name: 'Vino Chianti 750ml', nameKey: 'shopping.product.wine', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Wine size={16} />, priceIT: 4.99, priceCH: 12.90, unit: '750ml', storeCH: 'Coop', storeIT: 'Esselunga' },
 { id: 'beer', name: 'Birra 6x330ml', nameKey: 'shopping.product.beer', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Wine size={16} />, priceIT: 4.49, priceCH: 9.80, unit: '6x330ml', storeCH: 'Migros', storeIT: 'Carrefour' },
 { id: 'cocacola', name: 'Coca-Cola 1.5L', nameKey: 'shopping.product.cocacola', category: 'bevande', categoryKey: 'shopping.cat.drinks', icon: <Coffee size={16} />, priceIT: 1.49, priceCH: 2.50, unit: '1.5L', storeCH: 'Lidl CH', storeIT: 'Lidl IT' },
 { id: 'detergent', name: 'Detersivo lavatrice 1L', nameKey: 'shopping.product.detergent', category: 'casa', categoryKey: 'shopping.cat.home', icon: <Package size={16} />, priceIT: 3.99, priceCH: 8.50, unit: '1L', storeCH: 'Migros', storeIT: 'Carrefour' },
 { id: 'shampoo', name: 'Shampoo 250ml', nameKey: 'shopping.product.shampoo', category: 'casa', categoryKey: 'shopping.cat.home', icon: <Package size={16} />, priceIT: 2.99, priceCH: 5.90, unit: '250ml', storeCH: 'Coop', storeIT: 'Esselunga' },
 { id: 'toilet_paper', name: 'Carta igienica 8 rotoli', nameKey: 'shopping.product.toilet_paper', category: 'casa', categoryKey: 'shopping.cat.home', icon: <Package size={16} />, priceIT: 3.29, priceCH: 7.50, unit: '8 rotoli', storeCH: 'Migros', storeIT: 'Lidl IT' },
 { id: 'diapers', name: 'Pannolini 30 pz', nameKey: 'shopping.product.diapers', category: 'bambini', categoryKey: 'shopping.cat.baby', icon: <Baby size={16} />, priceIT: 7.99, priceCH: 17.90, unit: '30pz', storeCH: 'Coop', storeIT: 'Carrefour' },
 { id: 'gasoline', name: 'Benzina (al litro)', nameKey: 'shopping.product.gasoline', category: 'carburante', categoryKey: 'shopping.cat.fuel', icon: <Fuel size={16} />, priceIT: 1.75, priceCH: 1.85, unit: '1L', storeCH: 'Stazione', storeIT: 'Stazione' },
 { id: 'diesel', name: 'Diesel (al litro)', nameKey: 'shopping.product.diesel', category: 'carburante', categoryKey: 'shopping.cat.fuel', icon: <Fuel size={16} />, priceIT: 1.65, priceCH: 1.95, unit: '1L', storeCH: 'Stazione', storeIT: 'Stazione' },
 { id: 'ibuprofen', name: 'Ibuprofene 400mg 20cpr', nameKey: 'shopping.product.ibuprofen', category: 'farmacia', categoryKey: 'shopping.cat.pharma', icon: <Pill size={16} />, priceIT: 3.99, priceCH: 9.80, unit: '20cpr', storeCH: 'Farmacia', storeIT: 'Farmacia' },
 { id: 'paracetamol', name: 'Paracetamolo 500mg 20cpr', nameKey: 'shopping.product.paracetamol', category: 'farmacia', categoryKey: 'shopping.cat.pharma', icon: <Pill size={16} />, priceIT: 2.49, priceCH: 7.50, unit: '20cpr', storeCH: 'Farmacia', storeIT: 'Farmacia' },
];

const CATEGORIES = ['all', 'alimentari', 'carne', 'bevande', 'casa', 'bambini', 'carburante', 'farmacia'] as const;

type InternalTab = 'calculator' | 'map' | 'zones';

// ── Component ────────────────────────────────────────────────

const ShoppingCalculator: React.FC = () => {
 const { t } = useTranslation();
 const { rate: liveRate, loading: rateLoading } = useExchangeRate();
 const [exchangeRate, setExchangeRate] = useState<number | null>(null);
 const effectiveRate = exchangeRate ?? liveRate;
 const [selectedCategory, setSelectedCategory] = useState<string>('all');
 const [selectedProducts, setSelectedProducts] = useState<Record<string, number>>({});
 const [showOnlySavings, setShowOnlySavings] = useState(false);
 const [activeTab, setActiveTab] = useState<InternalTab>('calculator');

 // Map filters
 const [mapZone, setMapZone] = useState<string>('');
 const [mapChain, setMapChain] = useState<string>('');

 const toggleProduct = (id: string) => {
 setSelectedProducts(prev => {
 const next = { ...prev };
 if (next[id]) { delete next[id]; } else { next[id] = 1; }
 return next;
 });
 Analytics.trackUIInteraction('guida', 'spesa', 'prodotto', 'toggle', id);
 };

 const updateQuantity = (id: string, qty: number) => {
 if (qty <= 0) {
 setSelectedProducts(prev => { const next = { ...prev }; delete next[id]; return next; });
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
 const selectedItems = Object.entries(selectedProducts) as [string, number][];
 for (const [id, qty] of selectedItems) {
 const product = PRODUCTS.find(p => p.id === id);
 if (!product) continue;
 totalIT += product.priceIT * qty;
 totalCH += product.priceCH * qty;
 }
 const totalCHinEUR = totalCH * effectiveRate;
 const savings = totalCHinEUR - totalIT;
 const savingsPercent = totalCHinEUR > 0 ? (savings / totalCHinEUR) * 100 : 0;
 const CUSTOMS_LIMIT_CHF = 300;
 const exceedsCustoms = totalIT / effectiveRate > CUSTOMS_LIMIT_CHF;
 return { totalIT, totalCH, totalCHinEUR, savings, savingsPercent, selectedCount: selectedItems.length, exceedsCustoms, annualSavings: savings * 52 };
 }, [selectedProducts, effectiveRate]);

 const allProductStats = useMemo(() => {
 let totalIT = 0;
 let totalCH = 0;
 for (const p of PRODUCTS) { totalIT += p.priceIT; totalCH += p.priceCH; }
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

 const filteredSupermarkets = useMemo(() => filterSupermarkets({ zone: mapZone || undefined, chain: mapChain || undefined }), [mapZone, mapChain]);

 const chains = useMemo(() => getChains(), []);

 const tabConfig: { id: InternalTab; label: string; icon: React.ReactNode }[] = [
 { id: 'calculator', label: t('shopping.tabCalculator'), icon: <ShoppingCart size={16} /> },
 { id: 'map', label: t('shopping.tabMap'), icon: <MapPin size={16} /> },
 { id: 'zones', label: t('shopping.tabZones'), icon: <BarChart3 size={16} /> },
 ];

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-gradient-to-br from-orange-500 to-red-600 rounded-2xl p-4 sm:p-6 text-white">
 <div className="flex items-center gap-3 mb-3">
 <ShoppingCart size={28} />
 <h2 className="text-2xl font-bold">{t('shopping.title')}</h2>
 </div>
 <p className="text-orange-100">{t('shopping.subtitle')}</p>

 {/* Stats banner */}
 <div className="flex flex-wrap gap-3 mt-4">
 <div className="flex items-center gap-1.5 bg-white/15 rounded-lg px-3 py-1.5 text-sm font-bold">
 <ShoppingCart size={14} /> {PRODUCTS.length} {t('shopping.products')}
 </div>
 <div className="flex items-center gap-1.5 bg-white/15 rounded-lg px-3 py-1.5 text-sm font-bold">
 <MapPin size={14} /> {TOTAL_SUPERMARKETS} {t('shopping.totalSupermarkets')}
 </div>
 <div className="flex items-center gap-1.5 bg-white/15 rounded-lg px-3 py-1.5 text-sm font-bold">
 {'\uD83C\uDDE8\uD83C\uDDED'} {TOTAL_CH} · {'\uD83C\uDDEE\uD83C\uDDF9'} {TOTAL_IT}
 </div>
 </div>

 <div className="mt-3"><DataFreshness lastUpdated="2026-01" source="Rilevamento prezzi" variant="badge" /></div>

 {/* Sub-tabs */}
 <div className="flex gap-1 bg-white/10 rounded-lg p-1 mt-4">
 {tabConfig.map(tab => (
 <button
 key={tab.id}
 onClick={() => { setActiveTab(tab.id); Analytics.trackUIInteraction('guida', 'spesa', 'tab', 'click', tab.id); }}
 className={'flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition ' +
 (activeTab === tab.id
 ? 'bg-surface text-section-confronti shadow'
 : 'text-white/90 hover:text-white hover:bg-white/10')}
 aria-label={tab.label}
 >
 {tab.icon}
 <span className="hidden sm:inline">{tab.label}</span>
 </button>
 ))}
 </div>
 </div>

 {/* ══════════════ CALCULATOR TAB ══════════════ */}
 {activeTab === 'calculator' && (
 <>
 {/* Exchange Rate + Summary */}
 <div className="grid md:grid-cols-3 gap-4">
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <label htmlFor="shopping-rate" className="text-xs font-bold text-muted uppercase tracking-wide flex items-center gap-2">
 {t('shopping.exchangeRate')}
 {rateLoading && <RefreshCw size={12} className="animate-spin text-orange-500" />}
 </label>
 <input
 id="shopping-rate"
 type="number"
 inputMode="decimal"
 step="0.01"
 value={effectiveRate}
 onChange={e => setExchangeRate(parseFloat(e.target.value) || null)}
 className="w-full mt-1 px-3 py-2 rounded-lg border border-edge bg-surface-alt text-lg font-bold text-heading"
 />
 <p className="text-sm text-muted mt-1">1 CHF = {effectiveRate.toFixed(4)} EUR</p>
 </div>
 <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
 <div><span className="text-muted">{t('shopping.avgSavings')}:</span>{' '}<span className="font-semibold text-success">{allProductStats.savingsPercent.toFixed(0)}%</span>{' '}<span className="text-muted">{t('shopping.buyingInItaly')}</span></div>
 {stats.selectedCount > 0 && (
 <div><span className="text-muted">{t('shopping.yourSavings')}:</span>{' '}<span className="font-semibold text-link">{'\u20AC'} {stats.savings.toFixed(2)}</span>{' '}<span className="text-muted">{t('shopping.perTrip')} ({stats.selectedCount} {t('shopping.products')})</span></div>
 )}
 </div>
 </div>

 {/* Customs Warning */}
 <div className="bg-warning-subtle border-l-4 border-warning p-4 rounded-lg">
 <div className="flex items-start gap-3">
 <AlertCircle className="text-warning flex-shrink-0 mt-0.5" size={20} />
 <div className="text-sm text-warning">
 <p className="font-bold mb-1">{t('shopping.customsTitle')}</p>
 <p>{t('shopping.customsDesc')}</p>
 </div>
 </div>
 </div>

 {/* Filters */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <div className="flex flex-wrap gap-2 items-center justify-between">
 <div className="flex flex-wrap gap-2">
 {CATEGORIES.map(cat => (
 <button
 key={cat}
 onClick={() => { setSelectedCategory(cat); Analytics.trackUIInteraction('guida', 'spesa', 'filtro_categoria', 'click', cat); }}
 className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
 selectedCategory === cat
 ? 'bg-orange-600 text-white'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 aria-label={t(`shopping.cat.${cat === 'all' ? 'all' : cat === 'alimentari' ? 'food' : cat === 'carne' ? 'meat' : cat === 'bevande' ? 'drinks' : cat === 'casa' ? 'home' : cat === 'bambini' ? 'baby' : cat === 'carburante' ? 'fuel' : 'pharma'}`)}
 >
 {t(`shopping.cat.${cat === 'all' ? 'all' : cat === 'alimentari' ? 'food' : cat === 'carne' ? 'meat' : cat === 'bevande' ? 'drinks' : cat === 'casa' ? 'home' : cat === 'bambini' ? 'baby' : cat === 'carburante' ? 'fuel' : 'pharma'}`)}
 </button>
 ))}
 </div>
 <div className="flex gap-2 items-center">
 <label className="flex items-center gap-2 cursor-pointer text-sm">
 <input type="checkbox" checked={showOnlySavings} onChange={e => setShowOnlySavings(e.target.checked)} className="w-4 h-4" aria-label={t('shopping.onlySavings')} />
 <span className="font-bold text-body">{t('shopping.onlySavings')}</span>
 </label>
 <button onClick={selectAll} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-accent-subtle text-accent hover:bg-accent-subtle" aria-label={t('shopping.selectAll')}>
 {t('shopping.selectAll')}
 </button>
 <button onClick={clearAll} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-surface-raised text-subtle hover:bg-surface-raised" aria-label={t('shopping.clearAll')}>
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
 className={`bg-surface rounded-xl p-4 border-2 transition-[color,background-color,border-color,box-shadow] cursor-pointer ${
 isSelected
 ? 'border-orange-500 ring-2 ring-orange-500/20 shadow-lg'
 : 'border-edge hover:border-edge'
 }`}
 >
 <div className="flex items-start justify-between gap-2 mb-3">
 <div className="flex items-center gap-2">
 <span className="text-orange-500">{product.icon}</span>
 <div>
 <div className="font-bold text-sm text-strong">{product.name}</div>
 <div className="text-xs text-muted">{product.unit}</div>
 </div>
 </div>
 {saving > 0 && (
 <span className="px-2 py-0.5 bg-success-subtle text-success text-xs font-bold rounded-full whitespace-nowrap">
 -{savingPercent.toFixed(0)}%
 </span>
 )}
 </div>
 <div className="flex items-center justify-between gap-2 text-sm">
 <div className="text-center">
 <div className="text-xs text-muted uppercase">{'\uD83C\uDDEE\uD83C\uDDF9'} {product.storeIT}</div>
 <div className="font-bold text-success text-lg">{'\u20AC'} {product.priceIT.toFixed(2)}</div>
 </div>
 <ArrowRight size={14} className="text-muted" />
 <div className="text-center">
 <div className="text-xs text-muted uppercase">{'\uD83C\uDDE8\uD83C\uDDED'} {product.storeCH}</div>
 <div className="font-bold text-danger text-lg">{product.priceCH.toFixed(2)} CHF</div>
 <div className="text-xs text-muted">{'\u2248'} {'\u20AC'} {priceCHinEUR.toFixed(2)}</div>
 </div>
 </div>
 {isSelected && (
 <div className="mt-3 flex items-center justify-center gap-3 border-t border-edge pt-3" onClick={e => e.stopPropagation()}>
 <button onClick={() => updateQuantity(product.id, qty - 1)} className="w-8 h-8 rounded-full bg-surface-raised font-bold text-lg flex items-center justify-center hover:bg-danger-subtle text-heading" aria-label="Decrease quantity">-</button>
 <span className="text-lg font-bold w-8 text-center text-heading">{qty}</span>
 <button onClick={() => updateQuantity(product.id, qty + 1)} className="w-8 h-8 rounded-full bg-surface-raised font-bold text-lg flex items-center justify-center hover:bg-success-subtle text-heading" aria-label="Increase quantity">+</button>
 </div>
 )}
 </div>
 );
 })}
 </div>

 {/* Cart Summary */}
 {stats.selectedCount > 0 && (
 <div className="bg-gradient-to-br from-surface-inverted to-surface-inverted rounded-2xl p-4 sm:p-6 text-white">
 <h4 className="font-bold text-lg mb-4 flex items-center gap-2">
 <ShoppingCart size={20} /> {t('shopping.cartSummary')}
 </h4>
 <div className="grid md:grid-cols-4 gap-4">
 <div className="bg-white/10 rounded-xl p-4">
 <div className="text-xs uppercase tracking-wider text-white/90">{'\uD83C\uDDEE\uD83C\uDDF9'} {t('shopping.totalItaly')}</div>
 <div className="text-2xl font-bold">{'\u20AC'} {stats.totalIT.toFixed(2)}</div>
 </div>
 <div className="bg-white/10 rounded-xl p-4">
 <div className="text-xs uppercase tracking-wider text-white/90">{'\uD83C\uDDE8\uD83C\uDDED'} {t('shopping.totalSwitzerland')}</div>
 <div className="text-2xl font-bold">{stats.totalCH.toFixed(2)} CHF</div>
 <div className="text-xs text-white/80">{'\u2248'} {'\u20AC'} {stats.totalCHinEUR.toFixed(2)}</div>
 </div>
 <div className={`rounded-xl p-4 ${stats.savings > 0 ? 'bg-emerald-500/30' : 'bg-red-500/30'}`}>
 <div className="text-xs uppercase tracking-wider text-white/90">{t('shopping.savings')}</div>
 <div className="text-2xl font-bold">{'\u20AC'} {stats.savings.toFixed(2)}</div>
 <div className="text-xs text-white/90">{stats.savingsPercent.toFixed(0)}% {stats.savings > 0 ? t('shopping.cheaper') : t('shopping.moreExpensive')}</div>
 </div>
 <div className="bg-amber-500/30 rounded-xl p-4">
 <div className="text-xs uppercase tracking-wider text-white/90">{t('shopping.annualSavings')}</div>
 <div className="text-2xl font-bold">{'\u20AC'} {stats.annualSavings.toFixed(0)}</div>
 <div className="text-xs text-white/90">{t('shopping.weeklyTrips')}</div>
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
 </>
 )}

 {/* ══════════════ MAP TAB ══════════════ */}
 {activeTab === 'map' && (
 <>
 {/* Map filters */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <div className="flex flex-wrap gap-4 items-end">
 <div className="flex-1 min-w-[180px]">
 <label htmlFor="map-zone" className="block text-sm font-medium text-body mb-1">{t('shopping.filterZone')}</label>
 <select
 id="map-zone"
 value={mapZone}
 onChange={e => setMapZone(e.target.value)}
 className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-heading"
 >
 <option value="">{t('shopping.allZones')}</option>
 {ZONES.map(z => (
 <option key={z.id} value={z.id}>{z.label}</option>
 ))}
 </select>
 </div>
 <div className="flex-1 min-w-[180px]">
 <label htmlFor="map-chain" className="block text-sm font-medium text-body mb-1">{t('shopping.filterChain')}</label>
 <select
 id="map-chain"
 value={mapChain}
 onChange={e => setMapChain(e.target.value)}
 className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-heading"
 >
 <option value="">{t('shopping.allChains')}</option>
 {chains.map(c => (
 <option key={c} value={c}>{c}</option>
 ))}
 </select>
 </div>
 <div className="text-sm text-subtle">
 {filteredSupermarkets.length} / {TOTAL_SUPERMARKETS} {t('shopping.totalSupermarkets')}
 </div>
 </div>
 </div>

 {/* Map */}
 <div className="bg-surface rounded-xl shadow overflow-hidden" style={{ minHeight: 480 }}>
 <Suspense
 fallback={
 <div className="flex items-center justify-center h-[480px]">
 <div className="animate-spin rounded-full h-8 w-8 border-2 border-orange-500 border-t-transparent" />
 </div>
 }
 >
 <SupermarketMap supermarkets={filteredSupermarkets} />
 </Suspense>
 </div>

 {/* Supermarket list */}
 <div className="bg-surface rounded-xl shadow p-5">
 <h3 className="text-lg font-bold text-heading mb-4 flex items-center gap-2">
 <MapPin className="text-warning" size={20} />
 {t('shopping.mapTitle')}
 </h3>
 <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
 {filteredSupermarkets.map(s => (
 <div key={s.id} className="flex items-center gap-3 p-3 bg-surface-alt rounded-lg border border-edge">
 <div
 className="w-3 h-3 rounded-full flex-shrink-0"
 style={{ backgroundColor: CHAIN_COLORS[s.chain] || '#94a3b8' }}
 />
 <div className="min-w-0">
 <div className="font-bold text-sm text-heading truncate">{s.name}</div>
 <div className="text-xs text-muted truncate">{s.address}, {s.city}</div>
 </div>
 <span className="ml-auto text-xs flex-shrink-0">
 {s.country === 'CH' ? '\uD83C\uDDE8\uD83C\uDDED' : '\uD83C\uDDEE\uD83C\uDDF9'}
 </span>
 </div>
 ))}
 </div>
 </div>
 </>
 )}

 {/* ══════════════ ZONES / CONVENIENCE INDEX TAB ══════════════ */}
 {activeTab === 'zones' && (
 <>
 <div className="bg-surface rounded-xl shadow p-6">
 <div className="flex items-center gap-3 mb-2">
 <BarChart3 className="text-warning" size={24} />
 <h3 className="text-lg font-bold text-heading">{t('shopping.zoneIndex')}</h3>
 </div>
 <p className="text-sm text-subtle mb-6">{t('shopping.zoneIndexDesc')}</p>

 <div className="space-y-4">
 {ZONE_CONVENIENCE.map((zc, idx) => {
 const zone = ZONES.find(z => z.id === zc.zoneId);
 const trafficColors = { low: 'text-success bg-success-subtle', medium: 'text-warning bg-warning-subtle', high: 'text-danger bg-danger-subtle' };
 const barWidth = (zc.savingsPercent / 50) * 100;
 const netWidth = (zc.netConvenience / 100) * 100;
 return (
 <div key={zc.zoneId} className="bg-surface-alt rounded-xl p-5 border border-edge">
 <div className="flex items-start justify-between gap-3 mb-4">
 <div>
 <div className="flex items-center gap-2">
 {idx === 0 && <span className="text-xs px-2 py-0.5 bg-warning-subtle text-warning rounded-full font-bold">{t('shopping.bestZone')}</span>}
 <h4 className="font-bold text-heading">{zone?.label || zc.zoneId}</h4>
 </div>
 <div className="flex flex-wrap gap-2 mt-2">
 <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${trafficColors[zc.trafficLevel]}`}>
 {t(`shopping.traffic${zc.trafficLevel.charAt(0).toUpperCase() + zc.trafficLevel.slice(1)}`)}
 </span>
 <span className="text-sm text-muted flex items-center gap-1">
 <Navigation size={10} /> {zc.distanceToIT} km
 </span>
 </div>
 </div>
 <div className="text-right">
 <div className="text-2xl font-bold text-warning">{'\u20AC'} {zc.netConvenience.toFixed(0)}</div>
 <div className="text-xs text-muted">{t('shopping.perWeeklyTrip')}</div>
 </div>
 </div>

 {/* Visual bars */}
 <div className="space-y-3">
 <div>
 <div className="flex justify-between text-xs text-subtle mb-1">
 <span>{t('shopping.savingsOnBasket')}</span>
 <span className="font-bold text-success">-{zc.savingsPercent}%</span>
 </div>
 <div className="h-3 bg-surface-raised rounded-full overflow-hidden">
 <div className="h-full bg-emerald-500 rounded-full transition-transform duration-300" style={{ width: '100%', transform: `scaleX(${Math.min(barWidth, 100) / 100})`, transformOrigin: 'left' }} />
 </div>
 </div>
 <div className="grid grid-cols-2 gap-4 text-sm">
 <div>
 <span className="text-muted text-xs">{t('shopping.fuelCost')}</span>
 <div className="font-bold text-body">{'\u20AC'} {zc.fuelCostEUR.toFixed(2)}</div>
 </div>
 <div>
 <span className="text-muted text-xs">{t('shopping.netConvenience')}</span>
 <div className="font-bold text-warning">{'\u20AC'} {zc.netConvenience.toFixed(0)}</div>
 <div className="h-2 bg-surface-raised rounded-full overflow-hidden mt-1">
 <div className="h-full bg-orange-500 rounded-full" style={{ width: `${Math.min(netWidth, 100)}%` }} />
 </div>
 </div>
 </div>
 </div>

 {/* Supermarket counts for this zone */}
 <div className="mt-3 pt-3 border-t border-edge flex flex-wrap gap-2 text-xs">
 {(() => {
 const zoneStores = SUPERMARKETS.filter(s => s.zone === zc.zoneId);
 const chCount = zoneStores.filter(s => s.country === 'CH').length;
 const itCount = zoneStores.filter(s => s.country === 'IT').length;
 return (
 <>
 <span className="text-muted">
 {'\uD83C\uDDE8\uD83C\uDDED'} {chCount} {t('shopping.supermarketsCH')}
 </span>
 <span className="text-muted">
 {'\uD83C\uDDEE\uD83C\uDDF9'} {itCount} {t('shopping.supermarketsIT')}
 </span>
 </>
 );
 })()}
 </div>
 </div>
 );
 })}
 </div>
 </div>
 </>
 )}

 {/* ── Methodology (always visible — SEO content) ── */}
 <div className="bg-surface rounded-xl shadow p-6">
 <div className="flex items-center gap-2 mb-3">
 <BookOpen className="text-subtle" size={20} />
 <h3 className="text-lg font-bold text-heading">{t('shopping.methodology')}</h3>
 </div>
 <div className="text-sm text-subtle space-y-3">
 <p>{t('shopping.methodologyText1')}</p>
 <p>{t('shopping.methodologyText2')}</p>
 </div>
 </div>

 {/* ── FAQ section (SEO content) ── */}
 <div className="bg-surface rounded-xl shadow p-6">
 <div className="flex items-center gap-2 mb-4">
 <Info className="text-link" size={20} />
 <h3 className="text-lg font-bold text-heading">{t('shopping.faqTitle')}</h3>
 </div>
 <div className="space-y-4">
 {[1, 2, 3, 4, 5].map(n => (
 <details key={n} className="group border border-edge rounded-lg">
 <summary className="flex items-center justify-between p-4 cursor-pointer text-sm font-semibold text-heading hover:bg-surface-raised/30 rounded-lg">
 {t(`shopping.faq${n}Q`)}
 <ChevronDown size={16} className="text-muted group-open:rotate-180 transition-transform" />
 </summary>
 <div className="px-4 pb-4 text-sm text-subtle">{t(`shopping.faq${n}A`)}</div>
 </details>
 ))}
 </div>
 </div>

 {/* Supermarket Links + Disclaimer */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <h4 className="font-bold text-sm text-body mb-3 flex items-center gap-2">
 <Info size={14} /> {t('shopping.sourcesTitle')}
 </h4>
 <div className="flex flex-wrap gap-2 text-xs">
 {[
 { name: 'Esselunga', url: 'https://www.esselunga.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'Carrefour', url: 'https://www.carrefour.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'Lidl IT', url: 'https://www.lidl.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'Iper', url: 'https://www.iper.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'Tigros', url: 'https://www.tigros.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'Eurospin', url: 'https://www.eurospin.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'Conad', url: 'https://www.conad.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'MD', url: 'https://www.mdspa.it', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
 { name: 'Migros', url: 'https://www.migros.ch', flag: '\uD83C\uDDE8\uD83C\uDDED' },
 { name: 'Coop CH', url: 'https://www.coop.ch', flag: '\uD83C\uDDE8\uD83C\uDDED' },
 { name: 'Aldi CH', url: 'https://www.aldi.ch', flag: '\uD83C\uDDE8\uD83C\uDDED' },
 { name: 'Lidl CH', url: 'https://www.lidl.ch', flag: '\uD83C\uDDE8\uD83C\uDDED' },
 { name: 'Denner', url: 'https://www.denner.ch', flag: '\uD83C\uDDE8\uD83C\uDDED' },
 ].map(store => (
 <a key={store.name} href={store.url} target="_blank" rel="noopener noreferrer"
 className="px-3 py-1.5 bg-surface-raised rounded-lg hover:bg-warning-subtle transition-colors font-bold text-body">
 {store.flag} {store.name}
 </a>
 ))}
 </div>
 <p className="text-sm text-muted mt-2">{t('shopping.disclaimer')}</p>
 </div>
 <Suspense fallback={null}><RelatedTools context="comparison" /></Suspense>
 </div>
 );
};

export default ShoppingCalculator;
