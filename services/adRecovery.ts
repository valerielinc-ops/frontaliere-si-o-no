/** One recovery surface for static and SPA pages. No experiment assignment,
 * synthetic consent, extension manipulation, or changes to Google's ad DOM.
 * All collaborators are injected because the static loader serializes this.
 */
export function installAdRecovery(
  probe: () => Promise<'blocked' | 'clear' | 'unknown'>,
  createLoader: (kind: 'cmp', src: string, allowed: () => boolean, emit: (event: string, props: Record<string, string | number>) => void) => { load: () => void; state: () => string; subscribe: (listener: (state: string) => void) => () => void },
  emit: (event: string, props: Record<string, string | number>) => void,
  allowed: () => boolean,
  config: { consentKey: string; consentEvent: string; publisherId: string; inlineHouseAds?: boolean; readerSubscriptionPaths?: readonly string[] },
) {
  type RecoveryWindow = Window & { __ftAdRecovery?: { refresh: () => void }; __ftHouseAds?: { refresh: () => void }; __ftAdBlock?: { blocked?: boolean; adsAllowed?: boolean }; __ftNativeApplicationOfferShown?: boolean; googlefc?: { showRevocationMessage?: () => void; callbackQueue?: unknown[]; __ftRevocationQueued?: boolean }; __ftAdBlockProbe?: string };
  const w = window as RecoveryWindow;
  if (w.__ftAdRecovery) { w.__ftAdRecovery.refresh(); return w.__ftAdRecovery; }
  const rawLanguage = (document.documentElement.lang || 'it').slice(0, 2);
  const language = ['it', 'en', 'de', 'fr'].includes(rawLanguage) ? rawLanguage : 'it';
  const copy = ({
    it: {
      problemTitle: 'Gli annunci non si caricano',
      problemBody: 'Un problema di rete o un blocco del browser può impedire il caricamento. Puoi verificare le impostazioni per questo sito e riprovare.',
      blockerTitle: 'Candidature su misura per il tuo prossimo lavoro in Svizzera',
      blockerBody: 'Per 30 giorni cerchiamo posizioni compatibili con il tuo profilo e prepariamo le candidature per te.',
      offerDuration: '30 giorni', offerLimit: 'Fino a 10 posizioni che accetti', offerPrice: '39,99 €',
      offerPriceNote: 'Pagamento unico · senza rinnovo',
      offerSupport: 'Gli annunci aiutano a mantenere gratuito il sito. Puoi consentirli e continuare a leggere senza acquistare il servizio.',
      offerDisclaimer: 'Le risposte delle aziende e l’assunzione non sono garantite.',
      offerCta: 'Scopri il servizio', blockerReload: 'Ho consentito gli annunci — ricarica',
      blockerDismiss: 'Continua a leggere', blockerClose: 'Chiudi la promozione',
      reload: 'Ricarica e verifica', close: 'Continua a leggere', preferences: 'Apri le preferenze privacy',
      unavailable: 'Le preferenze di Google non sono disponibili. Controlla il blocco del browser e riprova.',
      jobTitle: 'Lavoro in Svizzera? Lo cerchiamo noi per te.', jobBody: 'Troviamo le offerte adatte al tuo mestiere e prepariamo le candidature per te.',
      job: 'Scopri come funziona', label: 'Servizio Frontaliere Ticino', dismiss: 'Chiudi il suggerimento',
    },
    en: {
      problemTitle: 'Ads are not loading',
      problemBody: 'A network problem or browser blocking may prevent loading. You can check this site’s settings and try again.',
      blockerTitle: 'Tailored applications for your next job in Switzerland',
      blockerBody: 'For 30 days, we look for roles that fit your profile and prepare applications for you.',
      offerDuration: '30 days', offerLimit: 'Up to 10 positions you accept', offerPrice: '€39.99',
      offerPriceNote: 'One-off payment · no renewal',
      offerSupport: 'Ads help keep this site free. You can allow them and keep reading without buying the service.',
      offerDisclaimer: 'Employer replies and hiring are not guaranteed.',
      offerCta: 'See how it works', blockerReload: 'I allowed ads — reload',
      blockerDismiss: 'Keep reading', blockerClose: 'Close promotion',
      reload: 'Reload and check', close: 'Continue reading', preferences: 'Open privacy preferences',
      unavailable: 'Google privacy preferences are unavailable. Check your browser’s blocking settings and try again.',
      jobTitle: 'Want to work in Switzerland? We’ll look for you.', jobBody: 'We find suitable openings for your trade and prepare applications for you.',
      job: 'See how it works', label: 'A Frontaliere Ticino service', dismiss: 'Close this suggestion',
    },
    de: {
      problemTitle: 'Anzeigen werden nicht geladen',
      problemBody: 'Ein Netzwerkproblem oder der Browser-Schutz kann das Laden verhindern. Prüfen Sie die Einstellungen für diese Website und versuchen Sie es erneut.',
      blockerTitle: 'Passende Bewerbungen für deinen nächsten Job in der Schweiz',
      blockerBody: '30 Tage lang suchen wir Stellen, die zu deinem Profil passen, und bereiten deine Bewerbungen vor.',
      offerDuration: '30 Tage', offerLimit: 'Bis zu 10 Stellen, die du annimmst', offerPrice: '39,99 €',
      offerPriceNote: 'Einmalige Zahlung · keine Verlängerung',
      offerSupport: 'Anzeigen helfen, diese Website kostenlos zu halten. Du kannst sie erlauben und weiterlesen, ohne den Service zu buchen.',
      offerDisclaimer: 'Antworten der Unternehmen und eine Anstellung sind nicht garantiert.',
      offerCta: 'Service ansehen', blockerReload: 'Werbung erlaubt — neu laden',
      blockerDismiss: 'Weiterlesen', blockerClose: 'Anzeige schließen',
      reload: 'Neu laden und prüfen', close: 'Weiterlesen', preferences: 'Datenschutzeinstellungen öffnen',
      unavailable: 'Googles Datenschutzeinstellungen sind nicht verfügbar. Prüfen Sie den Browser-Schutz und versuchen Sie es erneut.',
      jobTitle: 'Arbeit in der Schweiz? Wir suchen für Sie.', jobBody: 'Wir finden passende Stellen für Ihren Beruf und bereiten die Bewerbungen für Sie vor.',
      job: 'So funktioniert es', label: 'Ein Service von Frontaliere Ticino', dismiss: 'Hinweis schließen',
    },
    fr: {
      problemTitle: 'Les annonces ne se chargent pas',
      problemBody: 'Un problème réseau ou un blocage du navigateur peut empêcher le chargement. Vous pouvez vérifier les réglages de ce site et réessayer.',
      blockerTitle: 'Des candidatures sur mesure pour votre prochain emploi en Suisse',
      blockerBody: 'Pendant 30 jours, nous recherchons des postes compatibles avec votre profil et préparons vos candidatures.',
      offerDuration: '30 jours', offerLimit: 'Jusqu’à 10 postes que vous acceptez', offerPrice: '39,99 €',
      offerPriceNote: 'Paiement unique · sans renouvellement',
      offerSupport: 'Les annonces aident à garder ce site gratuit. Vous pouvez les autoriser et continuer à lire sans acheter le service.',
      offerDisclaimer: 'Les réponses des entreprises et l’embauche ne sont pas garanties.',
      offerCta: 'Découvrir le service', blockerReload: 'J’ai autorisé les annonces — recharger',
      blockerDismiss: 'Continuer la lecture', blockerClose: 'Fermer la promotion',
      reload: 'Recharger et vérifier', close: 'Continuer la lecture', preferences: 'Ouvrir les préférences de confidentialité',
      unavailable: 'Les préférences Google sont indisponibles. Vérifiez le blocage du navigateur et réessayez.',
      jobTitle: 'Un emploi en Suisse ? Nous le cherchons pour vous.', jobBody: 'Nous trouvons des offres adaptées à votre métier et préparons vos candidatures.',
      job: 'Voir comment ça marche', label: 'Un service Frontaliere Ticino', dismiss: 'Fermer cette suggestion',
    },
  } as const)[language as 'it' | 'en' | 'de' | 'fr'];
  const applicationPaths = {
    it: '/automatizza-ricerca-lavoro-svizzera/',
    en: '/en/automate-job-search-switzerland/',
    de: '/de/arbeitssuche-schweiz-automatisieren/',
    fr: '/fr/automatiser-recherche-emploi-suisse/',
  } as const;
  const readerSubscriptionPaths = config.readerSubscriptionPaths || [];
  const jobPath = applicationPaths[language as keyof typeof applicationPaths];
  // Keep the existing session keys so a same-session deployment does not
  // reopen a recovery prompt the visitor has already dismissed.
  const recoveryPromptSeenKey = 'ft_native_application_offer_seen_v1';
  const recoveryPromptDismissedKey = 'ft_native_application_offer_dismissed_v1';
  let path = location.pathname;
  let started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reportedState = '';
  let cmpReopenAt = 0;
  let nativeRecoveryReported = false;
  let adsAllowedOutcomeReported = false;
  let popup: HTMLDialogElement | null = null;
  let promo: HTMLElement | null = null;
  let probeResult = 'unknown';
  let probed = false;
  let prompted = false;
  let promoDismissed = false;
  let lastCmp = '';
  let lastOutcome = '';
  const storageRead = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const store = (key: string, value: string) => { try { sessionStorage.setItem(key, value); } catch { /* visit-local fallback */ } };
  const promptWasShown = () => w.__ftNativeApplicationOfferShown === true || storageRead(recoveryPromptSeenKey) === '1';
  const rememberPromptShown = () => { w.__ftNativeApplicationOfferShown = true; store(recoveryPromptSeenKey, '1'); };
  const promptWasDismissed = () => storageRead(recoveryPromptDismissedKey) === '1';
  const nativeRecoveryWasShown = () => nativeRecoveryReported || storageRead('ft_ad_recovery_google_prompted') === '1';
  const hasDecision = () => { try { return /^(granted|denied)$/.test((w as RecoveryWindow & { __ftAdsConsentDecision?: string }).__ftAdsConsentDecision || localStorage.getItem(config.consentKey) || ''); } catch { return false; } };
  const onScreen = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
    }
    return true;
  };
  const googleMessage = () => Array.from(document.querySelectorAll('.fc-consent-root,.fc-ab-root,.fc-monetization-dialog-container')).some(onScreen);
  const googleAdBlockRecoveryMessage = () => Array.from(document.querySelectorAll('.fc-ab-root')).some(onScreen);
  const visibleDialog = () => Array.from(document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')).some(onScreen);
  // Several owners publish the same Google result on different nodes: the
  // AdSense <ins>, our React wrapper, or the static-shell wrapper. Treat all
  // of them as occupied so recovery only considers genuinely empty slots.
  const occupiedAdSelector = 'ins[data-ad-status="filled"],ins[data-ad-status="unfill-optimized"],ins[data-anchor-status="displayed"],[data-ad-state="filled"],[data-ad-state="optimized"],[data-ft-ad-state="filled"],[data-ft-ad-state="optimized"],[data-ft-static-ad-state="filled"],[data-ft-static-ad-state="optimized"]';
  const occupied = (frame: HTMLElement) => frame.matches(occupiedAdSelector) || !!frame.querySelector(occupiedAdSelector);
  const hasOccupiedAd = () => !!document.querySelector(occupiedAdSelector);
  const hasUnfilledHouseSlot = () => Array.from(document.querySelectorAll<HTMLElement>('[data-house]')).some((frame) => {
    const google = frame.querySelector<HTMLElement>('[data-ft-house-google],ins[data-ad-slot]');
    if (!google) return false;
    return !occupied(frame);
  });
  const hasPendingInlineHouseSlot = () => Array.from(document.querySelectorAll<HTMLElement>('[data-house][data-ft-house-eligible]')).some((frame) => {
    const google = frame.querySelector<HTMLElement>('[data-ft-house-google],ins[data-ad-slot]');
    if ((!google && !frame.hasAttribute('data-ft-house-blocker-only')) || occupied(frame) || !onScreen(frame)) return false;
    const bounds = frame.getBoundingClientRect();
    return bounds.width >= 160 && bounds.height > 0;
  });
  const hasRenderedInlineHouseCreative = () => Array.from(document.querySelectorAll<HTMLElement>('[data-house][data-ft-house-active]')).some((frame) => {
    const creative = frame.querySelector<HTMLElement>('[data-ft-house-host] .ft-house-creative');
    return !!creative && onScreen(creative);
  });
  const permitted = () => {
    try { return allowed() && navigator.onLine !== false && document.visibilityState !== 'hidden'
      && !Object.values(applicationPaths).some((servicePath) => location.pathname.startsWith(servicePath))
      && !readerSubscriptionPaths.some((servicePath) => location.pathname.replace(/\/+$/, '') === servicePath.replace(/\/+$/, '')); }
    catch { return false; }
  };
  const cmp = createLoader('cmp', `https://fundingchoicesmessages.google.com/i/${config.publisherId}?ers=1`, () => { try { return allowed() && navigator.onLine !== false; } catch { return false; } }, emit);
  const closePopup = () => { if (!popup) return; popup.close(); popup.remove(); popup = null; };
  const removePromo = () => { promo?.remove(); promo = null; };
  const button = (label: string, action: () => void, primary = false) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
    el.className = primary ? 'ft-recovery-primary' : 'ft-recovery-secondary'; el.addEventListener('click', action); return el;
  };
  const closeIconButton = (label: string, action: () => void) => {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'ft-recovery-close'; el.setAttribute('aria-label', label);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2');
    for (const [x1, y1, x2, y2] of [[6, 6, 18, 18], [18, 6, 6, 18]]) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1)); line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
      icon.appendChild(line);
    }
    el.appendChild(icon); el.addEventListener('click', action); return el;
  };
  const jobLink = () => {
    const link = document.createElement('a'); link.href = jobPath; link.className = 'ft-recovery-link'; link.textContent = copy.job;
    link.addEventListener('click', () => emit('ad_fallback_click', { campaign: 'job_search_automation', surface: popup ? 'popup' : 'banner', reason: reason() })); return link;
  };
  const applicationOfferLink = () => {
    const link = document.createElement('a');
    link.href = `${jobPath}?utm_source=frontaliere&utm_medium=native_ad&utm_campaign=application_concierge_adblock&utm_content=popup_creative_v1`;
    link.className = 'ft-recovery-primary ft-recovery-offer-link';
    link.textContent = copy.offerCta;
    link.addEventListener('click', () => emit('ad_fallback_click', { campaign: 'application_concierge_adblock', surface: 'popup', reason: reason() }));
    return link;
  };
  const reason = () => !w.__ftAdBlock?.adsAllowed && (w.__ftAdBlock?.blocked || probeResult === 'blocked') ? 'adblock_detected'
    : !hasDecision() && cmp.state() === 'failed' ? 'cmp_unavailable'
    : !hasDecision() && cmp.state() === 'waiting_response' ? 'cmp_timeout'
    : !hasDecision() && cmp.state() === 'loaded' && typeof w.googlefc?.showRevocationMessage !== 'function' ? 'cmp_api_missing'
    : !hasDecision() && cmpReopenAt > 0 && Date.now() - cmpReopenAt >= 2000 ? 'cmp_ui_missing'
    : !hasDecision() ? 'consent_pending'
    : document.querySelector('script[data-ft-script-state="retry_wait"][src*="adsbygoogle.js"],script[data-ft-script-state="loading"][src*="adsbygoogle.js"],script[data-ft-script-state="retry_wait"][src*="gpt.js"],script[data-ft-script-state="loading"][src*="gpt.js"]') ? 'response_pending'
    : document.querySelector('script[data-ft-script-state="waiting_response"][src*="adsbygoogle.js"],script[data-ft-script-state="waiting_response"][src*="gpt.js"]') ? 'script_timeout'
    : document.querySelector('[data-ft-ad-request-pending],[data-ft-static-ad-state="loading"],[data-ft-static-ad-state="waiting_response"],[data-ft-ad-state="loading"],[data-ft-ad-state="waiting_response"],[data-ad-state="waiting_response"],[data-ad-state="loading"][data-google-query-id],[data-ad-state="loading"] [data-google-query-id]') ? 'response_pending'
    : document.querySelector('script[data-failed="1"]:not([data-ft-script-state="retry_wait"]):not([data-ft-script-state="loaded"])[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"],script[data-failed="1"]:not([data-ft-script-state="retry_wait"]):not([data-ft-script-state="loaded"])[src*="securepubads.g.doubleclick.net/tag/js/gpt.js"]') ? 'script_failed'
    : document.querySelector('ins[data-ad-status="unfilled"]') ? 'no_fill'
    : document.querySelector('[data-ft-ad-width-wait]') ? 'invalid_width'
    : 'response_pending';
  const reload = () => {
    store('ft_ad_recovery_reload', String(Date.now()));
    emit('ad_recovery_action', { action: 'reload', reason: reason() }); location.reload();
  };
  const preferences = () => {
    emit('ad_recovery_action', { action: 'open_cmp', reason: reason() });
    closePopup(); removePromo();
    // This opens the certified Google CMP. It never writes our consent key or
    // fabricates a TCF string from the click on the publisher's own message.
    if (typeof w.googlefc?.showRevocationMessage === 'function') w.googlefc.showRevocationMessage();
    else {
      cmp.load();
      const g = w.googlefc = w.googlefc || {};
      if (!g.__ftRevocationQueued) {
        g.__ftRevocationQueued = true;
        (g.callbackQueue = g.callbackQueue || []).push({ CONSENT_DATA_READY: () => { g.__ftRevocationQueued = false; w.googlefc?.showRevocationMessage?.(); } });
      }
    }
    schedule();
  };
  const showPopup = () => {
    if (popup || prompted || storageRead('ft_ad_recovery_prompted') || nativeRecoveryWasShown() || googleMessage() || visibleDialog()) return;
    // A confirmed blocker gets the localized application-service offer;
    // terminal loader errors keep neutral recovery guidance.
    if (w.__ftAdBlock?.adsAllowed) return;
    const positive = probeResult === 'blocked' || w.__ftAdBlock?.blocked === true;
    if (!positive && reason() !== 'script_failed' && reason() !== 'cmp_unavailable') return;
    if (positive && (promptWasShown() || promptWasDismissed())) return;
    if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return;
    prompted = true; store('ft_ad_recovery_prompted', '1'); removePromo();
    const dialog = document.createElement('dialog'); popup = dialog; dialog.className = 'ft-recovery-dialog';
    dialog.setAttribute('aria-labelledby', 'ft-recovery-title');
    dialog.setAttribute('aria-describedby', 'ft-recovery-body');
    const title = document.createElement('h2'); title.id = 'ft-recovery-title'; title.textContent = positive ? copy.blockerTitle : copy.problemTitle;
    const body = document.createElement('p'); body.id = 'ft-recovery-body'; body.textContent = positive ? copy.blockerBody : copy.problemBody;
    const close = () => {
      if (positive) store(recoveryPromptDismissedKey, '1');
      emit('ad_recovery_action', { action: positive ? 'dismiss' : 'close', reason: reason() });
      closePopup(); refresh();
    };
    dialog.appendChild(closeIconButton(positive ? copy.blockerClose : copy.dismiss, close));
    dialog.append(title, body);
    if (positive) {
      const details = document.createElement('div'); details.className = 'ft-recovery-offer-details';
      const terms = document.createElement('div'); terms.className = 'ft-recovery-offer-terms';
      const duration = document.createElement('strong'); duration.textContent = copy.offerDuration;
      const limit = document.createElement('span'); limit.textContent = copy.offerLimit;
      terms.append(duration, limit);
      const price = document.createElement('div'); price.className = 'ft-recovery-offer-price';
      const amount = document.createElement('strong'); amount.textContent = copy.offerPrice;
      const priceNote = document.createElement('span'); priceNote.textContent = copy.offerPriceNote;
      price.append(amount, priceNote);
      details.append(terms, price);
      const support = document.createElement('p'); support.className = 'ft-recovery-offer-support'; support.textContent = copy.offerSupport;
      const disclaimer = document.createElement('p'); disclaimer.className = 'ft-recovery-offer-disclaimer'; disclaimer.textContent = copy.offerDisclaimer;
      dialog.append(details, support, disclaimer);
      const actions = document.createElement('div'); actions.className = 'ft-recovery-actions';
      actions.append(applicationOfferLink());
      actions.append(button(copy.blockerReload, reload));
      actions.append(button(copy.blockerDismiss, close));
      dialog.append(actions);
    } else {
      const actions = document.createElement('div'); actions.className = 'ft-recovery-actions';
      actions.append(button(copy.reload, reload, true));
      actions.append(button(copy.preferences, preferences));
      actions.append(button(copy.close, close));
      dialog.append(actions, jobLink());
    }
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.remove(); popup = null; return; }
    if (positive) rememberPromptShown();
    emit('ad_recovery_prompt', { source: w.__ftAdBlock?.blocked ? 'funding_choices' : positive ? 'iab_quick_bait' : 'script_error', reason: reason(), campaign: positive ? 'application_concierge_adblock' : 'ad_recovery' });
  };
  const showPromo = () => {
    if (promo || popup || promoDismissed || googleMessage() || visibleDialog()) return;
    const card = document.createElement('aside'); promo = card; card.className = 'ft-recovery-promo'; card.setAttribute('aria-label', copy.label);
    const title = document.createElement('p'); title.className = 'ft-recovery-promo-title'; title.textContent = copy.jobTitle;
    const body = document.createElement('p'); body.textContent = copy.jobBody;
    card.append(title, body, jobLink());
    if (!hasDecision()) {
      if (cmp.state() === 'failed' || cmp.state() === 'waiting_response' || reason() === 'cmp_ui_missing' || reason() === 'cmp_api_missing') {
        const status = document.createElement('p'); status.textContent = copy.unavailable;
        card.append(status, button(copy.reload, reload));
      } else card.append(button(copy.preferences, preferences));
    }
    card.append(button(copy.dismiss, () => { emit('ad_fallback_dismiss', { campaign: 'job_search_automation', reason: reason() }); promoDismissed = true; removePromo(); }));
    // Independent first-party content, outside every Google slot/iframe. A
    // fixed compact placement preserves layout; any Google fill removes it.
    document.body.appendChild(card);
    emit('ad_fallback_shown', { campaign: 'job_search_automation', reason: reason() });
  };
  function schedule() { if (refreshTimer !== undefined) return; refreshTimer = setTimeout(() => { refreshTimer = undefined; refresh(); }, 100); }
  function refresh() {
    clearTimeout(timer);
    if (!document.body) return;
    // Resume through route/consent/foreground events; forbidden routes and
    // background documents do not retain an otherwise idle polling loop.
    if (typeof MutationObserver !== 'function' && permitted()) {
      if (pollTimer === undefined) pollTimer = setInterval(schedule, 1000);
    } else { clearInterval(pollTimer); pollTimer = undefined; }
    if (location.pathname !== path) {
      path = location.pathname; started = Date.now(); reportedState = ''; removePromo(); closePopup();
    }
    if (!permitted()) { removePromo(); closePopup(); return; }
    if (!adsAllowedOutcomeReported && w.__ftAdBlock?.adsAllowed === true
        && storageRead('ft_ad_recovery_ads_allowed_reported') !== '1') {
      adsAllowedOutcomeReported = true;
      store('ft_ad_recovery_ads_allowed_reported', '1');
      emit('ad_recovery_outcome', { outcome: 'ads_allowed', evidence: 'funding_choices_status' });
    }
    if (cmp.state() === 'idle') cmp.load();
    const ready = typeof w.googlefc?.showRevocationMessage === 'function';
    const state = ready ? 'ready' : cmp.state() === 'failed' ? 'unavailable' : hasDecision() ? 'stored_decision' : 'waiting';
    if (state !== lastCmp) { lastCmp = state; emit('ad_cmp_state', { state, decision: hasDecision() ? 'present' : 'none' }); }
    // Probe once an inline slot can still need replacement. Waiting six
    // seconds left blocked slots blank, while the filled() shortcut below
    // skipped detection when a different placement had filled.
    if (!probed && (config.inlineHouseAds ? hasUnfilledHouseSlot() : !hasOccupiedAd())) {
      probed = true;
      const probeStartedAt = Date.now();
      const probePath = location.pathname;
      void probe().then((result) => {
        probeResult = result;
        w.__ftAdBlockProbe = result;
        const reportProbe = () => {
          const stillRelevant = config.inlineHouseAds ? hasUnfilledHouseSlot() : !hasOccupiedAd();
          if (location.pathname === probePath && stillRelevant) emit('ad_block_probe', { source: 'iab_quick_bait', result });
        };
        const reportDelay = result === 'blocked' ? 0 : Math.max(0, 6000 - (Date.now() - probeStartedAt));
        if (reportDelay === 0) reportProbe(); else setTimeout(reportProbe, reportDelay);
        try { w.__ftHouseAds?.refresh(); } catch { /* Keep recovery independent of the creative renderer. */ }
        refresh();
      }).catch(() => {});
    }
    if (googleAdBlockRecoveryMessage() && !nativeRecoveryWasShown()) {
      nativeRecoveryReported = true;
      store('ft_ad_recovery_google_prompted', '1');
      emit('ad_recovery_prompt', { source: 'funding_choices_native', reason: 'adblock_detected', prompt_action: 'shown' });
    }
    if (googleMessage()) { removePromo(); closePopup(); return; }
    const inlineSlotPending = config.inlineHouseAds === true && hasPendingInlineHouseSlot();
    const inlineCreativeRendered = config.inlineHouseAds === true && hasRenderedInlineHouseCreative();
    // An eligible inline slot gets the first chance to render its creative.
    // Avoid racing it with a dismissible publisher modal while assignment or
    // the creative renderer is still in flight.
    if (config.inlineHouseAds && (inlineSlotPending || inlineCreativeRendered || nativeRecoveryWasShown())) closePopup();
    if (hasOccupiedAd() && !(config.inlineHouseAds && inlineSlotPending)) {
      removePromo(); closePopup();
      const pending = Number(storageRead('ft_ad_recovery_reload'));
      if (pending > 0 && Date.now() - pending < 300000 && lastOutcome !== 'ads_restored') {
        lastOutcome = 'ads_restored'; store('ft_ad_recovery_reload', '');
        emit('ad_recovery_outcome', { outcome: 'ads_restored', evidence: 'filled_dom' });
      }
      return;
    }
    const age = Date.now() - started;
    if (age < 12000) { timer = setTimeout(refresh, 12000 - age); return; }
    // Merely waiting for a response is not failure: do not cover late Auto Ads
    // or show our promotion while a valid ad request can still fill.
    if (!hasDecision() && ready && !cmpReopenAt) {
      cmpReopenAt = Date.now();
      try { w.googlefc?.showRevocationMessage?.(); emit('ad_cmp_recovery', { action: 'reopen_missing_ui' }); }
      catch { emit('ad_cmp_recovery', { action: 'reopen_failed' }); }
      timer = setTimeout(refresh, 2000);
      return;
    }
    const why = reason();
    if (reportedState !== why) {
      reportedState = why;
      emit('ad_reliability_state', { reason: why, cmp_state: state, probe: probeResult, decision: hasDecision() ? 'present' : 'none', elapsed_ms: Math.min(600000, Date.now() - started) });
    }
    // Inline creatives replace the publisher modal while an eligible slot is
    // being populated, and after it renders. Keep recovery available only when
    // the page has no usable inline slot.
    if (config.inlineHouseAds) {
      if (hasRenderedInlineHouseCreative() || nativeRecoveryWasShown()) {
        closePopup();
        removePromo(); return;
      }
      if (inlineSlotPending) {
        closePopup();
        removePromo(); return;
      }
      if (why === 'adblock_detected' || why === 'script_failed' || why === 'cmp_unavailable') showPopup();
      removePromo(); return;
    }
    if (why === 'adblock_detected' || why === 'script_failed' || why === 'cmp_unavailable') showPopup();
    if (why !== 'response_pending' && why !== 'consent_pending' && why !== 'script_timeout' && why !== 'cmp_timeout') showPromo();
    else { closePopup(); removePromo(); }
    const pending = Number(storageRead('ft_ad_recovery_reload'));
    if (pending > 0 && Date.now() - pending < 300000 && lastOutcome !== why) {
      lastOutcome = why; emit('ad_recovery_outcome', { outcome: 'not_restored', reason: why });
    }
  }
  const start = () => {
    if (!document.getElementById('ft-recovery-style')) {
      const style = document.createElement('style'); style.id = 'ft-recovery-style';
      style.textContent = ".ft-recovery-dialog,.ft-recovery-promo{box-sizing:border-box;background:var(--_surface,Canvas);color:var(--_body,CanvasText);font:400 16px/1.5 Inter,system-ui,sans-serif;padding:24px;border:1px solid var(--_edge,ButtonBorder);border-radius:12px}.ft-recovery-dialog{position:relative;margin:auto;width:min(520px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto}.ft-recovery-dialog::backdrop{background:color-mix(in srgb,var(--_heading,CanvasText) 45%,transparent)}.ft-recovery-dialog h2{font:600 24px/1.25 \"Space Grotesk\",system-ui,sans-serif;color:var(--_heading,CanvasText);margin:0 0 16px;padding-inline-end:40px}.ft-recovery-dialog p,.ft-recovery-promo p{margin:0 0 16px}.ft-recovery-actions{display:flex;flex-direction:column;gap:8px;margin:20px 0 0}.ft-recovery-primary,.ft-recovery-secondary{font:inherit;cursor:pointer;min-height:44px;padding:10px 14px;border-radius:8px;border:1px solid var(--_edge,ButtonBorder);background:var(--_surface-alt,Canvas);color:var(--_body,CanvasText)}.ft-recovery-primary{background:var(--_accent,Highlight);color:var(--_on-accent,HighlightText);border-color:transparent}.ft-recovery-primary:hover{background:var(--_accent-hover,Highlight)}.ft-recovery-secondary:hover,.ft-recovery-close:hover{background:var(--_surface-raised,Canvas)}.ft-recovery-link{display:inline-block;color:var(--_link,LinkText);text-underline-offset:3px;font-weight:600;padding:10px 0;min-height:44px}.ft-recovery-offer-link{display:flex;align-items:center;justify-content:center;text-align:center;text-decoration:none}.ft-recovery-offer-details{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;border-top:1px solid var(--_edge,ButtonBorder);padding-top:16px;margin:8px 0 16px}.ft-recovery-offer-terms,.ft-recovery-offer-price{display:flex;flex-direction:column;gap:4px}.ft-recovery-offer-terms{font-size:14px;color:var(--_subtle,GrayText)}.ft-recovery-offer-terms strong,.ft-recovery-offer-price strong{color:var(--_heading,CanvasText)}.ft-recovery-offer-price{text-align:right}.ft-recovery-offer-price strong{font:700 28px/1.1 \"Space Grotesk\",system-ui,sans-serif;white-space:nowrap}.ft-recovery-offer-price span,.ft-recovery-offer-disclaimer{font-size:12px;color:var(--_subtle,GrayText)}.ft-recovery-offer-support{padding:12px 14px;border-radius:8px;background:var(--_surface-alt,Canvas);font-size:13px}.ft-recovery-offer-disclaimer{margin-bottom:0!important}.ft-recovery-primary:focus-visible,.ft-recovery-secondary:focus-visible,.ft-recovery-link:focus-visible,.ft-recovery-close:focus-visible{outline:2px solid var(--_accent,Highlight);outline-offset:3px}.ft-recovery-close{position:absolute;inset:8px 8px auto auto;display:grid;place-items:center;width:44px;height:44px;padding:0;border:1px solid var(--_edge,ButtonBorder);border-radius:8px;background:var(--_surface,Canvas);color:var(--_body,CanvasText);cursor:pointer}.ft-recovery-close svg{width:20px;height:20px}.ft-recovery-promo{position:fixed;z-index:90;inset:auto 16px calc(80px + env(safe-area-inset-bottom)) auto;width:min(360px,calc(100vw - 32px));padding:16px;box-shadow:var(--shadow-stripe-lg,none)}.ft-recovery-promo-title{font-weight:600;color:var(--_heading,CanvasText)}.ft-recovery-promo button{display:block;width:100%;margin-top:8px}@media(max-width:420px){.ft-recovery-dialog{padding:20px}.ft-recovery-offer-details{gap:8px}.ft-recovery-offer-price strong{font-size:24px}.ft-recovery-offer-terms{font-size:12px}}";
      document.head.appendChild(style);
    }
    cmp.load();
    cmp.subscribe(schedule);
    if (typeof MutationObserver === 'function') {
      const relevant = 'ins[data-ad-slot],ins[data-ad-status],ins[data-anchor-status],[data-ad-state],[data-ft-ad-state],[data-ft-ad-request-pending],[data-google-query-id],script[src*="adsbygoogle.js"],script[src*="gpt.js"],script[src*="fundingchoicesmessages.google.com"],.fc-consent-root,.fc-ab-root,.fc-monetization-dialog-container,dialog,[role="dialog"]';
      const related = (node: Node) => node.nodeType === 1 && ((node as Element).matches(relevant) || !!(node as Element).querySelector(relevant));
      const observer = new MutationObserver((records) => {
        if (!records.some((record) => {
          if ((record.target as Element).closest?.('.ft-recovery-dialog,.ft-recovery-promo')) return false;
          if (record.type === 'attributes') {
            if (record.attributeName === 'data-ft-ad-request-pending' || record.attributeName === 'data-google-query-id') return true;
            if (record.attributeName === 'class' || record.attributeName === 'style') {
              return related(record.target) || /(?:^|\s)fc-(?:consent-root|ab-root|monetization-dialog-container)(?:\s|$)/.test(record.oldValue || '');
            }
            return (record.target as Element).matches(relevant);
          }
          return Array.from(record.addedNodes).some(related) || Array.from(record.removedNodes).some(related);
        })) return;
        schedule();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-ad-status', 'data-anchor-status', 'data-ad-state', 'data-ft-ad-state', 'data-ft-static-ad-state', 'data-ft-ad-request-pending', 'data-google-query-id', 'data-ft-ad-width-wait', 'data-failed', 'data-ft-script-state', 'class', 'style', 'open', 'hidden', 'aria-modal'] });
    }
    for (const name of [config.consentEvent, 'frontaliere:adblock-data', 'storage', 'popstate', 'seo-tracking:pushstate', 'seo-tracking:replacestate']) window.addEventListener(name, schedule);
    document.addEventListener('visibilitychange', () => {
      // A background-clamped timeout must not delay checking an ad that
      // filled while the visitor was away from this tab.
      clearTimeout(refreshTimer); refreshTimer = undefined; refresh();
    });
    window.addEventListener('online', schedule);
    refresh();
  };
  const api = { refresh }; w.__ftAdRecovery = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  return api;
}
