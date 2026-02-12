import React, { useEffect, useState } from 'react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  Legend, PieChart, Pie, Cell, BarChart, Bar, LineChart, Line
} from 'recharts';
import { TrendingUp, Users, Map, Briefcase, Info, ExternalLink, Loader2, AlertTriangle, Database, WifiOff, PersonStanding, CalendarClock, ArrowUpRight, ArrowDownRight, RefreshCw, BarChart2, Layers } from 'lucide-react';

// --- API CONFIGURATION ---
const BFS_MASTER_FILE_URL = "https://dam-api.bfs.admin.ch/hub/api/dam/assets/36198674/master";
const SOURCE_LINK = "https://www.bfs.admin.ch/asset/it/px-x-0302010000_108";
const CACHE_KEY = "bfs_stats_cache";

// --- PX FILE PARSER & HELPERS ---

interface PXData {
    dimensions: string[];
    values: Record<string, string[]>;
    data: number[];
    dimensionMap: Record<string, number>;
}

const parsePXFile = (raw: string): PXData | null => {
    try {
      const getValues = (key: string) => {
        const regexQuoted = new RegExp(`VALUES\\(["']?${key}["']?\\)=([^;]+?);`, 's');
        let match = raw.match(regexQuoted);
        if (!match) {
          const regexSimple = new RegExp(`VALUES\\(${key.replace(/"/g, '\\"')}\\)=([^;]+?);`, 's');
          match = raw.match(regexSimple);
        }
        if (!match) return [];
        
        const valStr = match[1].replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        return valStr.split(',').map(s => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
      };

      const getKeyword = (key: string) => {
        const regex = new RegExp(`${key}=([^;]+?);`, 's');
        const match = raw.match(regex);
        return match ? match[1].replace(/[\r\n\t\s]+/g, '').replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) : [];
      };

      const stub = getKeyword("STUB");
      const heading = getKeyword("HEADING");
      const dimensionNames = [...stub, ...heading];
      
      if (dimensionNames.length === 0) return null;

      const dimensionMap: Record<string, number> = {};
      const values: Record<string, string[]> = {};
      dimensionNames.forEach((dim, idx) => {
        dimensionMap[dim] = idx;
        values[dim] = getValues(dim);
      });

      const dataMatch = raw.match(/DATA=([^;]+);/s);
      if (!dataMatch) return null;
      
      const dataString = dataMatch[1].replace(/[\s\r\n]+/g, ' ').trim();
      const data = dataString.split(' ').map(v => {
        if (v === '"."' || v === '.') return 0;
        const num = parseFloat(v);
        return isNaN(num) ? 0 : num;
      });

      return { dimensions: dimensionNames, values, data, dimensionMap };
    } catch (e) {
        console.error("PX Parsing Error", e);
        return null;
    }
};

const findDimKey = (px: PXData, ...candidates: string[]): string | undefined => {
    return px.dimensions.find(d => candidates.some(c => d.toLowerCase().includes(c.toLowerCase())));
};

const findValueKey = (px: PXData, dimName: string, ...candidates: string[]): string => {
    if (!dimName || !px.values[dimName]) return px.values[dimName]?.[0] || '';
    const values = px.values[dimName];
    
    const isLookingForTotal = candidates.some(c => c === '0' || c.toLowerCase().includes('total'));
    if (isLookingForTotal) {
        const totalCandidates = ['Total', 'Totale', 'totale', 'total', 'Total '];
        for (const t of totalCandidates) {
          const totalMatch = values.find(v => v.includes(t));
          if (totalMatch) return totalMatch;
        }
        const codeTotal = values.find(v => v.startsWith('0 '));
        if (codeTotal) return codeTotal;
    }
    
    for (const c of candidates) {
        const match = values.find(v => v === c || v.startsWith(c + ' '));
        if (match) return match;
    }

    for (const c of candidates) {
        const match = values.find(v => v.toLowerCase().includes(c.toLowerCase()));
        if (match) return match;
    }

    return values[0];
};

const getDataValue = (px: PXData, criteria: Record<string, string>): number => {
    let index = 0;
    let stride = 1;
    
    for (let i = px.dimensions.length - 1; i >= 0; i--) {
        const dimName = px.dimensions[i];
        const dimValues = px.values[dimName] || [];
        const targetVal = criteria[dimName];
        
        let valIndex = 0; 
        if (targetVal) {
           valIndex = dimValues.indexOf(targetVal);
           if (valIndex === -1) valIndex = 0; 
        }
        index += valIndex * stride;
        stride *= dimValues.length;
    }
    return px.data[index] || 0;
};

// --- DATA EXTRACTORS ---

const extractTrend = (px: PXData) => {
    const timeDim = findDimKey(px, "Quartal", "Trimestre", "Time");
    const cantonDim = findDimKey(px, "Kanton", "Cantone", "Region", "Arbeitskanton");
    const sexDim = findDimKey(px, "Geschlecht", "Sesso");
    const sectorDim = findDimKey(px, "Wirtschaftssektor", "Sezione", "Settore");
    const ageDim = findDimKey(px, "Altersklasse", "Classe", "Età");

    if (!timeDim) return [];

    const quarters = px.values[timeDim];
    const result = [];

    const cantonVal = findValueKey(px, cantonDim || "", "21", "Ticino");
    const sexVal = findValueKey(px, sexDim || "", "Total", "0", "Totale");
    const sectorVal = findValueKey(px, sectorDim || "", "Total", "0", "Totale");
    const ageVal = findValueKey(px, ageDim || "", "Total", "0", "Totale");

    const criteria: Record<string, string> = {
        [cantonDim || "Kanton"]: cantonVal,
        [sexDim || "Geschlecht"]: sexVal,
        [sectorDim || "Wirtschaftssektor"]: sectorVal,
        [ageDim || "Altersklasse"]: ageVal
    };
    
    for (const q of quarters) {
        criteria[timeDim] = q;
        const val = getDataValue(px, criteria);
        
        let label = q;
        const qMatch = q.match(/(\d{4})[Q](\d)/);
        if (qMatch) label = `${qMatch[1]} Q${qMatch[2]}`;

        result.push({ year: label, frontalieri: val });
    }

    return result.slice(-16);
};

const extractAgeDistribution = (px: PXData) => {
    const ageDim = findDimKey(px, "Altersklasse", "Classe", "Età");
    const timeDim = findDimKey(px, "Quartal", "Trimestre");
    const cantonDim = findDimKey(px, "Kanton", "Cantone", "Arbeitskanton");
    const sexDim = findDimKey(px, "Geschlecht", "Sesso");
    const sectorDim = findDimKey(px, "Wirtschaftssektor", "Sezione", "Settore");

    if (!ageDim || !timeDim) return [];

    const latestQuarter = px.values[timeDim][px.values[timeDim].length - 1];
    const cantonVal = findValueKey(px, cantonDim || "", "21", "Ticino");
    const sexVal = findValueKey(px, sexDim || "", "Total", "0");
    const sectorVal = findValueKey(px, sectorDim || "", "Total", "0");

    // Filter valid age groups (exclude Total)
    const validAges = px.values[ageDim].filter(a => !a.toLowerCase().includes('total') && !a.startsWith('0'));

    const result = validAges.map(age => {
        const criteria = {
            [cantonDim || "Kanton"]: cantonVal,
            [sexDim || "Geschlecht"]: sexVal,
            [sectorDim || "Wirtschaftssektor"]: sectorVal,
            [timeDim]: latestQuarter,
            [ageDim]: age
        };
        return { 
            name: age.replace(' anni', '').replace('Jahre', ''), 
            value: getDataValue(px, criteria) 
        };
    });

    return result.sort((a, b) => b.value - a.value);
};

const extractGenderTrend = (px: PXData) => {
    const sexDim = findDimKey(px, "Geschlecht", "Sesso");
    const timeDim = findDimKey(px, "Quartal", "Trimestre");
    const cantonDim = findDimKey(px, "Kanton", "Cantone", "Arbeitskanton");
    const sectorDim = findDimKey(px, "Wirtschaftssektor", "Sezione", "Settore");
    const ageDim = findDimKey(px, "Altersklasse", "Classe", "Età");

    if (!sexDim || !timeDim) return [];

    const quarters = px.values[timeDim].slice(-16); // Last 4 years
    const cantonVal = findValueKey(px, cantonDim || "", "21", "Ticino");
    const sectorVal = findValueKey(px, sectorDim || "", "Total", "0");
    const ageVal = findValueKey(px, ageDim || "", "Total", "0");

    // Find keys for Male and Female
    const allSexes = px.values[sexDim];
    const maleKey = allSexes.find(s => s.startsWith('1') || s.toLowerCase().includes('uomi') || s.toLowerCase().includes('mann'));
    const femaleKey = allSexes.find(s => s.startsWith('2') || s.toLowerCase().includes('donne') || s.toLowerCase().includes('frau'));

    if (!maleKey || !femaleKey) return [];

    return quarters.map(q => {
        let label = q;
        const qMatch = q.match(/(\d{4})[Q](\d)/);
        if (qMatch) label = `${qMatch[1]} Q${qMatch[2]}`;

        const point: any = { year: label };
        
        // Male
        point['Uomini'] = getDataValue(px, {
            [cantonDim || "Kanton"]: cantonVal,
            [sexDim]: maleKey,
            [ageDim || "Altersklasse"]: ageVal,
            [timeDim]: q,
            [sectorDim || "Wirtschaftssektor"]: sectorVal
        });

        // Female
        point['Donne'] = getDataValue(px, {
            [cantonDim || "Kanton"]: cantonVal,
            [sexDim]: femaleKey,
            [ageDim || "Altersklasse"]: ageVal,
            [timeDim]: q,
            [sectorDim || "Wirtschaftssektor"]: sectorVal
        });

        return point;
    });
};

const extractGenderSnapshot = (px: PXData) => {
    const sexDim = findDimKey(px, "Geschlecht", "Sesso");
    const timeDim = findDimKey(px, "Quartal", "Trimestre");
    const cantonDim = findDimKey(px, "Kanton", "Cantone", "Arbeitskanton");
    const sectorDim = findDimKey(px, "Wirtschaftssektor", "Sezione", "Settore");
    const ageDim = findDimKey(px, "Altersklasse", "Classe");

    if (!sexDim || !timeDim) return [];

    const latestQuarter = px.values[timeDim][px.values[timeDim].length - 1];
    const cantonVal = findValueKey(px, cantonDim || "", "21", "Ticino");
    const sectorVal = findValueKey(px, sectorDim || "", "Total", "0");
    const ageVal = findValueKey(px, ageDim || "", "Total", "0");
    
    const validSexes = px.values[sexDim].filter(v => !v.startsWith("0") && !v.toLowerCase().includes("total"));

    const result = validSexes.map(sexVal => {
        const criteria: Record<string, string> = {
            [cantonDim || "Kanton"]: cantonVal,
            [sectorDim || "Wirtschaftssektor"]: sectorVal,
            [ageDim || "Altersklasse"]: ageVal,
            [timeDim]: latestQuarter,
            [sexDim]: sexVal
        };
        
        let name = sexVal;
        if (name.includes("1") || name.toLowerCase().includes("uomi") || name.toLowerCase().includes("mann")) name = "Uomini";
        if (name.includes("2") || name.toLowerCase().includes("donn") || name.toLowerCase().includes("frau")) name = "Donne";

        return { 
            name: name, 
            value: getDataValue(px, criteria), 
            color: name === "Uomini" ? "#3b82f6" : "#ec4899" 
        };
    }).sort((a, b) => b.value - a.value);

    // Calculate percentages
    const total = result.reduce((sum, item) => sum + item.value, 0);
    return result.map(item => ({
        ...item,
        percent: total > 0 ? (item.value / total * 100).toFixed(1) : "0"
    }));
}

export const StatsView: React.FC = () => {
  const [historicalData, setHistoricalData] = useState<any[]>([]);
  const [ageData, setAgeData] = useState<any[]>([]);
  const [genderTrendData, setGenderTrendData] = useState<any[]>([]);
  const [genderData, setGenderData] = useState<any[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [usingRealData, setUsingRealData] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchBFSData = async (forceRefresh = false) => {
    try {
      setLoading(true);
      setApiError(null);
      
      // 1. Check LocalStorage Cache
      if (!forceRefresh) {
          const cached = localStorage.getItem(CACHE_KEY);
          if (cached) {
              try {
                  const parsed = JSON.parse(cached);
                  // Ensure we have the new field genderTrend, otherwise re-fetch
                  if (parsed.trend && parsed.ages && parsed.genderTrend) {
                      console.log("📊 BFS Data loaded from Local Cache");
                      setHistoricalData(parsed.trend);
                      setAgeData(parsed.ages);
                      setGenderTrendData(parsed.genderTrend);
                      setGenderData(parsed.gender);
                      setUsingRealData(true);
                      setLastUpdated(new Date(parsed.timestamp));
                      setLoading(false);
                      return;
                  }
              } catch (e) {
                  localStorage.removeItem(CACHE_KEY);
              }
          }
      }

      // 2. Fetch Remote
      const response = await fetch(BFS_MASTER_FILE_URL);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const buffer = await response.arrayBuffer();
      const decoder = new TextDecoder('iso-8859-1');
      const text = decoder.decode(buffer);

      const pxData = parsePXFile(text);
      
      if (pxData) {
          console.group("📊 BFS Data Extraction");
          
          const trend = extractTrend(pxData);
          setHistoricalData(trend);
          
          const ages = extractAgeDistribution(pxData);
          setAgeData(ages);
          
          const genderTrend = extractGenderTrend(pxData);
          setGenderTrendData(genderTrend);

          const genders = extractGenderSnapshot(pxData);
          setGenderData(genders);
          
          console.groupEnd();

          // Save to Cache
          const cachePayload = {
              timestamp: Date.now(),
              trend,
              ages,
              genderTrend,
              gender: genders
          };
          localStorage.setItem(CACHE_KEY, JSON.stringify(cachePayload));
          setLastUpdated(new Date());

          setUsingRealData(true);
      } else {
          throw new Error("Impossibile analizzare il file PX");
      }

    } catch (error: any) {
      console.error("BFS Fetch Error:", error);
      setApiError(error.message || "Errore scaricamento dati BFS");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBFSData(false);
  }, []);

  // --- KPI CALCULATIONS ---
  const latestValue = historicalData.length > 0 ? historicalData[historicalData.length - 1].frontalieri : 0;
  const prevValue = historicalData.length > 1 ? historicalData[historicalData.length - 2].frontalieri : 0;
  const qoqPercent = prevValue > 0 ? (((latestValue - prevValue) / prevValue) * 100).toFixed(1) : "0.0";
  const malePercent = genderData.find(g => g.name === 'Uomini')?.percent || "0";

  return (
    <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-3xl shadow-xl border border-white/60 dark:border-slate-800 flex flex-col h-full animate-fade-in-up transition-colors duration-300 pb-8">
       {/* Header */}
       <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center sticky top-0 z-10 bg-white/50 dark:bg-slate-900/50 backdrop-blur-md rounded-t-3xl">
          <div>
            <h2 className="text-xl font-extrabold text-slate-800 dark:text-slate-100 tracking-tight flex items-center gap-2">
              <Database size={20} className="text-indigo-500"/> Osservatorio Dati Reali
            </h2>
            <p className="text-slate-500 dark:text-slate-400 text-xs mt-1">
              Fonte ufficiale: Ufficio Federale di Statistica (BFS) • <i>Frontalieri (STAF)</i>
            </p>
          </div>
          
          {usingRealData && (
            <button 
                onClick={() => fetchBFSData(true)}
                disabled={loading}
                className="p-2 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-100 dark:border-slate-700 text-slate-400 hover:text-indigo-500 transition-all hover:rotate-180 disabled:opacity-50"
                title="Aggiorna Dati"
            >
                <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </button>
          )}
      </div>

      <div className="p-6 space-y-8">
        
        {/* KPI Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-blue-50/50 dark:bg-blue-900/20 p-4 rounded-2xl border border-blue-100 dark:border-blue-800 group relative">
               <p className="text-[10px] font-bold text-blue-500 uppercase flex items-center gap-1">
                 Totale Frontalieri
                 <Info size={12} className="text-blue-400 cursor-help" />
               </p>
               <p className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 mt-1">
                 {loading ? <Loader2 className="animate-spin h-6 w-6"/> : (latestValue / 1000).toFixed(1) + 'k'}
               </p>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">Numero totale di frontalieri</p>
                   <p className="text-slate-300">Lavoratori italiani con permesso G che lavorano in Svizzera e rientrano in Italia quotidianamente. Dati aggiornati dall'Ufficio Federale di Statistica (BFS).</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
            <div className={`p-4 rounded-2xl border group relative ${Number(qoqPercent) >= 0 ? 'bg-emerald-50/50 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800' : 'bg-red-50/50 border-red-100'}`}>
               <p className={`text-[10px] font-bold uppercase flex items-center gap-1 ${Number(qoqPercent) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                 Trend Trimestrale
                 <Info size={12} className={`cursor-help ${Number(qoqPercent) >= 0 ? 'text-emerald-400' : 'text-red-400'}`} />
               </p>
               <div className="flex items-center gap-2 mt-1">
                 <p className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{qoqPercent}%</p>
                 {Number(qoqPercent) >= 0 ? <TrendingUp size={18} className="text-emerald-500"/> : <TrendingUp size={18} className="text-red-500 rotate-180"/>}
               </div>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">Crescita trimestrale</p>
                   <p className="text-slate-300">Variazione percentuale del numero di frontalieri rispetto al trimestre precedente. Un valore positivo indica crescita, negativo indica calo.</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
            <div className="bg-indigo-50/50 dark:bg-indigo-900/20 p-4 rounded-2xl border border-indigo-100 dark:border-indigo-800 group relative">
               <p className="text-[10px] font-bold text-indigo-500 uppercase flex items-center gap-1">
                 Permessi (Stimati)
                 <Info size={12} className="text-indigo-400 cursor-help" />
               </p>
               <p className="text-lg font-extrabold text-slate-800 dark:text-slate-100 mt-2 truncate">G (5 Anni)</p>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">Tipo di permesso</p>
                   <p className="text-slate-300">Il permesso G (frontaliere) ha validità di 5 anni e consente di lavorare in Svizzera pur mantenendo la residenza in Italia. Deve essere rinnovato alla scadenza.</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
            <div className="bg-purple-50/50 dark:bg-purple-900/20 p-4 rounded-2xl border border-purple-100 dark:border-purple-800 group relative">
               <p className="text-[10px] font-bold text-purple-500 uppercase flex items-center gap-1">
                 Uomini vs Donne
                 <Info size={12} className="text-purple-400 cursor-help" />
               </p>
               <div className="flex items-end gap-1 mt-1">
                  <p className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{malePercent}%</p>
                  <span className="text-xs text-slate-400 mb-1">M</span>
               </div>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">Distribuzione di genere</p>
                   <p className="text-slate-300">Percentuale di lavoratori frontalieri di sesso maschile. La restante percentuale rappresenta le donne frontaliere. Dati basati sulle statistiche BFS.</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
        </div>

        {/* Chart Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* Chart 1: Historical Trend */}
            <div className="bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm col-span-1 lg:col-span-2">
               <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
                 <TrendingUp size={16} className="text-blue-500"/> Andamento Storico (Ultimi 4 anni)
               </h3>
               <div className="h-[300px] w-full">
                 <ResponsiveContainer width="100%" height="100%">
                   <AreaChart data={historicalData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                     <defs>
                       <linearGradient id="colorFront" x1="0" y1="0" x2="0" y2="1">
                         <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                         <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                       </linearGradient>
                     </defs>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" strokeOpacity={0.3} />
                     <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fontSize: 11, fill: '#94a3b8', fontWeight: 600}} dy={10} minTickGap={30} />
                     <YAxis axisLine={false} tickLine={false} tick={{fontSize: 11, fill: '#94a3b8', fontWeight: 600}} domain={['dataMin - 2000', 'auto']} width={50} tickFormatter={(val) => `${(val/1000).toFixed(0)}k`} />
                     <Tooltip 
                        contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)'}}
                        formatter={(value: any) => [Number(value).toLocaleString('it-IT'), 'Lavoratori']}
                     />
                     <Area type="monotone" dataKey="frontalieri" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorFront)" animationDuration={1500} />
                   </AreaChart>
                 </ResponsiveContainer>
               </div>
            </div>

            {/* Chart 2: Age Distribution */}
            <div className="bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
               <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
                 <BarChart2 size={16} className="text-emerald-500"/> Distribuzione per Età
               </h3>
               <div className="h-[250px] w-full">
                 <ResponsiveContainer width="100%" height="100%">
                   <BarChart data={ageData} layout="vertical" margin={{ top: 0, right: 30, left: 40, bottom: 0 }} barSize={12}>
                     <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#e2e8f0" strokeOpacity={0.3} />
                     <XAxis type="number" hide />
                     <YAxis dataKey="name" type="category" width={60} tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 600}} axisLine={false} tickLine={false} />
                     <Tooltip cursor={{fill: 'transparent'}} contentStyle={{borderRadius: '12px'}} />
                     <Bar dataKey="value" radius={[0, 4, 4, 0]} fill="#10b981" name="Lavoratori">
                        {ageData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={index % 2 === 0 ? '#10b981' : '#34d399'} />
                        ))}
                     </Bar>
                   </BarChart>
                 </ResponsiveContainer>
               </div>
            </div>

            {/* Chart 3: Gender Trend (Replacing Broken Sectors) */}
            <div className="bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
               <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
                 <PersonStanding size={16} className="text-indigo-500"/> Trend per Genere
               </h3>
               <div className="h-[250px] w-full">
                 {genderTrendData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={genderTrendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.2} />
                            <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8'}} dy={10} minTickGap={30} />
                            <YAxis axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8'}} width={45} tickFormatter={(val) => `${(val/1000).toFixed(0)}k`} />
                            <Tooltip contentStyle={{borderRadius: '12px'}} />
                            <Legend iconType="circle" wrapperStyle={{fontSize: '10px', paddingTop: '10px'}}/>
                            <Line type="monotone" dataKey="Uomini" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{r: 4}} />
                            <Line type="monotone" dataKey="Donne" stroke="#ec4899" strokeWidth={2} dot={false} activeDot={{r: 4}} />
                        </LineChart>
                    </ResponsiveContainer>
                 ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
                        {loading ? <Loader2 className="animate-spin" /> : <span className="text-xs italic">Dati non disponibili</span>}
                    </div>
                 )}
               </div>
            </div>

        </div>

      </div>

      {/* Footer Info */}
      <div className="px-6">
        <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 border border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-3">
                <div className="bg-white dark:bg-slate-700 p-2 rounded-xl text-indigo-500 shadow-sm hidden sm:block">
                    <Info size={20} />
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed text-center sm:text-left">
                    Dati estratti dal cubo statistico BFS (PxWeb).
                    {usingRealData ? (
                        <span className="text-emerald-600 dark:text-emerald-400 font-bold ml-1">
                            Ultimo aggiornamento: {lastUpdated?.toLocaleDateString()}
                        </span>
                    ) : (
                        apiError && <span className="text-red-500 ml-1">{apiError}</span>
                    )}
                </div>
            </div>
            <a 
            href={SOURCE_LINK}
            target="_blank" 
            rel="noreferrer"
            className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 text-xs font-bold rounded-xl transition-all border border-slate-200 dark:border-slate-600 shadow-sm"
            >
            Fonte BFS <ExternalLink size={12} />
            </a>
        </div>
      </div>

    </div>
  );
};