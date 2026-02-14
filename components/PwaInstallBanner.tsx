import React, { useState, useEffect, useCallback } from 'react';
import { Download, X, Smartphone, Share, Plus } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Detect if running on iOS Safari (which doesn't support beforeinstallprompt)
 */
function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIOS && isSafari;
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const PwaInstallBanner: React.FC = () => {
  const { t } = useTranslation();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);

  useEffect(() => {
    const checkInstalled = async () => {
      // Check if already running as installed PWA
      const standalone = window.matchMedia('(display-mode: standalone)').matches
        || (navigator as any).standalone === true;

      // Check via getInstalledRelatedApps API (Chrome 80+)
      let relatedAppInstalled = false;
      try {
        if ('getInstalledRelatedApps' in navigator) {
          const apps = await (navigator as any).getInstalledRelatedApps();
          relatedAppInstalled = apps.length > 0;
        }
      } catch { /* API not supported */ }

      // Check if user previously accepted install prompt
      const userInstalled = localStorage.getItem('pwa_installed') === 'true';

      if (standalone || relatedAppInstalled || userInstalled) {
        setIsStandalone(true);
        return;
      }

      // Check if user dismissed the banner recently (7 days cooldown)
      const dismissed = localStorage.getItem('pwa_install_dismissed');
      if (dismissed) {
        const dismissedAt = parseInt(dismissed, 10);
        if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;
      }

      // iOS Safari: show our custom banner since beforeinstallprompt is not supported
      if (isIOS()) {
        setTimeout(() => setShowBanner(true), 5000);
        return;
      }

      // Android/Chrome: listen for beforeinstallprompt
      const handler = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e as BeforeInstallPromptEvent);
        setTimeout(() => setShowBanner(true), 5000);
      };

      window.addEventListener('beforeinstallprompt', handler);

      // Listen for appinstalled event to hide banner permanently
      const installedHandler = () => {
        setIsStandalone(true);
        setShowBanner(false);
        localStorage.setItem('pwa_installed', 'true');
      };
      window.addEventListener('appinstalled', installedHandler);

      return () => {
        window.removeEventListener('beforeinstallprompt', handler);
        window.removeEventListener('appinstalled', installedHandler);
      };
    };

    checkInstalled();
  }, []);

  const handleInstall = useCallback(async () => {
    // iOS: show step-by-step instructions
    if (isIOS()) {
      setShowIOSInstructions(true);
      Analytics.trackUIInteraction('app', 'pwa_banner', 'istruzioni_ios', 'mostra');
      return;
    }

    // Android/Chrome: use native prompt
    if (!deferredPrompt) return;
    Analytics.trackUIInteraction('app', 'pwa_banner', 'bottone_installa', 'click');
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    Analytics.trackUIInteraction('app', 'pwa_banner', 'prompt_nativo', outcome);
    if (outcome === 'accepted') {
      localStorage.setItem('pwa_installed', 'true');
    }
    setDeferredPrompt(null);
    setShowBanner(false);
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    setShowBanner(false);
    setShowIOSInstructions(false);
    localStorage.setItem('pwa_install_dismissed', String(Date.now()));
    Analytics.trackUIInteraction('app', 'pwa_banner', 'bottone_chiudi', 'click');
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

            {/* iOS step-by-step instructions */}
            {showIOSInstructions ? (
              <div className="mt-3 space-y-2 bg-white/10 rounded-xl p-3">
                <div className="flex items-center gap-2 text-xs font-bold">
                  <div className="w-5 h-5 rounded-full bg-white/30 flex items-center justify-center text-[10px] font-black">1</div>
                  <span>{t('pwa.iosStep1')}</span>
                  <Share size={14} className="text-blue-300" />
                </div>
                <div className="flex items-center gap-2 text-xs font-bold">
                  <div className="w-5 h-5 rounded-full bg-white/30 flex items-center justify-center text-[10px] font-black">2</div>
                  <span>{t('pwa.iosStep2')}</span>
                  <Plus size={14} className="text-blue-300" />
                </div>
                <div className="flex items-center gap-2 text-xs font-bold">
                  <div className="w-5 h-5 rounded-full bg-white/30 flex items-center justify-center text-[10px] font-black">3</div>
                  <span>{t('pwa.iosStep3')}</span>
                </div>
              </div>
            ) : (
              <button
                onClick={handleInstall}
                className="mt-2 inline-flex items-center gap-1.5 px-4 py-1.5 bg-white text-indigo-700 font-semibold text-xs rounded-lg hover:bg-indigo-50 transition-colors shadow-sm"
              >
                {isIOS() ? <Share size={14} /> : <Download size={14} />}
                {t('pwa.installButton')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PwaInstallBanner;
