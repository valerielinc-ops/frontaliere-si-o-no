/**
 * Analytics Service - Firebase Analytics (GA4)
 * 
 * Usa SOLO Firebase Analytics SDK (che invia a GA4 tramite measurementId).
 * NON serve react-ga4 separato: Firebase Analytics già invia a Google Analytics 4.
 * 
 * PERFORMANCE: Firebase SDK viene caricato LAZILY al primo uso,
 * non al caricamento del modulo. Questo evita di includere ~700KB
 * di Firebase nel bundle critico iniziale.
 * 
 * Best practices implementate:
 * - Eventi GA4 raccomandati (screen_view, select_content, share, generate_lead, search)
 * - User properties per segmentazione (worker_type, theme, locale)
 * - Engagement tracking (tempo sulla pagina, profondità scroll)
 * - Nomi eventi in snake_case (max 40 char, convenzione Firebase)
 * - Parametri personalizzati per report custom
 */

// ─── Lazy Firebase Loading ─────────────────────────────────────

let _analytics: any = null;
let _logEvent: any = null;
let _setUserProperties: any = null;
let _firebaseLoading: Promise<void> | null = null;

async function ensureFirebase(): Promise<void> {
  if (_analytics) return;
  if (_firebaseLoading) return _firebaseLoading;
  _firebaseLoading = (async () => {
    try {
      const [firebaseModule, analyticsModule] = await Promise.all([
        import('./firebase'),
        import('firebase/analytics'),
      ]);
      _analytics = firebaseModule.analytics;
      _logEvent = analyticsModule.logEvent;
      _setUserProperties = analyticsModule.setUserProperties;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[Analytics] Failed to load Firebase', error);
      }
    }
  })();
  return _firebaseLoading;
}

// ─── Core Helper ───────────────────────────────────────────────

// Queue events that fire before Firebase is loaded
const _eventQueue: Array<{ type: 'log' | 'props'; args: any[] }> = [];
let _firebaseReady = false;

function flushQueue() {
  if (!_firebaseReady) return;
  while (_eventQueue.length > 0) {
    const event = _eventQueue.shift()!;
    if (event.type === 'log') {
      _doLog(event.args[0], event.args[1]);
    } else {
      _doSetProps(event.args[0]);
    }
  }
}

function _doLog(eventName: string, params?: Record<string, any>) {
  try {
    if (_analytics && _logEvent) {
      _logEvent(_analytics, eventName as any, params);
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(`[Analytics] ${eventName}`, params, error);
    }
  }
}

function _doSetProps(properties: Record<string, string>) {
  try {
    if (_analytics && _setUserProperties) {
      _setUserProperties(_analytics, properties);
    }
  } catch {}
}

const log = (eventName: string, params?: Record<string, any>) => {
  if (_firebaseReady) {
    _doLog(eventName, params);
  } else {
    _eventQueue.push({ type: 'log', args: [eventName, params] });
    // Trigger lazy load
    ensureFirebase().then(() => {
      _firebaseReady = true;
      flushQueue();
    });
  }
};

const setProps = (properties: Record<string, string>) => {
  if (_firebaseReady) {
    _doSetProps(properties);
  } else {
    _eventQueue.push({ type: 'props', args: [properties] });
    ensureFirebase().then(() => {
      _firebaseReady = true;
      flushQueue();
    });
  }
};

// ─── Engagement Tracking ────────────────────────────────────────

let sessionStartTime = Date.now();
let currentScreen = '/';

const getEngagementTime = () => Math.round((Date.now() - sessionStartTime) / 1000);

// ─── Main Analytics Object ──────────────────────────────────────

export const Analytics = {
  isInitialized: false,

  /**
   * Inizializza Analytics e imposta user properties base
   */
  init: () => {
    if (Analytics.isInitialized) return;
    
    Analytics.isInitialized = true;
    sessionStartTime = Date.now();
    
    // User properties automatiche
    setProps({
      app_version: '2.0',
      platform: 'web',
      locale: navigator.language || 'it-IT',
    });

    // Scroll depth tracking
    let maxScroll = 0;
    const onScroll = () => {
      const scrollPercent = Math.round(
        (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100
      );
      if (scrollPercent > maxScroll) {
        maxScroll = scrollPercent;
        // Log ai quarti: 25%, 50%, 75%, 100%
        if ([25, 50, 75, 100].includes(maxScroll)) {
          log('scroll', { percent_scrolled: maxScroll, page_path: currentScreen });
        }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    // Session end tracking
    window.addEventListener('beforeunload', () => {
      log('session_end', {
        engagement_time_sec: getEngagementTime(),
        page_path: currentScreen,
      });
    });

    console.log('✅ Firebase Analytics initialized');
  },

  // ─── GA4 Recommended Events ─────────────────────────────────

  /**
   * screen_view — evento raccomandato GA4 per navigazione pagine web
   */
  trackPageView: (path: string, title?: string) => {
    currentScreen = path;
    log('screen_view', {
      firebase_screen: title || path,
      firebase_screen_class: path,
    });
    // Anche page_view per report web standard
    log('page_view', {
      page_path: path,
      page_title: title || path,
      page_location: window.location.origin + path,
    });
  },

  /**
   * select_content — evento raccomandato GA4
   */
  trackSelectContent: (contentType: string, itemId: string) => {
    log('select_content', {
      content_type: contentType,
      item_id: itemId,
    });
  },

  /**
   * share — evento raccomandato GA4
   */
  trackShare: (method: string, contentType: string, itemId?: string) => {
    log('share', {
      method,
      content_type: contentType,
      item_id: itemId,
    });
  },

  /**
   * search — evento raccomandato GA4
   */
  trackSearch: (searchTerm: string) => {
    log('search', { search_term: searchTerm });
  },

  /**
   * generate_lead — evento raccomandato GA4 (utente completa una simulazione)
   */
  trackGenerateLead: (value?: number, currency: string = 'CHF') => {
    log('generate_lead', { value, currency });
  },

  /**
   * exception — evento raccomandato GA4
   */
  trackError: (description: string, fatal: boolean = false) => {
    log('exception', { description, fatal });
  },

  // ─── User Properties ────────────────────────────────────────

  /**
   * Imposta il tipo di lavoratore per segmentazione report
   */
  setWorkerType: (type: 'old' | 'new') => {
    setProps({ worker_type: type });
  },

  /**
   * Imposta preferenze utente come user properties
   */
  setUserPreferences: (prefs: { theme?: string; focusMode?: boolean; currency?: string }) => {
    const props: Record<string, string> = {};
    if (prefs.theme) props.preferred_theme = prefs.theme;
    if (prefs.focusMode !== undefined) props.focus_mode = String(prefs.focusMode);
    if (prefs.currency) props.preferred_currency = prefs.currency;
    setProps(props);
  },

  // ─── App-Specific Events (snake_case, max 40 char) ──────────

  /**
   * Simulazione fiscale completata — evento principale dell'app
   */
  trackCalculation: (workerType: 'old' | 'new', salary: number, hasChildren: boolean) => {
    Analytics.setWorkerType(workerType);
    log('simulation_complete', {
      worker_type: workerType,
      gross_salary: salary,
      has_children: hasChildren,
      engagement_time_sec: getEngagementTime(),
    });
    // Anche come generate_lead (l'utente ha completato il "funnel")
    Analytics.trackGenerateLead(salary, 'CHF');
  },

  /**
   * Cambio di un campo input
   */
  trackInputChange: (field: string, value: string | number | boolean) => {
    log('input_change', {
      field_name: field,
      field_value: String(value).substring(0, 100),
    });
  },

  /**
   * Interazione UI generica — formato strutturato:
   * page: pagina principale (es. 'simulatore', 'comparatori', 'guida')
   * section: sezione della pagina (es. 'cambio_valuta', 'spesa', 'calendario')
   * component: componente specifico (es. 'filtro', 'bottone', 'toggle')
   * action: azione eseguita (es. 'click', 'cambio_valore', 'espandi')
   * details: dettagli aggiuntivi opzionali
   */
  trackUIInteraction: (page: string, section: string, component: string, action: string, details?: string) => {
    log('ui_interaction', {
      page,
      section,
      component,
      action,
      details: details?.substring(0, 100),
    });
  },

  /**
   * Toggle focus mode
   */
  trackFocusMode: (enabled: boolean) => {
    Analytics.setUserPreferences({ focusMode: enabled });
    log('toggle_focus_mode', { enabled });
  },

  /**
   * Filtro valichi
   */
  trackBorderFilter: (filterType: string, resultCount: number) => {
    log('border_filter', { filter_type: filterType, result_count: resultCount });
  },

  /**
   * Vista dettaglio comune
   */
  trackMunicipalityView: (name: string, taxLevel: string) => {
    Analytics.trackSelectContent('municipality', name);
    log('municipality_view', { municipality_name: name, tax_level: taxLevel });
  },

  /**
   * Gestione spese
   */
  trackExpense: (action: 'add' | 'edit' | 'delete', category: string, amount?: number) => {
    log('expense_action', { action, expense_category: category, amount });
  },

  /**
   * Pianificatore pensione
   */
  trackPensionPlanner: (action: string, years?: number, amount?: number) => {
    log('pension_planner', { action, retirement_years: years, amount });
  },

  /**
   * Link esterno cliccato
   */
  trackExternalLink: (url: string, label?: string) => {
    log('click', { link_url: url, link_text: label || url, outbound: true });
  },

  /**
   * Interazione grafico
   */
  trackChartInteraction: (chartType: string, action: string) => {
    Analytics.trackSelectContent('chart', chartType);
    log('chart_interaction', { chart_type: chartType, action });
  },

  /**
   * Cambio impostazioni
   */
  trackSettingsChange: (setting: string, value: string | boolean) => {
    log('settings_change', { setting_name: setting, setting_value: String(value) });
    if (setting === 'theme') {
      Analytics.setUserPreferences({ theme: String(value) });
    }
  },

  /**
   * Navigazione tra tab — usa screen_view raccomandato
   */
  trackTabNavigation: (from: string, to: string) => {
    log('tab_navigation', { from_tab: from, to_tab: to });
    Analytics.trackPageView(`/${to}`, `Frontaliere - ${to}`);
  },

  /**
   * Selezione orario traffico
   */
  trackBorderTimeSelection: (timeSlot: string, recommendedCount: number) => {
    log('border_time_select', { time_slot: timeSlot, recommended_count: recommendedCount });
  },

  /**
   * Interazione mappa
   */
  trackMapInteraction: (mapType: string, action: string, location?: string) => {
    log('map_interaction', { map_type: mapType, action, location });
  },

  /**
   * Vista strumento comparatore — usa screen_view raccomandato
   */
  trackComparatorView: (tool: 'exchange' | 'mobile' | 'transport' | 'health' | 'banks' | 'traffic') => {
    const toolNames: Record<string, string> = {
      exchange: 'Cambio Valuta',
      mobile: 'Telefonia Mobile',
      transport: 'Costi Trasporto',
      health: 'Assicurazione Sanitaria',
      banks: 'Conti Correnti',
      traffic: 'Traffico Valichi',
    };
    Analytics.trackSelectContent('comparator_tool', tool);
    Analytics.trackPageView(`/comparatori/${tool}`, `Comparatori - ${toolNames[tool]}`);
  },

  /**
   * Cambio valuta
   */
  trackCurrencyExchange: (action: 'convert' | 'swap' | 'provider_view', provider?: string, amount?: number) => {
    log('currency_exchange', { action, provider, amount });
  },

  /**
   * Operatori mobili
   */
  trackMobileOperator: (action: 'view' | 'filter' | 'sort' | 'link_click', operator?: string, filter?: string) => {
    log('mobile_operator', { action, operator_name: operator, filter_type: filter });
  },

  /**
   * Calcolatore trasporti
   */
  trackTransportCalculator: (action: 'calculate' | 'change_type' | 'change_param', transportType?: string, value?: number) => {
    log('transport_calc', { action, transport_type: transportType, value });
  },

  /**
   * Assicurazione sanitaria
   */
  trackHealthInsurance: (action: 'view_provider' | 'filter' | 'compare', provider?: string) => {
    log('health_insurance', { action, provider_name: provider });
  },

  /**
   * Confronto banche
   */
  trackBankComparison: (action: 'view_bank' | 'filter' | 'link_click', bank?: string, country?: string) => {
    log('bank_comparison', { action, bank_name: bank, country });
  },

  /**
   * Traffico ai valichi
   */
  trackTrafficAlerts: (action: 'view' | 'refresh' | 'filter', crossing?: string, waitTime?: number) => {
    log('traffic_alerts', { action, crossing_name: crossing, wait_time_min: waitTime });
  },

  /**
   * Diagnostica API
   */
  trackApiDiagnostics: (action: 'view' | 'refresh' | 'test_api', apiName?: string) => {
    log('api_diagnostics', { action, api_name: apiName });
  },

  /**
   * Guida frontaliere
   */
  trackGuideSection: (section: string, action: 'view' | 'expand' | 'link_click') => {
    Analytics.trackSelectContent('guide_section', section);
    log('guide_interaction', { section, action });
  },

  /**
   * What-if simulator
   */
  trackWhatIf: (scenario: string, action: 'select' | 'change_param' | 'view_result', details?: string) => {
    log('whatif_simulator', { scenario, action, details });
  },

  /**
   * Job comparator
   */
  trackJobComparison: (action: 'add_job' | 'remove_job' | 'compare' | 'view_result', jobCount?: number, bestCompany?: string) => {
    log('job_comparison', { action, job_count: jobCount, best_company: bestCompany });
  },

  /**
   * Tax calendar
   */
  trackCalendarEvent: (action: 'view' | 'filter' | 'expand_deadline', deadline?: string, daysUntil?: number) => {
    log('tax_calendar', { action, deadline_title: deadline, days_until: daysUntil });
  },

  /**
   * Work permits guide
   */
  trackPermitView: (permitType: string, action: 'select' | 'expand_section' | 'view_comparison') => {
    log('work_permits', { permit_type: permitType, action });
  },

  /**
   * 3rd pillar simulator
   */
  trackPillar3: (action: 'change_type' | 'change_param' | 'view_projection', pillarType?: string, amount?: number) => {
    log('pillar3_simulator', { action, pillar_type: pillarType, amount });
  },

  /**
   * Newsletter
   */
  trackNewsletter: (action: 'view_form' | 'subscribe' | 'unsubscribe' | 'error', emailDomain?: string) => {
    log('newsletter', { action, email_domain: emailDomain });
    if (action === 'subscribe') {
      Analytics.trackGenerateLead(0, 'EUR');
    }
  },

  /**
   * Feedback
   */
  trackFeedback: (action: 'open' | 'submit' | 'cancel', type?: 'bug' | 'feature' | 'question') => {
    log('feedback', { action, feedback_type: type });
    if (action === 'submit') {
      Analytics.trackGenerateLead(0, 'EUR');
    }
  },

  /**
   * Download PDF report
   */
  trackDownload: (fileType: string, fileName?: string) => {
    log('file_download', { file_extension: fileType, file_name: fileName });
  },
};
