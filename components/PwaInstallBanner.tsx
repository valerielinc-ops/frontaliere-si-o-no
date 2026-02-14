import React, { useState, useEffect, useCallback } from 'react';
import { Download, X, Smartphone } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const PwaInstallBanner: React.FC = () => {
  const { t } = useTranslation();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // Check if already installed as PWA
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;
    setIsStandalone(standalone);

    if (standalone) return;

    // Check if user dismissed the banner recently (7 days cooldown)
    const dismissed = localStorage.getItem('pwa_install_dismissed');
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      // Show banner after a small delay so user has time to explore the app
      setTimeout(() => setShowBanner(true), 5000);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    Analytics.trackUIInteraction('PWA', 'install_prompt_accepted');
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    Analytics.trackUIInteraction('PWA', `install_${outcome}`);
    setDeferredPrompt(null);
    setShowBanner(false);
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    setShowBanner(false);
    localStorage.setItem('pwa_install_dismissed', String(Date.now()));
    Analytics.trackUIInteraction('PWA', 'install_prompt_dismissed');
  }, []);

  if (isStandalone || !showBanner) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-slide-up">
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl shadow-2xl p-4 text-white">
        <button
          onClick={handleDismiss}
          className="absolute top-2 right-2 p-1 rounded-full hover:bg-white/20 transition-colors"
          aria-label="Chiudi"
        >
          <X size={16} />
        </button>
        <div className="flex items-start gap-3">
          <div className="bg-white/20 rounded-xl p-2.5 flex-shrink-0">
            <Smartphone size={24} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-sm leading-tight">
              {t('pwa.installTitle')}
            </h3>
            <p className="text-xs text-white/80 mt-1 leading-relaxed">
              {t('pwa.installDescription')}
            </p>
            <button
              onClick={handleInstall}
              className="mt-2 inline-flex items-center gap-1.5 px-4 py-1.5 bg-white text-indigo-700 font-semibold text-xs rounded-lg hover:bg-indigo-50 transition-colors shadow-sm"
            >
              <Download size={14} />
              {t('pwa.installButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PwaInstallBanner;
