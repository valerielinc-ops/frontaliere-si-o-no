/** One recovery surface for static and SPA pages. No experiment assignment,
 * synthetic consent, extension manipulation, or changes to Google's ad DOM.
 * All collaborators are injected because the static loader serializes this.
 */
export function installAdRecovery(
  probe: () => Promise<'blocked' | 'clear' | 'unknown'>,
  createLoader: (kind: 'cmp', src: string, allowed: () => boolean, emit: (event: string, props: Record<string, string | number>) => void) => { load: () => void; state: () => string; subscribe: (listener: (state: string) => void) => () => void },
  emit: (event: string, props: Record<string, string | number>) => void,
  allowed: () => boolean,
  config: { consentKey: string; consentEvent: string; publisherId: string },
) {
  type RecoveryWindow = Window & { __ftAdRecovery?: { refresh: () => void }; __ftAdBlock?: { blocked?: boolean; adsAllowed?: boolean }; googlefc?: { showRevocationMessage?: () => void; callbackQueue?: unknown[]; __ftRevocationQueued?: boolean }; __ftAdBlockProbe?: string };
  const w = window as RecoveryWindow;
  if (w.__ftAdRecovery) { w.__ftAdRecovery.refresh(); return w.__ftAdRecovery; }
  const rawLanguage = (document.documentElement.lang || 'it').slice(0, 2);
  const language = ['it', 'en', 'de', 'fr'].includes(rawLanguage) ? rawLanguage : 'it';
  const copy = ({
    it: { problemTitle: "Gli annunci non si caricano", problemBody: "Un problema di rete o un blocco del browser può impedire il caricamento. Puoi verificare le impostazioni per questo sito e riprovare.", title: 'Ci aiuti a mantenere gratuito il sito?', body: 'Abbiamo rilevato un blocco pubblicitario. Puoi autorizzare gli annunci per frontaliereticino.ch dalle impostazioni del browser o dell’estensione.', allow: 'Come autorizzare il sito', instructions: 'Apri l’estensione e disattiva il blocco solo per questo sito. In Brave, apri l’icona del leone e disattiva Shields per questo sito. Poi ricarica la pagina.', reload: 'Ricarica e verifica', close: 'Continua a leggere', preferences: 'Apri le preferenze privacy', unavailable: 'Le preferenze di Google non sono disponibili. Controlla il blocco del browser e riprova.', jobTitle: 'Automatizza la ricerca di lavoro in Svizzera', jobBody: 'Scopri il nostro servizio per semplificare la ricerca e le candidature.', job: 'Scopri il servizio', label: 'Servizio Frontaliere Ticino', dismiss: 'Chiudi il suggerimento', retry: 'Riprova le preferenze' },
    en: { problemTitle: "Ads are not loading", problemBody: "A network problem or browser blocking may prevent loading. You can check this site’s settings and try again.", title: 'Help us keep this site free', body: 'We detected ad blocking. You can allow ads for frontaliereticino.ch in your browser or extension settings.', allow: 'How to allow this site', instructions: 'Open your extension and pause blocking for this site only. In Brave, open the lion icon and turn off Shields for this site. Then reload the page.', reload: 'Reload and check', close: 'Continue reading', preferences: 'Open privacy preferences', unavailable: 'Google privacy preferences are unavailable. Check your browser’s blocking settings and try again.', jobTitle: 'Automate your Swiss job search', jobBody: 'Explore our service to simplify your job search and applications.', job: 'Explore the service', label: 'A Frontaliere Ticino service', dismiss: 'Close this suggestion', retry: 'Retry privacy preferences' },
    de: { problemTitle: "Anzeigen werden nicht geladen", problemBody: "Ein Netzwerkproblem oder der Browser-Schutz kann das Laden verhindern. Prüfen Sie die Einstellungen für diese Website und versuchen Sie es erneut.", title: 'Helfen Sie uns, die Website kostenlos zu halten', body: 'Wir haben einen Werbeblocker erkannt. Sie können Werbung für frontaliereticino.ch im Browser oder in der Erweiterung erlauben.', allow: 'So erlauben Sie diese Website', instructions: 'Öffnen Sie die Erweiterung und pausieren Sie den Schutz nur für diese Website. In Brave öffnen Sie das Löwensymbol und deaktivieren Shields für diese Website. Laden Sie danach die Seite neu.', reload: 'Neu laden und prüfen', close: 'Weiterlesen', preferences: 'Datenschutzeinstellungen öffnen', unavailable: 'Googles Datenschutzeinstellungen sind nicht verfügbar. Prüfen Sie den Browser-Schutz und versuchen Sie es erneut.', jobTitle: 'Automatisieren Sie Ihre Jobsuche in der Schweiz', jobBody: 'Entdecken Sie unseren Service für eine einfachere Jobsuche und Bewerbung.', job: 'Service entdecken', label: 'Ein Service von Frontaliere Ticino', dismiss: 'Hinweis schließen', retry: 'Datenschutzeinstellungen erneut laden' },
    fr: { problemTitle: "Les annonces ne se chargent pas", problemBody: "Un problème réseau ou un blocage du navigateur peut empêcher le chargement. Vous pouvez vérifier les réglages de ce site et réessayer.", title: 'Aidez-nous à garder ce site gratuit', body: 'Nous avons détecté un bloqueur de publicités. Vous pouvez autoriser les annonces pour frontaliereticino.ch dans votre navigateur ou extension.', allow: 'Comment autoriser ce site', instructions: 'Ouvrez votre extension et désactivez le blocage pour ce site uniquement. Dans Brave, ouvrez l’icône du lion et désactivez Shields pour ce site. Rechargez ensuite la page.', reload: 'Recharger et vérifier', close: 'Continuer la lecture', preferences: 'Ouvrir les préférences de confidentialité', unavailable: 'Les préférences Google sont indisponibles. Vérifiez le blocage du navigateur et réessayez.', jobTitle: 'Automatisez votre recherche d’emploi en Suisse', jobBody: 'Découvrez notre service pour simplifier votre recherche et vos candidatures.', job: 'Découvrir le service', label: 'Un service Frontaliere Ticino', dismiss: 'Fermer cette suggestion', retry: 'Réessayer les préférences' },
  } as const)[language as 'it' | 'en' | 'de' | 'fr'];
  const jobPath = '/automatizza-ricerca-lavoro-svizzera/';
  let path = location.pathname;
  let started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reportedState = '';
  let cmpReopenAt = 0;
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
  const hasDecision = () => { try { return /^(granted|denied)$/.test((w as RecoveryWindow & { __ftAdsConsentDecision?: string }).__ftAdsConsentDecision || localStorage.getItem(config.consentKey) || ''); } catch { return false; } };
  const onScreen = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
    }
    return true;
  };
  const googleMessage = () => Array.from(document.querySelectorAll('.fc-consent-root,.fc-ab-root,.fc-monetization-dialog-container')).some(onScreen);
  const filled = () => !!document.querySelector('ins[data-ad-status="filled"],ins[data-anchor-status="displayed"],[data-ad-state="filled"]');
  const permitted = () => {
    try { return allowed() && navigator.onLine !== false && document.visibilityState !== 'hidden' && !location.pathname.startsWith(jobPath); }
    catch { return false; }
  };
  const cmp = createLoader('cmp', `https://fundingchoicesmessages.google.com/i/${config.publisherId}?ers=1`, () => { try { return allowed() && navigator.onLine !== false; } catch { return false; } }, emit);
  const closePopup = () => { if (!popup) return; popup.close(); popup.remove(); popup = null; };
  const removePromo = () => { promo?.remove(); promo = null; };
  const button = (label: string, action: () => void, primary = false) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
    el.className = primary ? 'ft-recovery-primary' : 'ft-recovery-secondary'; el.addEventListener('click', action); return el;
  };
  const jobLink = () => {
    const link = document.createElement('a'); link.href = jobPath; link.className = 'ft-recovery-link'; link.textContent = copy.job;
    link.addEventListener('click', () => emit('ad_fallback_click', { campaign: 'job_search_automation', surface: popup ? 'popup' : 'banner', reason: reason() })); return link;
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
    if (popup || prompted || storageRead('ft_ad_recovery_prompted') || googleMessage()) return;
    // Positive detection uses ad-block copy; a terminal script error gets a
    // neutral explanation. Slow responses, no-fill and unanswered consent do
    // not trigger a modal.
    if (w.__ftAdBlock?.adsAllowed) return;
    const positive = probeResult === 'blocked' || w.__ftAdBlock?.blocked === true;
    if (!positive && reason() !== 'script_failed' && reason() !== 'cmp_unavailable') return;
    if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return;
    prompted = true; store('ft_ad_recovery_prompted', '1'); removePromo();
    const dialog = document.createElement('dialog'); popup = dialog; dialog.className = 'ft-recovery-dialog';
    dialog.setAttribute('aria-labelledby', 'ft-recovery-title');
    const title = document.createElement('h2'); title.id = 'ft-recovery-title'; title.textContent = positive ? copy.title : copy.problemTitle;
    const body = document.createElement('p'); body.textContent = positive ? copy.body : copy.problemBody;
    const instructions = document.createElement('p'); instructions.hidden = true; instructions.textContent = copy.instructions;
    const actions = document.createElement('div'); actions.className = 'ft-recovery-actions';
    if (positive) actions.append(button(copy.allow, () => { instructions.hidden = false; emit('ad_recovery_action', { action: 'instructions', reason: reason() }); }, true));
    actions.append(button(copy.reload, reload, !positive));
    actions.append(button(copy.preferences, preferences));
    actions.append(button(copy.close, () => { emit('ad_recovery_action', { action: 'dismiss', reason: reason() }); closePopup(); refresh(); }));
    dialog.append(title, body, instructions, actions, jobLink());
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closePopup(); refresh(); });
    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.remove(); popup = null; return; }
    emit('ad_recovery_prompt', { source: w.__ftAdBlock?.blocked ? 'funding_choices' : positive ? 'iab_quick_bait' : 'script_error', reason: reason() });
  };
  const showPromo = () => {
    if (promo || popup || promoDismissed || googleMessage() || document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) return;
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
    if (cmp.state() === 'idle') cmp.load();
    const ready = typeof w.googlefc?.showRevocationMessage === 'function';
    const state = ready ? 'ready' : cmp.state() === 'failed' ? 'unavailable' : hasDecision() ? 'stored_decision' : 'waiting';
    if (state !== lastCmp) { lastCmp = state; emit('ad_cmp_state', { state, decision: hasDecision() ? 'present' : 'none' }); }
    if (filled()) {
      removePromo(); closePopup();
      const pending = Number(storageRead('ft_ad_recovery_reload'));
      if (pending > 0 && Date.now() - pending < 300000 && lastOutcome !== 'ads_restored') {
        lastOutcome = 'ads_restored'; store('ft_ad_recovery_reload', '');
        emit('ad_recovery_outcome', { outcome: 'ads_restored', evidence: 'filled_dom' });
      }
      return;
    }
    if (googleMessage()) { removePromo(); closePopup(); return; }
    const age = Date.now() - started;
    if (!probed && age >= 6000) {
      probed = true;
      void probe().then((result) => { probeResult = result; w.__ftAdBlockProbe = result; emit('ad_block_probe', { source: 'iab_quick_bait', result }); refresh(); }).catch(() => {});
    }
    if (age < 12000) { timer = setTimeout(refresh, age < 6000 ? 6000 - age : 12000 - age); return; }
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
      style.textContent = '.ft-recovery-dialog,.ft-recovery-promo{box-sizing:border-box;background:var(--_surface,Canvas);color:var(--_body,CanvasText);font:400 16px/1.5 Inter,system-ui,sans-serif;padding:24px;border:1px solid var(--_edge,ButtonBorder);border-radius:12px}.ft-recovery-dialog{margin:auto;width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto}.ft-recovery-dialog::backdrop{background:color-mix(in srgb,var(--_heading,CanvasText) 45%,transparent)}.ft-recovery-dialog h2{font:600 24px/1.25 "Space Grotesk",system-ui,sans-serif;color:var(--_heading,CanvasText);margin:0 0 16px}.ft-recovery-dialog p,.ft-recovery-promo p{margin:0 0 16px}.ft-recovery-actions{display:flex;flex-direction:column;gap:8px;margin:24px 0 16px}.ft-recovery-primary,.ft-recovery-secondary{font:inherit;cursor:pointer;min-height:44px;padding:10px 14px;border-radius:8px;border:1px solid var(--_edge,ButtonBorder);background:var(--_surface-alt,Canvas);color:var(--_body,CanvasText)}.ft-recovery-primary{background:var(--_accent,Highlight);color:var(--_on-accent,HighlightText);border-color:transparent}.ft-recovery-primary:hover{background:var(--_accent-hover,Highlight)}.ft-recovery-secondary:hover{background:var(--_surface-raised,Canvas)}.ft-recovery-link{display:inline-block;color:var(--_link,LinkText);text-underline-offset:3px;font-weight:600;padding:10px 0;min-height:44px}.ft-recovery-primary:focus-visible,.ft-recovery-secondary:focus-visible,.ft-recovery-link:focus-visible{outline:2px solid var(--_accent,Highlight);outline-offset:3px}.ft-recovery-promo{position:fixed;z-index:90;inset:auto 16px calc(80px + env(safe-area-inset-bottom)) auto;width:min(360px,calc(100vw - 32px));padding:16px;box-shadow:var(--shadow-stripe-lg,none)}.ft-recovery-promo-title{font-weight:600;color:var(--_heading,CanvasText)}.ft-recovery-promo button{display:block;width:100%;margin-top:8px}';
      document.head.appendChild(style);
    }
    cmp.load();
    cmp.subscribe(schedule);
    if (typeof MutationObserver === 'function') {
      const relevant = 'ins[data-ad-slot],ins[data-ad-status],ins[data-anchor-status],[data-ad-state],[data-ft-ad-state],[data-ft-ad-request-pending],[data-google-query-id],script[src*="adsbygoogle.js"],script[src*="gpt.js"],script[src*="fundingchoicesmessages.google.com"],.fc-consent-root,.fc-ab-root,.fc-monetization-dialog-container';
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
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-ad-status', 'data-anchor-status', 'data-ad-state', 'data-ft-ad-state', 'data-ft-static-ad-state', 'data-ft-ad-request-pending', 'data-google-query-id', 'data-ft-ad-width-wait', 'data-failed', 'data-ft-script-state', 'class', 'style'] });
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
