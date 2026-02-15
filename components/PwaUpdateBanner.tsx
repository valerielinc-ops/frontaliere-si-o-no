import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, X, Zap } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

/**
 * PWA Update Banner — shown when a new service worker is available.
 * Uses the `virtual:pwa-register` module provided by vite-plugin-pwa.
 */
const PwaUpdateBanner: React.FC = () => {
  const { t } = useTranslation();
  const [needRefresh, setNeedRefresh] = useState(false);
  const [updateSW, setUpdateSW] = useState<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    // Dynamically import to avoid SSR/test issues
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const register = async () => {
      try {
        const { registerSW } = await import('virtual:pwa-register');
        const update = registerSW({
          immediate: true,
          onNeedRefresh() {
            setNeedRefresh(true);
            Analytics.trackUIInteraction('app', 'pwa_update', 'nuovo_aggiornamento', 'disponibile');
          },
          onOfflineReady() {
            // SW cached everything, app is ready for offline use
          },
          onRegistered(registration) {
            // Periodically check for SW updates (every 60 minutes)
            if (registration) {
              intervalId = setInterval(() => {
                registration.update();
              }, 60 * 60 * 1000);
            }
          },
          onRegisterError(error) {
            console.warn('[PWA] SW registration error:', error);
          },
        });
        setUpdateSW(() => update);
      } catch {
        // virtual:pwa-register not available (dev mode or tests)
      }
    };
    register();
    return () => { if (intervalId) clearInterval(intervalId); };
  }, []);

  const handleUpdate = useCallback(async () => {
    if (updateSW) {
      Analytics.trackUIInteraction('app', 'pwa_update', 'bottone_aggiorna', 'click');
      await updateSW(true); // true = reload page after update
    }
  }, [updateSW]);

  const handleDismiss = useCallback(() => {
    setNeedRefresh(false);
    Analytics.trackUIInteraction('app', 'pwa_update', 'bottone_dopo', 'click');
  }, []);

  if (!needRefresh) return null;

  return (
    <div className="fixed top-4 left-4 right-4 z-[60] mx-auto max-w-md animate-slide-up">
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 rounded-2xl shadow-2xl p-4 text-white">
        <button
          onClick={handleDismiss}
          className="absolute top-2 right-2 p-1 rounded-full hover:bg-white/20 transition-colors"
          aria-label="Chiudi"
        >
          <X size={16} />
        </button>
        <div className="flex items-start gap-3">
          <div className="bg-white/20 rounded-xl p-2.5 flex-shrink-0 animate-pulse">
            <Zap size={24} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-sm leading-tight">
              {t('pwa.updateTitle')}
            </h3>
            <p className="text-xs text-white/80 mt-1 leading-relaxed">
              {t('pwa.updateDescription')}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={handleUpdate}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-white text-emerald-700 font-semibold text-xs rounded-lg hover:bg-emerald-50 transition-colors shadow-sm"
              >
                <RefreshCw size={14} />
                {t('pwa.updateButton')}
              </button>
              <button
                onClick={handleDismiss}
                className="text-xs text-white/70 hover:text-white transition-colors font-medium"
              >
                {t('pwa.updateLater')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PwaUpdateBanner;
