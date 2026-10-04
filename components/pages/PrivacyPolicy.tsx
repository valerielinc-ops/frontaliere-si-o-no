import React from 'react';
import { useTranslation } from '@/services/i18n';
import { getPrivacyLegalDocument } from '@/services/legal/privacy';
import { LegalDocumentPage } from './LegalDocumentPage';
import {
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_DENIED,
  getAdsConsent,
  grantAdsConsent,
  denyAdsConsent,
  onAdsConsentChange,
  reopenAdsConsentMessage,
  type AdsConsentValue,
} from '@/services/adsConsent';

// ─── Gestione del consenso pubblicitario (#5893, rework CMP) ────────────
//
// La raccolta del consenso e' del popup Google Funding Choices (TCF), l'unica
// superficie dal rework CMP-single-surface; questo blocco resta la superficie
// di revoca/modifica (GDPR art. 7.3, nLPD art. 6). ATTENZIONE alla fonte di
// verita': la decisione vive nella TC string del CMP, e il bridge
// (FC_CONSENT_BRIDGE_JS) la ri-scrive sul gate locale a OGNI pageload. Una
// scrittura solo-locale qui verrebbe quindi sovrascritta alla navigazione
// successiva: per questo i bottoni, oltre alla scrittura locale (effetto
// immediato in questa sessione), riaprono il messaggio CMP con
// `googlefc.showRevocationMessage()` cosi' la nuova risposta finisce nella TC
// string. Se FC non e' caricato (adblock), resta la sola scrittura locale —
// e senza FC non si servono comunque annunci. Dal 28-09 un rifiuto apre
// comunque AdSense per gli annunci limitati (`isAdSenseAllowed` in
// services/adsConsent.ts); Ad Manager e header bidding restano sul consenso.
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
    intro: 'Prima della tua scelta non viene caricato alcuno script pubblicitario. Se acconsenti, Google AdSense e Google Ad Manager possono mostrare annunci anche personalizzati; se rifiuti, solo Google AdSense mostra annunci limitati, senza personalizzazione e senza cookie pubblicitari. Puoi cambiare idea in qualsiasi momento da qui; la scelta e\' salvata in questo browser.',
    statusLabel: 'Stato attuale',
    granted: 'consenso concesso — gli annunci sono attivi',
    denied: 'consenso rifiutato — solo annunci limitati di AdSense, senza personalizzazione né cookie pubblicitari',
    undecided: 'nessuna decisione registrata — nessuno script pubblicitario viene caricato',
    reading: 'lettura in corso…',
    accept: 'Attiva gli annunci',
    decline: 'Disattiva gli annunci',
  },
  en: {
    heading: 'Manage your advertising consent',
    intro: 'No advertising script is loaded before you choose. If you consent, Google AdSense and Google Ad Manager may show ads, including personalised ones; if you refuse, only Google AdSense shows limited ads, without personalisation or advertising cookies. You can change your mind at any time here; the choice is stored in this browser.',
    statusLabel: 'Current status',
    granted: 'consent granted — ads are active',
    denied: 'consent refused — limited AdSense ads only, without personalisation or advertising cookies',
    undecided: 'no decision recorded — no advertising script is loaded',
    reading: 'reading…',
    accept: 'Enable ads',
    decline: 'Disable ads',
  },
  de: {
    heading: 'Werbe-Einwilligung verwalten',
    intro: 'Vor Ihrer Entscheidung wird kein Werbeskript geladen. Wenn Sie einwilligen, können Google AdSense und Google Ad Manager auch personalisierte Werbung zeigen; wenn Sie ablehnen, zeigt nur Google AdSense eingeschränkte Werbung, ohne Personalisierung und ohne Werbe-Cookies. Sie können Ihre Entscheidung hier jederzeit ändern; sie wird in diesem Browser gespeichert.',
    statusLabel: 'Aktueller Status',
    granted: 'Einwilligung erteilt — Werbung ist aktiv',
    denied: 'Einwilligung verweigert — nur eingeschränkte AdSense-Werbung, ohne Personalisierung und Werbe-Cookies',
    undecided: 'keine Entscheidung gespeichert — es wird kein Werbeskript geladen',
    reading: 'wird gelesen…',
    accept: 'Werbung aktivieren',
    decline: 'Werbung deaktivieren',
  },
  fr: {
    heading: 'Gérer votre consentement publicitaire',
    intro: 'Aucun script publicitaire n\'est chargé avant votre choix. Si vous consentez, Google AdSense et Google Ad Manager peuvent afficher des annonces, y compris personnalisées ; si vous refusez, seul Google AdSense affiche des annonces limitées, sans personnalisation ni cookies publicitaires. Vous pouvez changer d\'avis à tout moment ici ; le choix est enregistré dans ce navigateur.',
    statusLabel: 'Statut actuel',
    granted: 'consentement accordé — les annonces sont actives',
    denied: 'consentement refusé — uniquement des annonces AdSense limitées, sans personnalisation ni cookies publicitaires',
    undecided: 'aucune décision enregistrée — aucun script publicitaire n\'est chargé',
    reading: 'lecture en cours…',
    accept: 'Activer les publicités',
    decline: 'Désactiver les publicités',
  },
};

/**
 * Stato corrente del gate + i due bottoni che lo cambiano.
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

  // Rende la scelta persistente lato CMP: senza questa riapertura la TC string
  // resterebbe quella vecchia e il bridge la ri-applicherebbe al prossimo
  // pageload, annullando il click (vedi il commento in testa al blocco).
  // `reopenAdsConsentMessage` chiama FC direttamente quando e' gia' caricato
  // e accoda la chiamata finche' non lo e' (dettagli in services/adsConsent.ts):
  // la sola coda non riapriva nulla dopo il caricamento di FC. Se FC non
  // arriva mai (adblock) non succede nulla, e per la stessa ragione il bridge
  // non potra' mai sovrascrivere la scrittura locale qui sotto.
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
          onClick={() => { grantAdsConsent(); reopenCmp(); }}
          aria-pressed={read && decision === ADS_CONSENT_GRANTED}
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
