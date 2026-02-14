import React, { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Key, RefreshCw, ExternalLink } from 'lucide-react';
import { trafficService } from '../services/trafficService';
import { getConfigValue } from '../services/firebase';

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
    const hasMapsKey = trafficService.hasApiKey();
    checks.push({
      name: 'Google Maps Distance Matrix API',
      key: '****',
      configured: hasMapsKey,
      value: hasMapsKey ? '✓ Configurata' : '✗ Non configurata',
      status: hasMapsKey ? 'success' : 'warning',
      message: hasMapsKey 
        ? 'Configurata correttamente - Traffico valichi usa dati reali'
        : 'Non configurata - Traffico valichi usa dati simulati',
      testUrl: 'https://console.cloud.google.com/apis/api/distance_matrix_backend.googleapis.com'
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
                  <h3 className="font-bold text-lg text-slate-900 dark:text-slate-100">
                    {check.name}
                  </h3>
                </div>

                <div className="space-y-2">
                  <p className={`text-sm font-medium ${
                    check.status === 'success'
                      ? 'text-green-700 dark:text-green-400'
                      : check.status === 'warning'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-red-700 dark:text-red-400'
                  }`}>
                    {check.value}
                  </p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {check.message}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Info Note */}
      <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-6 rounded-xl">
        <p className="text-sm text-slate-600 dark:text-slate-400 text-center">
          🔒 <strong>Privacy:</strong> I dettagli delle chiavi API sono nascosti per motivi di sicurezza.
        </p>
      </div>
    </div>
  );
};

export default ApiStatus;
