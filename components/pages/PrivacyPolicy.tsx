import React from 'react';
import { useTranslation } from '@/services/i18n';
import { getPrivacyLegalDocument } from '@/services/legal/privacy';
import { LegalDocumentPage } from './LegalDocumentPage';
import {
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_DENIED,
  getAdsConsent,
  denyAdsConsent,
  onAdsConsentChange,
  reopenAdsConsentMessage,
  type AdsConsentValue,
} from '@/services/adsConsent';

// ─── Gestione del consenso pubblicitario (#5893, rework CMP) ────────────
//
// La raccolta del consenso e' del popup Google Funding Choices (TCF), l'unica
// superficie dal rework CMP-single-surface; questo blocco resta la superficie
// di revoca/modifica. L'apertura del messaggio non e' un'accettazione: solo
// la risposta al CMP, riportata da FC_CONSENT_BRIDGE_JS, puo' concedere il
// consenso locale. Se Google e' bloccato o genera un errore, la scelta resta
// invariata. La revoca esplicita puo' invece chiudere subito il gate locale
// e riaprire Google per aggiornare anche le sue preferenze. Un rifiuto
// mantiene gli annunci limitati di AdSense (`isAdSenseAllowed`); Ad Manager
// e header bidding restano sul consenso.
//
// Le stringhe sono inline nelle quattro lingue e non nei file di locale: il
// documento legale è localizzato separatamente; il visitatore de/en/fr ha ricevuto
// la domanda dal CMP nella propria lingua e deve poter riconoscere la risposta
// che sta cambiando.

type AdsControlsCopy = {
  heading: string;
  intro: string;
  statusLabel: string;
  granted: string;
  denied: string;
  undecided: string;
  reading: string;
  accept: string;
  decline: string;
};

const ADS_CONTROLS_COPY: Record<string, AdsControlsCopy> = {
  it: {
    heading: 'Gestisci il consenso pubblicitario',
    intro: 'Le preferenze di Google ti consentono di scegliere come usare i tuoi dati per gli annunci. Puoi aprirle per modificare il consenso oppure revocarlo subito da qui.',
    statusLabel: 'Stato attuale',
    granted: 'consenso concesso — gli annunci sono attivi',
    denied: 'consenso rifiutato — solo annunci limitati di AdSense, senza personalizzazione né cookie pubblicitari',
    undecided: 'nessuna decisione registrata — nessuno script pubblicitario viene caricato',
    reading: 'lettura in corso…',
    accept: 'Apri le preferenze di Google',
    decline: 'Disattiva gli annunci',
  },
  en: {
    heading: 'Manage your advertising consent',
    intro: 'Use Google’s privacy preferences to choose how your data is used for advertising. Open them to change your consent, or withdraw consent immediately here.',
    statusLabel: 'Current status',
    granted: 'consent granted — ads are active',
    denied: 'consent refused — limited AdSense ads only, without personalisation or advertising cookies',
    undecided: 'no decision recorded — no advertising script is loaded',
    reading: 'reading…',
    accept: 'Open Google privacy preferences',
    decline: 'Disable ads',
  },
  de: {
    heading: 'Werbe-Einwilligung verwalten',
    intro: 'In Googles Datenschutzeinstellungen können Sie wählen, wie Ihre Daten für Werbung verwendet werden. Öffnen Sie diese, um Ihre Einwilligung zu ändern, oder widerrufen Sie sie sofort hier.',
    statusLabel: 'Aktueller Status',
    granted: 'Einwilligung erteilt — Werbung ist aktiv',
    denied: 'Einwilligung verweigert — nur eingeschränkte AdSense-Werbung, ohne Personalisierung und Werbe-Cookies',
    undecided: 'keine Entscheidung gespeichert — es wird kein Werbeskript geladen',
    reading: 'wird gelesen…',
    accept: 'Google-Datenschutzeinstellungen öffnen',
    decline: 'Werbung deaktivieren',
  },
  fr: {
    heading: 'Gérer votre consentement publicitaire',
    intro: 'Les préférences de Google vous permettent de choisir comment vos données sont utilisées pour la publicité. Ouvrez-les pour modifier votre consentement, ou retirez-le immédiatement ici.',
    statusLabel: 'Statut actuel',
    granted: 'consentement accordé — les annonces sont actives',
    denied: 'consentement refusé — uniquement des annonces AdSense limitées, sans personnalisation ni cookies publicitaires',
    undecided: 'aucune décision enregistrée — aucun script publicitaire n\'est chargé',
    reading: 'lecture en cours…',
    accept: 'Ouvrir les préférences de Google',
    decline: 'Désactiver les publicités',
  },
};

/**
 * Stato corrente del gate, apertura delle preferenze Google e revoca locale.
 *
 * La decisione si legge in un effect e non nel primo render: `getAdsConsent()`
 * tocca localStorage, che in prerender non esiste. Leggerla nel render iniziale
 * farebbe divergere l'HTML statico dall'albero idratato ogni volta che il
 * visitatore ha gia' risposto — la stessa ragione per cui
 * `CommunicationsConsentBanner` parte nascosto. Fino all'effect si mostra
 * `reading`, che e' vero su entrambi i lati.
 *
 * Esportato per i test (`tests/ads-consent-mode-bridge.test.tsx`): la pagina
 * intera richiede il NavigationContext, questo blocco no.
 */
export const AdsConsentControls: React.FC = () => {
  const { locale } = useTranslation();
  const [decision, setDecision] = React.useState<AdsConsentValue | null>(null);
  const [read, setRead] = React.useState(false);

  React.useEffect(() => {
    setDecision(getAdsConsent());
    setRead(true);
    // Il bridge CMP, un'altra scheda o questo stesso blocco: qualunque origine
    // aggiorna lo stato mostrato senza ricaricare la pagina.
    return onAdsConsentChange(setDecision);
  }, []);

  // Il click apre il CMP e non concede alcun consenso. Se FC arriva tardi,
  // l'helper accoda una sola apertura; se non arriva, lo stato non cambia.
  const reopenCmp = React.useCallback(() => {
    reopenAdsConsentMessage();
  }, []);

  const copy = ADS_CONTROLS_COPY[locale] ?? ADS_CONTROLS_COPY.it;
  const status = !read
    ? copy.reading
    : decision === ADS_CONSENT_GRANTED
      ? copy.granted
      : decision === ADS_CONSENT_DENIED
        ? copy.denied
        : copy.undecided;

  return (
    <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
      <h3 className="font-medium text-heading mb-2">{copy.heading}</h3>
      <p className="text-sm">{copy.intro}</p>
      <p className="text-sm mt-2" data-testid="ads-consent-status">
        <strong>{copy.statusLabel}:</strong> {status}
      </p>
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={reopenCmp}
          className="min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white"
        >
          {copy.accept}
        </button>
        <button
          type="button"
          onClick={() => { denyAdsConsent(); reopenCmp(); }}
          aria-pressed={read && decision === ADS_CONSENT_DENIED}
          className="min-h-[44px] rounded-lg border border-edge/60 px-4 text-sm font-medium"
        >
          {copy.decline}
        </button>
      </div>
    </div>
  );
};

export const PrivacyPolicy: React.FC = () => {
  const { locale } = useTranslation();
  return <LegalDocumentPage document={getPrivacyLegalDocument(locale)} locale={locale} adsControls={<AdsConsentControls />} />;
};
