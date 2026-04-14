import React, { useState, useEffect, useMemo } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Key, RefreshCw, ExternalLink } from 'lucide-react';
import { trafficService } from '../../services/trafficService';
import { getConfigValue } from '../../services/firebase';
import { isTwelveDataConfigured, getRateSource } from '../../services/exchangeRateService';

interface ApiCheck {
 name: string;
 key: string;
 configured: boolean;
 value?: string;
 status: 'success' | 'warning' | 'error';
 message: string;
 testUrl?: string;
}

const ApiStatus: React.FC = () => {
 const [apiChecks, setApiChecks] = useState<ApiCheck[]>([]);
 const [loading, setLoading] = useState(true);
 const [lastCheck, setLastCheck] = useState<Date>(new Date());

 const checkApis = async () => {
 setLoading(true);
 const checks: ApiCheck[] = [];

 // 1. Live traffic snapshot (scheduler + Firestore)
 const hasLiveTraffic = await trafficService.hasFreshTrafficSnapshot();
 checks.push({
 name: 'Traffico valichi live',
 key: '****',
 configured: hasLiveTraffic,
 value: hasLiveTraffic ? '✓ Snapshot live disponibile' : '✗ Snapshot live assente',
 status: hasLiveTraffic ? 'success' : 'warning',
 message: hasLiveTraffic
 ? 'Firestore sta ricevendo snapshot aggiornati dal collector traffico'
 : 'Nessuno snapshot recente trovato - il sito userà il modello simulato',
 testUrl: 'https://developer.tomtom.com/routing-api/documentation/tomtom-maps/calculate-route'
 });

 // 2. Google Gemini API - Carica da Firebase Remote Config
 const geminiKey = await getConfigValue('GEMINI_API_KEY');
 const hasGemini = !!geminiKey && geminiKey !== 'your_gemini_api_key_here' && geminiKey !== '';
 checks.push({
 name: 'Google Gemini API',
 key: '****',
 configured: hasGemini,
 value: hasGemini ? '✓ Configurata' : '✗ Non configurata',
 status: hasGemini ? 'success' : 'warning',
 message: hasGemini
 ? 'Configurata correttamente - Funzionalità AI attive nel feedback'
 : 'Non configurata - Funzionalità AI nel feedback disabilitate',
 testUrl: 'https://aistudio.google.com/app/apikey'
 });

 // 3. GitHub PAT - Carica da Firebase Remote Config
 const githubPat = await getConfigValue('GITHUB_PAT');
 const hasGithub = !!githubPat && githubPat !== 'your_github_pat_here' && githubPat !== '';
 checks.push({
 name: 'GitHub Personal Access Token',
 key: '****',
 configured: hasGithub,
 value: hasGithub ? '✓ Configurato' : '✗ Non configurato',
 status: hasGithub ? 'success' : 'warning',
 message: hasGithub
 ? 'Configurato correttamente - Issue tracking GitHub attivo'
 : 'Non configurato - Issue tracking GitHub disabilitato',
 testUrl: 'https://github.com/settings/tokens'
 });

 // 4. Google OAuth Client ID - carica da Firebase Remote Config
 const oauthClientId = await getConfigValue('GOOGLE_OAUTH_CLIENT_ID');
 const hasOAuth = !!oauthClientId && oauthClientId !== '' && oauthClientId !== 'your_google_oauth_client_id_here';
 checks.push({
 name: 'Google OAuth Client ID',
 key: '****',
 configured: hasOAuth,
 value: hasOAuth ? '✓ Configurato' : '✗ Non configurato',
 status: hasOAuth ? 'success' : 'warning',
 message: hasOAuth
 ? 'Configurato correttamente - Pronto per autenticazione OAuth'
 : 'Non configurato - Autenticazione OAuth non disponibile',
 testUrl: 'https://console.cloud.google.com/apis/credentials'
 });

 // 5. TwelveData Exchange Rate API
 const hasTwelveData = await isTwelveDataConfigured();
 const currentSource = getRateSource();
 checks.push({
 name: 'TwelveData Exchange Rate API',
 key: '****',
 configured: hasTwelveData,
 value: hasTwelveData ? '✓ Configurata' : '✗ Non configurata',
 status: hasTwelveData ? 'success' : 'warning',
 message: hasTwelveData
 ? `Configurata correttamente - Fonte attuale: ${currentSource}`
 : 'Non configurata - Usa valore di default come fallback',
 testUrl: 'https://twelvedata.com/account'
 });

 setApiChecks(checks);
 setLastCheck(new Date());
 setLoading(false);
 };

 useEffect(() => {
 checkApis();
 }, []);

 const getStatusIcon = (status: string) => {
 switch (status) {
 case 'success':
 return <CheckCircle2 className="text-success" size={24} />;
 case 'warning':
 return <AlertTriangle className="text-warning" size={24} />;
 case 'error':
 return <XCircle className="text-danger" size={24} />;
 default:
 return <AlertTriangle className="text-muted" size={24} />;
 }
 };

 const { successCount, warningCount, errorCount } = useMemo(() => ({
 successCount: apiChecks.filter(c => c.status === 'success').length,
 warningCount: apiChecks.filter(c => c.status === 'warning').length,
 errorCount: apiChecks.filter(c => c.status === 'error').length,
 }), [apiChecks]);

 return (
 <div className="space-y-6 pb-8">
 {/* Header */}
 <div className="bg-gradient-to-br from-slate-700 to-slate-900 rounded-2xl p-5 sm:p-8 text-white">
 <div className="flex items-center gap-3 mb-4">
 <Key size={32} />
 <h2 className="text-2xl sm:text-3xl font-bold">Diagnostica API</h2>
 </div>
 <p className="text-slate-300 text-lg">
 Verifica lo stato di configurazione delle API esterne
 </p>
 </div>

 {/* Summary Stats */}
 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-success">{successCount}</span> Configurate</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-warning">{warningCount}</span> Non Configurate</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-danger">{errorCount}</span> Errori</span>
 </div>

 {/* Refresh Button */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <div className="flex items-center justify-between">
 <div className="text-sm text-subtle">
 Ultimo controllo: {lastCheck.toLocaleTimeString('it-IT')}
 </div>
 <button
 onClick={checkApis}
 disabled={loading}
 className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-800 text-white rounded-lg transition-colors disabled:opacity-50"
 >
 <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
 Ricontrolla
 </button>
 </div>
 </div>

 {/* API Status List */}
 <div className="space-y-4">
 {apiChecks.map((check, index) => (
 <div
 key={index}
 className={`bg-surface border-2 rounded-xl p-4 sm:p-6 ${
 check.status === 'success'
 ? 'border-success-border'
 : check.status === 'warning'
 ? 'border-warning-border'
 : 'border-danger-border'
 }`}
 >
 <div className="flex items-start gap-4">
 {getStatusIcon(check.status)}
 <div className="flex-1">
 <div className="flex items-start justify-between mb-2">
 <h3 className="font-bold text-lg text-heading">
 {check.name}
 </h3>
 </div>

 <div className="space-y-2">
 <p className={`text-sm font-medium ${
 check.status === 'success'
 ? 'text-success'
 : check.status === 'warning'
 ? 'text-warning'
 : 'text-danger'
 }`}>
 {check.value}
 </p>
 <p className="text-sm text-subtle">
 {check.message}
 </p>
 </div>
 </div>
 </div>
 </div>
 ))}
 </div>

 {/* Info Note */}
 <div className="bg-surface-alt border border-edge p-4 sm:p-6 rounded-xl">
 <p className="text-sm text-subtle text-center">
 🔒 <strong>Privacy:</strong> I dettagli delle chiavi API sono nascosti per motivi di sicurezza.
 </p>
 </div>
 </div>
 );
};

export default ApiStatus;
