import React, { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Key, RefreshCw, ExternalLink } from 'lucide-react';
import { trafficService } from '../services/trafficService';

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

    // 1. Google Maps API
    const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    const hasMapsKey = trafficService.hasApiKey();
    checks.push({
      name: 'Google Maps Distance Matrix API',
      key: 'VITE_GOOGLE_MAPS_API_KEY',
      configured: hasMapsKey,
      value: mapsKey ? `${mapsKey.substring(0, 10)}...` : 'Non configurata',
      status: hasMapsKey ? 'success' : 'warning',
      message: hasMapsKey 
        ? 'Configurata correttamente - Traffico valichi usa dati reali'
        : 'Non configurata - Traffico valichi usa dati simulati',
      testUrl: 'https://console.cloud.google.com/apis/api/distance_matrix_backend.googleapis.com'
    });

    // 2. Google Gemini API
    const geminiKey = import.meta.env.GEMINI_API_KEY;
    checks.push({
      name: 'Google Gemini API',
      key: 'GEMINI_API_KEY',
      configured: !!geminiKey && geminiKey !== 'your_gemini_api_key_here',
      value: geminiKey && geminiKey !== 'your_gemini_api_key_here' 
        ? `${geminiKey.substring(0, 10)}...` 
        : 'Non configurata',
      status: geminiKey && geminiKey !== 'your_gemini_api_key_here' ? 'success' : 'warning',
      message: geminiKey && geminiKey !== 'your_gemini_api_key_here'
        ? 'Configurata correttamente - Funzionalità AI attive nel feedback'
        : 'Non configurata - Funzionalità AI nel feedback disabilitate',
      testUrl: 'https://aistudio.google.com/app/apikey'
    });

    // 3. GitHub PAT
    const githubPat = import.meta.env.VITE_REACT_APP_PAT;
    checks.push({
      name: 'GitHub Personal Access Token',
      key: 'VITE_REACT_APP_PAT',
      configured: !!githubPat && githubPat !== 'your_github_pat_here',
      value: githubPat && githubPat !== 'your_github_pat_here'
        ? `${githubPat.substring(0, 10)}...`
        : 'Non configurato',
      status: githubPat && githubPat !== 'your_github_pat_here' ? 'success' : 'warning',
      message: githubPat && githubPat !== 'your_github_pat_here'
        ? 'Configurato correttamente - Issue tracking GitHub attivo'
        : 'Non configurato - Issue tracking GitHub disabilitato',
      testUrl: 'https://github.com/settings/tokens'
    });

    // 4. Google OAuth Client ID
    const oauthClientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID;
    checks.push({
      name: 'Google OAuth Client ID',
      key: 'VITE_GOOGLE_OAUTH_CLIENT_ID',
      configured: !!oauthClientId,
      value: oauthClientId 
        ? `${oauthClientId.substring(0, 20)}...`
        : 'Non configurato',
      status: oauthClientId ? 'success' : 'warning',
      message: oauthClientId
        ? 'Configurato correttamente - Pronto per autenticazione OAuth'
        : 'Non configurato - Autenticazione OAuth non disponibile',
      testUrl: 'https://console.cloud.google.com/apis/credentials'
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
        return <CheckCircle2 className="text-green-600 dark:text-green-400" size={24} />;
      case 'warning':
        return <AlertTriangle className="text-amber-600 dark:text-amber-400" size={24} />;
      case 'error':
        return <XCircle className="text-red-600 dark:text-red-400" size={24} />;
      default:
        return <AlertTriangle className="text-slate-400" size={24} />;
    }
  };

  const successCount = apiChecks.filter(c => c.status === 'success').length;
  const warningCount = apiChecks.filter(c => c.status === 'warning').length;
  const errorCount = apiChecks.filter(c => c.status === 'error').length;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-slate-700 to-slate-900 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Key size={32} />
          <h2 className="text-3xl font-extrabold">Diagnostica API</h2>
        </div>
        <p className="text-slate-300 text-lg">
          Verifica lo stato di configurazione delle API esterne
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="bg-green-50 dark:bg-green-950/30 border-2 border-green-200 dark:border-green-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-700 dark:text-green-400 font-medium">Configurate</p>
              <p className="text-3xl font-bold text-green-900 dark:text-green-200">{successCount}</p>
            </div>
            <CheckCircle2 className="text-green-600 dark:text-green-400" size={32} />
          </div>
        </div>

        <div className="bg-amber-50 dark:bg-amber-950/30 border-2 border-amber-200 dark:border-amber-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-amber-700 dark:text-amber-400 font-medium">Non Configurate</p>
              <p className="text-3xl font-bold text-amber-900 dark:text-amber-200">{warningCount}</p>
            </div>
            <AlertTriangle className="text-amber-600 dark:text-amber-400" size={32} />
          </div>
        </div>

        <div className="bg-red-50 dark:bg-red-950/30 border-2 border-red-200 dark:border-red-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-red-700 dark:text-red-400 font-medium">Errori</p>
              <p className="text-3xl font-bold text-red-900 dark:text-red-200">{errorCount}</p>
            </div>
            <XCircle className="text-red-600 dark:text-red-400" size={32} />
          </div>
        </div>
      </div>

      {/* Refresh Button */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600 dark:text-slate-400">
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
            className={`bg-white dark:bg-slate-800 border-2 rounded-xl p-6 ${
              check.status === 'success'
                ? 'border-green-200 dark:border-green-800'
                : check.status === 'warning'
                ? 'border-amber-200 dark:border-amber-800'
                : 'border-red-200 dark:border-red-800'
            }`}
          >
            <div className="flex items-start gap-4">
              {getStatusIcon(check.status)}
              <div className="flex-1">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="font-bold text-lg text-slate-900 dark:text-slate-100">
                      {check.name}
                    </h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                      {check.key}
                    </p>
                  </div>
                  {check.testUrl && (
                    <a
                      href={check.testUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    >
                      <ExternalLink size={14} />
                      Gestisci
                    </a>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      Valore:
                    </span>
                    <code className="text-sm bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded font-mono">
                      {check.value}
                    </code>
                  </div>

                  <p className={`text-sm ${
                    check.status === 'success'
                      ? 'text-green-700 dark:text-green-400'
                      : check.status === 'warning'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-red-700 dark:text-red-400'
                  }`}>
                    {check.message}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Instructions */}
      <div className="bg-blue-50 dark:bg-blue-950/30 border-l-4 border-blue-500 p-6 rounded-lg">
        <h3 className="font-bold text-blue-900 dark:text-blue-200 mb-2">
          📝 Come configurare le API
        </h3>
        <div className="text-sm text-blue-800 dark:text-blue-300 space-y-2">
          <p>
            Le API vanno configurate nel file <code className="bg-blue-100 dark:bg-blue-900 px-1 py-0.5 rounded">.env</code> nella root del progetto:
          </p>
          <ol className="list-decimal list-inside space-y-1 ml-2">
            <li>Copia <code className="bg-blue-100 dark:bg-blue-900 px-1 py-0.5 rounded">.env.example</code> in <code className="bg-blue-100 dark:bg-blue-900 px-1 py-0.5 rounded">.env</code></li>
            <li>Inserisci le chiavi API ottenute dai rispettivi servizi</li>
            <li>Riavvia il server di sviluppo per caricare le nuove variabili</li>
          </ol>
          <p className="mt-3 pt-3 border-t border-blue-200 dark:border-blue-800">
            <strong>Nota:</strong> Il file .env non viene committato su Git per motivi di sicurezza.
          </p>
        </div>
      </div>
    </div>
  );
};

export default ApiStatus;
