/** Read a public guest form without candidate data or any mutating browser request. */
import { cookielessTelemetryProtocol, officialConsentGeoLoader, derivedConsentPublicReads, officialConsentUiAssets, observationalBeaconQuerySender, matchesObservationalTelemetry, officialConsentSvgGetter, consentPublicLogo } from './public-consent-bootstrap.mjs';
import { nativeControlEvidenceInPage, snapshotWithNativeControlEvidence, observeNativeControlContractInPage, installNativeGroupIdentityInPage } from './native-control-contract.mjs';
import { getChromium } from '../../../lib/ensure-chromium.mjs';
import { extractFields } from './fields.mjs';
import { hasApplicationSurface, postingMatch } from './portal.mjs';
import { publicAssetSources, literalScriptAssetUrls, matchesScriptAsset, isPublicJavaScriptResponse, hasSafePublicScriptQuery } from './read-only-asset-contracts.mjs';
import { createHash } from 'node:crypto';
import { rexxTimeZoneSources, rexxTimeZoneProtocol, runtimeTimeZone, validRexxTimeZoneHeaders, validRexxTimeZoneRequest, validRexxTimeZoneResponse } from './rexx-timezone-contract.mjs';
import { initialRexxGuestSession, rexxGuestSessionProtocol, matchesRexxGuestProbe, validRexxGuestResponse } from './rexx-guest-session-contract.mjs';
import { publicContractGet, publicContractTimeZoneLookup, publicContractGuestCookieCheck, publicContractConsentGeoGet } from './public-contract-get.mjs';

export const PUBLIC_CONTRACT_BYTE_BUDGET = 8 * 1024 * 1024;
const contractKey = fields => JSON.stringify(fields.map(field => ({ id: field.id, frame: field.frame, label: field.label,
  form: field.form, context: field.context, section: field.section, autocomplete: field.autocomplete,
  kind: field.kind, inputType: field.inputType, nativeReferencesComplete: field.nativeReferencesComplete, required: field.required, invalid: field.invalid, options: field.options })));

export async function readOnlyPortalContracts({ applyUrl, job, channelType = '', get = publicContractGet,
  launch = null, lookup = publicContractTimeZoneLookup, guestProbe = publicContractGuestCookieCheck, geoLookup = publicContractConsentGeoGet, now = Date.now, timeoutMs = 30_000 } = {}) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([controller.signal, deadline]);
  let browser;
  let browserClosing;
  let context;
  let page;
  let candidateProof;
  let nativeContractChanged = false;
  let nativeContractFailure = null;
  let nativeMutation = null;
  let probePhase = 'bootstrap';
  let capturedTimeZone;
  let timezoneProtocol;
  let timeZoneAttempts = 0;
  let timeZoneRead = false;
  let timeZoneRejection = null;
  let timeZoneStatus = null;
  let guestSession;
  let guestProtocol;
  let guestProbeStarted = false;
  let guestProof;
  const containsGuestIdentifier = value => {
    if (!guestSession?.value) return false;
    let decoded = String(value);
    if (decoded.length > 1_000_000) return true;
    for (let round = 0; round < 8; round++) {
      if (decoded.includes(guestSession.value)) return true;
      const next = decoded.replace(/%([a-f0-9]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      if (next === decoded) return false;
      decoded = next;
    }
    return decoded.includes(guestSession.value) || /%[a-f0-9]{2}/i.test(decoded);
  };
  const exportProof = proof => {
    if (containsGuestIdentifier(JSON.stringify(proof))) {
      return { complete: false, readOnly: true, observedAt: now(), reason: 'guest_context_not_exportable', deniedRequests: [] };
    }
    return proof;
  };
  let oneTrustLoaderProof;
  let consentGeoLoader = false;
  let consentGeoUrl = null;
  let consentSdkUrl = null;
  let consentSdkProof = null;
  let consentSvgGetter = false;
  let consentSvgUrl = null;
  let telemetryProtocol;
  let telemetryScriptObserved = false;
  let telemetryQuerySender = false;
  let telemetryRuntimeProof = null;
  let telemetryRejection = null;
  let ignoredTelemetryRequests = 0;
  const additionalPublicConfigs = new Set();
  const consentLanguageConfigs = new Set();
  const observedStaticScripts = new Set();
  const observedPublicConfigs = new Set();
  const assetProof = () => ({ configCount: observedPublicConfigs.size, scriptCount: observedStaticScripts.size,
    ignoredTelemetryRequests, ...(telemetryRuntimeProof ? { telemetryRuntime: telemetryRuntimeProof } : {}), ...(telemetryRejection ? { telemetryRejection } : {}), ...(consentSdkProof ? { consentUiSdk: consentSdkProof } : {}), ...(telemetryProtocol ? { telemetrySourceHash: telemetryProtocol.sourceHash } : {}), oneTrustLoader: oneTrustLoaderProof || null, scripts: [...observedStaticScripts].slice(0, 10), configs: [...observedPublicConfigs].slice(0, 3) });
  let blocked = false;
  let resourceFailed = false;
  let resourceFailureCause = null;
  let resourceFailureClass = null;
  let resourceFailureEndpoint = null;
  const deniedCapabilities = new Set();
  let resourceTransient = false;
  const resourceFailure = (error, kind = null, endpoint = null) => {
    resourceFailed = true;
    if (['script', 'stylesheet', 'public_config', 'public_geo', 'public_svg', 'public_style'].includes(kind)) resourceFailureClass ||= kind;
    if (endpoint) resourceFailureEndpoint ||= publicEndpoint(endpoint);
    const causes = ['script_asset_unknown', 'public_config_unknown', 'public_style_unknown', 'public_svg_unknown',
      'resource_unavailable', 'timezone_lookup_unknown', 'guest_protocol_ambiguous', 'timezone_protocol_ambiguous',
      'contract_byte_budget', 'contract_request_budget', 'contract_redirect_not_allowed', 'contract_response_too_large', 'contract_encoding_unsupported', 'transient_resource',
      'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'];
    resourceFailureCause ||= causes.includes(error?.code) ? error.code : causes.includes(error?.message) ? error.message : 'resource_unknown';
    if (deadline.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)
      || /^(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|contract_lookup_transient|contract_guest_probe_transient|transient_resource)$/.test(error?.code || '')) resourceTransient = true;
  };
  let requestCount = 0;
  let totalBytes = 0;
  const closeBrowser = () => {
    if (browser && !browserClosing) browserClosing = browser.close().catch(() => { resourceFailed = true; });
    return browserClosing;
  };
  const abortBrowser = () => { void closeBrowser(); };
  signal.addEventListener('abort', abortBrowser, { once: true });
  const deniedRequests = [];
  const unknown = reason => exportProof({ complete: false, readOnly: true, observedAt: now(), reason, deniedRequests,
    ...(nativeContractFailure || nativeMutation ? { nativeContractDiagnostics: { failure: nativeContractFailure || 'observer_mutated', phase: probePhase, ...(nativeMutation ? { mutation: nativeMutation } : {}) } } : {}), ...(resourceFailureCause ? { resourceFailureCause, resourceFailureClass, resourceFailureEndpoint } : {}),
    ...(deniedCapabilities.size ? { deniedCapabilities: [...deniedCapabilities] } : {}), ...(guestProof ? { guestSessionProof: guestProof } : {}),
    ...(oneTrustLoaderProof || observedStaticScripts.size || telemetryScriptObserved ? { publicAssetProof: assetProof() } : {}),
    ...(timezoneProtocol ? { readOnlyProtocol: { ...timezoneProtocol, lookupObserved: timeZoneRead, ...(timeZoneStatus ? { status: timeZoneStatus } : {}), ...(timeZoneRejection ? { rejection: timeZoneRejection } : {}) } } : {}) });
  const incomplete = () => {
    if (deadline.aborted && ['first_snapshot', 'second_snapshot', 'quiet_window', 'third_snapshot', 'final_validation'].includes(probePhase)) nativeContractFailure ||= 'pending_quiet_timeout';
    return unknown(!blocked && (resourceTransient || deadline.aborted || performance.now() - startedAt >= timeoutMs)
    ? 'transient_probe_failure' : 'incomplete_public_form');
  };
  const publicEndpoint = value => {
    const url = new URL(value);
    let endpoint = ['https:', 'http:'].includes(url.protocol) ? (url.origin + url.pathname) : 'unsupported_protocol';
    if (containsGuestIdentifier(endpoint)) endpoint = url.origin + '/[guest-session-context]';
    return endpoint.slice(0, 300);
  };
  const recordDenied = request => {
    blocked = true;
    if (deniedRequests.length >= 3) return;
    const endpoint = publicEndpoint(request.url());
    // Neither request bodies nor query strings belong in the diagnostic.
    const resourceType = request.resourceType?.();
    deniedRequests.push({ method: request.method().slice(0, 12), endpoint,
      resourceType: ['document', 'stylesheet', 'script', 'xhr', 'fetch', 'ping', 'other', 'image', 'font', 'media'].includes(resourceType) ? resourceType : 'unknown' });
  };
  const read = async (url, maxBytes = 1_500_000, reader = get, extra = {}) => {
    maxBytes = Math.min(maxBytes, PUBLIC_CONTRACT_BYTE_BUDGET - totalBytes);
    if (maxBytes <= 0) throw Object.assign(new Error('contract_byte_budget'), { code: 'contract_byte_budget' });
    let counted = 0;
    let requested = 0;
    const attempt = () => {
      requested++;
      if (++requestCount > 40) {
        controller.abort(new Error('contract_request_budget'));
        throw new Error('contract_request_budget');
      }
    };
    const consume = bytes => {
      counted += bytes;
      totalBytes += bytes;
      if (totalBytes > PUBLIC_CONTRACT_BYTE_BUDGET) {
        controller.abort(new Error('contract_byte_budget'));
        throw new Error('contract_byte_budget');
      }
    };
    const response = await reader(url, { ...extra, signal, maxBytes, onBytes: consume, onRequest: attempt });
    if (response.body.length > maxBytes) throw Object.assign(new Error('contract_response_too_large'), { code: 'contract_response_too_large' });
    if (!requested) attempt();
    if (!counted) consume(response.body.length);
    return response;
  };
  try {
    applyUrl = new URL(applyUrl).href;
    const html = await read(applyUrl);
    if (html.status !== 200 || !String(html.headers['content-type'] || '').includes('text/html')) {
      return unknown(html.status >= 500 || html.status === 429 ? 'transient_http' : 'public_form_unavailable');
    }
    if (html.url !== applyUrl) return unknown('redirected_form_unknown');
    const publicHtml = html.body.toString('utf8');
    if (/<input\b[^>]*\btype\s*=\s*(['"]?)password\1/i.test(publicHtml)) return unknown('account_form_unknown');
    const rexxSources = rexxTimeZoneSources(publicHtml, applyUrl);
    if (rexxSources) guestSession = initialRexxGuestSession(publicHtml, applyUrl, html.headers['set-cookie'],
      new URL('cookiecheck-cc0.html', rexxSources.lookupUrl).href);
    const assets = publicAssetSources(publicHtml, applyUrl);
    telemetryProtocol = cookielessTelemetryProtocol(publicHtml, applyUrl);
    const allowedXhrScripts = new Set(assets.loaders);
    // The initial GET and package import spend the same deadline. A missing
    // binary is unknown; this read-only probe never starts an installer.
    const chromium = launch ? null : await getChromium();
    const remainingMs = Math.floor(timeoutMs - (performance.now() - startedAt));
    if (signal.aborted || remainingMs <= 0) return unknown('transient_probe_failure');
    browser = launch ? await launch({ timeoutMs: remainingMs })
      : await chromium.launch({ headless: true, timeout: remainingMs });
    if (signal.aborted) return unknown('transient_probe_failure');
    context = await browser.newContext({ javaScriptEnabled: true, offline: true, serviceWorkers: 'block', acceptDownloads: false });
    if (guestSession) await context.addCookies([guestSession.browserCookie]);
    await context.addInitScript(installNativeGroupIdentityInPage);
    await context.routeWebSocket('**/*', async socket => { blocked = true; deniedCapabilities.add('WebSocket'); await socket.close().catch(() => {}); });
    await context.exposeBinding('__portalContractProbeNativeChanged', (source, detail) => {
      if (!page || source.frame !== page.mainFrame()) return;
      nativeContractChanged = true;
      const kinds = ['reference_budget', 'reference_unknown', 'visibility_unknown', 'visibility', 'attribute', 'child_list', 'character_data'];
      const attributes = ['required', 'aria-required', 'aria-invalid', 'disabled', 'type', 'name', 'form', 'id', 'class', 'style', 'hidden', 'aria-hidden', 'role', 'aria-owns', 'aria-controls', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-details', 'multiple', 'size', 'value', 'for', 'label', 'data-aa-id', 'data-control-id', 'data-semantic-id'];
      nativeMutation ||= { kind: kinds.includes(detail?.kind) ? detail.kind : 'unknown',
        attribute: attributes.includes(detail?.attribute) ? detail.attribute : null };
    });
    await context.exposeBinding('__portalContractProbeDenied', (_source, name) => {
      blocked = true;
      deniedCapabilities.add(['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker', 'EventSource'].includes(name) ? name : 'unknown');
    });
    await context.exposeBinding('__portalContractProbeTimeZone', (source, value) => {
      if (!page || source.frame !== page.mainFrame()) return;
      const zone = runtimeTimeZone(value);
      if (!zone || capturedTimeZone && capturedTimeZone !== zone) blocked = true;
      else capturedTimeZone = zone;
    });
    await context.addInitScript(() => {
      const denied = window.__portalContractProbeDenied;
      window.__portalContractProbeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => { denied().catch(() => {}); });
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker', 'EventSource']) {
        if (!(name in window)) continue;
        Object.defineProperty(window, name, { value: function () {
          denied(name).catch(() => {});
          throw new Error('read_only_contract_probe');
        } });
      }
    });
    let rootDelivered = false;
    await context.route('**/*', async route => {
      const request = route.request();
      const mainDocument = request.isNavigationRequest() && page && request.frame() === page.mainFrame();
      if (request.method() === 'GET' && guestProtocol && guestSession && !request.isNavigationRequest()
        && request.frame() === page.mainFrame() && ['xhr', 'fetch'].includes(request.resourceType())
        && matchesRexxGuestProbe(guestProtocol, guestSession, request.url())) {
        if (guestProbeStarted) { recordDenied(request); await route.abort().catch(() => {}); return; }
        guestProbeStarted = true;
        try {
          const response = await read(request.url(), 4096, guestProbe, { protocol: guestProtocol, guest: guestSession });
          if (![request.url(), guestProtocol.lookupUrl].includes(response.url) || !validRexxGuestResponse(response, guestSession)
            || ![1, 2].includes(response.requests) || response.canonicalFallbackUsed !== (response.requests === 2)) throw new Error('guest_probe_response_unknown');
          guestProof = { protocol: 'rexx-guest-cookie-check-v1', cookieAllowed: true,
            requests: response.requests, canonicalFallbackUsed: response.canonicalFallbackUsed };
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: response.body });
        } catch (error) { resourceFailure(error); await route.abort().catch(() => {}); }
        return;
      }
      if (request.method() === 'POST' && timezoneProtocol && request.url() === timezoneProtocol.lookupUrl) {
        if (request.isNavigationRequest() || request.frame() !== page.mainFrame()
          || !['xhr', 'fetch'].includes(request.resourceType()) || timeZoneAttempts++ || !capturedTimeZone) {
          timeZoneRejection = !capturedTimeZone ? 'runtime_zone_unknown' : timeZoneAttempts > 1 ? 'repeated_lookup' : 'lookup_context_unknown';
          recordDenied(request); await route.abort().catch(() => {}); return;
        }
        // Read only the two necessary header values for the exact named
        // protocol target. Partial request.headers() may omit Content-Length.
        // Neither headers nor body are copied into diagnostics or receipts.
        try {
          const headers = {
            'content-type': await request.headerValue('content-type'),
            'content-length': await request.headerValue('content-length'),
          };
          if (!validRexxTimeZoneHeaders(headers)) {
            timeZoneRejection = 'lookup_headers_unknown';
            recordDenied(request); await route.abort().catch(() => {}); return;
          }
          if (!validRexxTimeZoneRequest({ protocol: timezoneProtocol,
            url: request.url(), method: request.method(), resourceType: request.resourceType(), mainFrame: true,
            timeZone: capturedTimeZone, headers, body: request.postDataBuffer() })) {
            timeZoneRejection = 'payload_mismatch';
            recordDenied(request); await route.abort().catch(() => {}); return;
          }
          const response = await read(timezoneProtocol.lookupUrl, 2048, lookup, { timeZone: capturedTimeZone, protocol: timezoneProtocol });
          if (response.url !== timezoneProtocol.lookupUrl || !validRexxTimeZoneResponse(response)) throw new Error('timezone_lookup_unknown');
          timeZoneStatus = 200;
          await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: response.body });
          timeZoneRead = true;
        } catch (error) {
          timeZoneRejection = error?.code === 'contract_lookup_response_unknown'
            ? (error.responseReason || 'lookup_response_unknown') : 'lookup_unavailable';
          if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) timeZoneStatus = error.status;
          resourceFailure(error); await route.abort().catch(() => {});
        }
        return;
      }
      if (request.method() === 'POST' && telemetryProtocol && telemetryScriptObserved
        && matchesObservationalTelemetry(telemetryProtocol, request.url(), telemetryQuerySender && request.resourceType() === 'ping') && request.frame() === page.mainFrame()
        && !request.isNavigationRequest() && ['xhr', 'fetch', 'ping', 'other'].includes(request.resourceType())) {
        if (++ignoredTelemetryRequests > 16) recordDenied(request);
        await route.abort().catch(() => {});
        return;
      }
      if (request.method() === 'POST' && telemetryProtocol && new URL(request.url()).origin === new URL(telemetryProtocol.trackerUrl).origin
        && new URL(request.url()).pathname === new URL(telemetryProtocol.trackerUrl).pathname) {
        telemetryRejection = !telemetryScriptObserved ? 'script_not_observed' : request.url() !== telemetryProtocol.trackerUrl
          ? 'target_query_unknown' : request.frame() !== page.mainFrame() ? 'frame_unknown' : 'request_type_unknown';
      }
      if (request.method() !== 'GET' || (request.isNavigationRequest() && (!mainDocument || rootDelivered || request.url() !== applyUrl))) {
        recordDenied(request);
        await route.abort().catch(() => {});
        return;
      }
      if (['image', 'font', 'media'].includes(request.resourceType())) {
        await route.abort().catch(() => {});
        return;
      }
      const pathname = new URL(request.url()).pathname;
      if (request.resourceType() === 'script' && !hasSafePublicScriptQuery(request.url())) {
        recordDenied(request); await route.abort().catch(() => {}); return;
      }
      const scriptOwned = matchesScriptAsset(request.url(), new Set([...assets.scripts, ...allowedXhrScripts,
        ...(telemetryProtocol ? [telemetryProtocol.scriptUrl] : []), ...(consentSdkUrl ? [consentSdkUrl] : [])]));
      const xhr = ['xhr', 'fetch'].includes(request.resourceType());
      const xhrScript = xhr && matchesScriptAsset(request.url(), allowedXhrScripts);
      const consentUiSvg = xhr && consentSvgUrl === request.url();
      const consentUiStyle = xhr && additionalPublicConfigs.has(request.url()) && /\.css$/.test(pathname);
      const oneTrustConfig = xhr && !consentUiStyle && oneTrustLoaderProof && (assets.oneTrust?.configs.includes(request.url())
        || additionalPublicConfigs.has(request.url()));
      const consentGeo = xhr && oneTrustLoaderProof && consentGeoLoader && consentGeoUrl === request.url();
      if (!mainDocument && !(request.resourceType() === 'stylesheet' && /\.css$/i.test(pathname))
        && !(request.resourceType() === 'script' && scriptOwned) && !xhrScript && !oneTrustConfig && !consentGeo && !consentUiStyle && !consentUiSvg) {
        recordDenied(request);
        await route.abort().catch(() => {});
        return;
      }
      if (requestCount > 40 || totalBytes > PUBLIC_CONTRACT_BYTE_BUDGET || signal.aborted) {
        resourceFailed = true;
        await route.abort().catch(() => {});
        return;
      }
      try {
        const response = mainDocument ? html : await read(request.url(), consentUiSvg ? 64_000 : consentGeo ? 4096 : (oneTrustConfig || consentUiStyle) ? 256_000 : PUBLIC_CONTRACT_BYTE_BUDGET, consentGeo ? geoLookup : get,
          { followRedirects: !(xhrScript || oneTrustConfig || consentGeo || consentUiStyle || consentUiSvg || request.resourceType() === 'script') });
        if (totalBytes > PUBLIC_CONTRACT_BYTE_BUDGET) throw Object.assign(new Error('contract_byte_budget'), { code: 'contract_byte_budget' });
        if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('resource_unavailable'),
          { code: response.status >= 500 || response.status === 429 ? 'transient_resource' : 'resource_unavailable' });
        if (mainDocument) rootDelivered = true;
        if (xhrScript && (response.status !== 200 || response.url !== request.url() || !isPublicJavaScriptResponse(response))) throw new Error('script_asset_unknown');
        if (consentUiSvg && (response.status !== 200 || response.url !== request.url()
          || !/^image\/svg\+xml(?:\s*;|$)/i.test(response.headers['content-type'] || ''))) throw new Error('public_svg_unknown');
        if (consentUiStyle && (response.status !== 200 || response.url !== request.url()
          || !/^text\/css(?:\s*;|$)/i.test(response.headers['content-type'] || ''))) throw new Error('public_style_unknown');
        if (oneTrustConfig || consentGeo) {
          if (response.status !== 200 || response.url !== request.url()
            || !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) throw new Error('public_config_unknown');
          const config = JSON.parse(response.body.toString('utf8'));
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('public_config_unknown');
          if (oneTrustConfig) {
            const derived = derivedConsentPublicReads(config, request.url(), assets.oneTrust, consentGeoLoader);
            for (const url of derived.configs) { additionalPublicConfigs.add(url); consentLanguageConfigs.add(url); }
            consentGeoUrl = derived.geo || consentGeoUrl;
            consentSdkUrl = derived.sdkUrl || consentSdkUrl;
            consentSvgUrl = consentPublicLogo(config, consentSvgGetter, request.url(), [...consentLanguageConfigs, ...(assets.oneTrust?.configs.slice(1) || [])]) || consentSvgUrl;
          }
          observedPublicConfigs.add(request.url());
        }
        if (consentSdkUrl && response.status === 200 && response.url === consentSdkUrl && isPublicJavaScriptResponse(response)) {
          consentSvgGetter = officialConsentSvgGetter(response.body.toString('utf8'));
          const files = officialConsentUiAssets(response.body.toString('utf8'), response.url, consentSdkUrl);
          if (files.length) {
            for (const url of files) additionalPublicConfigs.add(url);
            consentSdkProof = { sourceUrl: response.url, sourceHash: createHash('sha256').update(response.body).digest('hex') };
          }
        }
        if (telemetryProtocol && response.status === 200 && response.url === telemetryProtocol.scriptUrl
          && isPublicJavaScriptResponse(response)) {
          telemetryScriptObserved = true;
          telemetryQuerySender = observationalBeaconQuerySender(response.body.toString('utf8'));
          telemetryRuntimeProof = { sourceUrl: response.url, sourceHash: createHash('sha256').update(response.body).digest('hex'),
            beaconQuerySender: telemetryQuerySender };
        }
        const activeScript = response.status === 200 && response.url === request.url() && isPublicJavaScriptResponse(response)
          && (assets.scripts.includes(request.url()) || xhrScript);
        if (activeScript) {
          for (const url of literalScriptAssetUrls(response.body.toString('utf8'), assets.baseUrl, new URL(applyUrl).origin)) allowedXhrScripts.add(url);
          if (xhrScript) observedStaticScripts.add(new URL(request.url()).origin + pathname);
          if (assets.oneTrust?.loaderUrl === request.url()) {
            consentGeoLoader = officialConsentGeoLoader(response.body.toString('utf8'));
            oneTrustLoaderProof = {
            sourceUrl: request.url(), sourceHash: createHash('sha256').update(response.body).digest('hex'),
          };
          }
        }
        if (activeScript) {
          const protocolSources = rexxSources ? { ...rexxSources, scripts: [request.url()] } : null;
          const protocol = rexxTimeZoneProtocol(protocolSources, request.url(), response.body);
          if (protocol) {
            if (timezoneProtocol && (timezoneProtocol.scriptUrl !== protocol.scriptUrl || timezoneProtocol.scriptHash !== protocol.scriptHash)) throw new Error('timezone_protocol_ambiguous');
            timezoneProtocol = protocol;
          }
          const cookieProtocol = rexxGuestSessionProtocol(protocolSources, request.url(), response.body);
          if (cookieProtocol) {
            if (guestProtocol && guestProtocol.scriptUrl !== cookieProtocol.scriptUrl) throw new Error('guest_protocol_ambiguous');
            guestProtocol = cookieProtocol;
          }
        }
        const headers = {};
        for (const name of ['content-type', 'content-security-policy', 'access-control-allow-origin',
          'cross-origin-resource-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']) {
          if (typeof response.headers[name] === 'string') headers[name] = response.headers[name];
        }
        await route.fulfill({ status: response.status, headers, body: response.body });
      } catch (error) {
        resourceFailure(error, consentUiSvg ? 'public_svg' : consentUiStyle ? 'public_style' : consentGeo ? 'public_geo'
          : oneTrustConfig ? 'public_config' : request.resourceType(), request.url());
        await route.abort().catch(() => {});
      }
    });
    page = await context.newPage();
    await page.goto(applyUrl, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, timeoutMs) });
    if (blocked || resourceFailed || signal.aborted || page.url() !== applyUrl) return incomplete();
    if (guestProtocol && !guestProof?.cookieAllowed) return unknown('public_initialization_unknown');
    if (timezoneProtocol && !timeZoneRead && await page.evaluate(() => {
      const field = document.getElementById('timezone');
      return Boolean(field && !field.value);
    }) === true) return unknown('public_initialization_unknown');
    const readSnapshot = async () => {
      const raw = await extractFields(page, { listboxOptions: false, channelType });
      const markers = await page.evaluate(nativeControlEvidenceInPage, raw.fields.filter(field => field.frame === 0));
      return { snapshot: snapshotWithNativeControlEvidence(raw, markers), markers };
    };
    probePhase = 'first_snapshot';
    const firstRead = await readSnapshot();
    const first = firstRead.snapshot;
    const applicationForms = new Set(first.fields.filter(field => field.frame === 0 && field.kind === 'file'
      && Number.isInteger(field.form) && field.form >= 0).map(field => field.form));
    const ownedFields = fields => fields.filter(field => field.frame === 0 && applicationForms.has(field.form));
    const ownedIds = new Set(ownedFields(first.fields).map(field => field.id));
    const ownedMarkers = markers => markers.filter(marker => ownedIds.has(marker.id));
    const firstMarkers = ownedMarkers(firstRead.markers);
    await page.waitForTimeout(150);
    probePhase = 'second_snapshot';
    const secondRead = await readSnapshot();
    const snapshot = secondRead.snapshot;
    const finalMarkers = ownedMarkers(secondRead.markers);
    // Observe the final contract through a quiet window. A late conditional
    // requirement invalidates this read instead of retiring its existing hold.
    await page.evaluate(observeNativeControlContractInPage, ownedFields(first.fields).map(field => ({
      id: field.id, nativeSelectId: field.nativeSelectId, nativeControlOwned: field.nativeControlOwned,
    })));
    probePhase = 'quiet_window';
    await page.waitForTimeout(300);
    probePhase = 'third_snapshot';
    const thirdRead = await readSnapshot();
    const quietSnapshot = thirdRead.snapshot;
    const quietMarkers = ownedMarkers(thirdRead.markers);
    if (blocked || resourceFailed || signal.aborted || first.captcha || snapshot.captcha || quietSnapshot.captcha) return unknown('challenge_or_incomplete_form');
    if (first.passwordVisible || snapshot.passwordVisible || quietSnapshot.passwordVisible) return unknown('account_form_unknown');
    if (!hasApplicationSurface(snapshot) || !snapshot.fields.some(field => field.kind === 'file')) return unknown('application_form_unknown');
    probePhase = 'final_validation';
    const pageText = await page.locator('body').innerText({ timeout: 2_000 });
    if (blocked || resourceFailed || signal.aborted || page.url() !== applyUrl) return incomplete();
    const contractChanged = await page.evaluate(() => window.__portalNativeContractChanged === true
      || window.__portalNativeContractStillStable?.() === false);
    if (contractChanged === true) nativeContractFailure = 'observer_mutated';
    else if (contractKey(ownedFields(snapshot.fields)) !== contractKey(ownedFields(quietSnapshot.fields))) nativeContractFailure = 'snapshot_fingerprint_drift';
    else if (JSON.stringify(finalMarkers) !== JSON.stringify(quietMarkers)) nativeContractFailure = 'snapshot_marker_drift';
    if (nativeContractFailure) return unknown('native_contract_unstable');
    if (blocked || resourceFailed || signal.aborted || page.url() !== applyUrl) return incomplete();
    if (postingMatch(pageText, job, applyUrl) !== 'match') return unknown('posting_mismatch');
    if (contractKey(ownedFields(first.fields)) !== contractKey(ownedFields(snapshot.fields))) nativeContractFailure = 'snapshot_fingerprint_drift';
    else if (JSON.stringify(firstMarkers) !== JSON.stringify(finalMarkers)) nativeContractFailure = 'snapshot_marker_drift';
    if (nativeContractFailure) return unknown('native_contract_unstable');
    candidateProof = { complete: true, readOnly: true, stable: true,
      ...(guestProof ? { guestSessionProof: guestProof } : {}),
      ...(oneTrustLoaderProof || observedStaticScripts.size || telemetryScriptObserved ? { publicAssetProof: assetProof() } : {}),
      ...(timeZoneRead ? { readOnlyProtocol: { ...timezoneProtocol, lookupObserved: true } } : {}), sourceUrl: applyUrl, url: page.url(), observedAt: now(),
      fields: snapshot.fields.map(({ value: _value, checked: _checked, ...field }) => ({ ...field,
        explicitlyOptional: field.frame === 0 && finalMarkers.filter(marker => marker.id === field.id
          && marker.explicitlyOptional && marker.nativeRequired === false).length === 1 })) };
  } catch (error) {
    if (deadline.aborted && ['first_snapshot', 'second_snapshot', 'quiet_window', 'third_snapshot', 'final_validation'].includes(probePhase)) nativeContractFailure ||= 'pending_quiet_timeout';
    return unknown(/^contract_(?:url|dns|redirect|encoding|response_too_large)/.test(String(error?.code || ''))
      ? 'public_contract_unsupported' : 'transient_probe_failure');
  } finally {
    await context?.close().catch(() => { resourceFailed = true; });
    controller.abort();
    await closeBrowser();
    signal.removeEventListener('abort', abortBrowser);
  }
  if (blocked || resourceFailed || deadline.aborted || performance.now() - startedAt >= timeoutMs
    || page?.url() !== applyUrl) return incomplete();
  if (nativeContractChanged) return unknown('native_contract_unstable');
  return exportProof(candidateProof);
}
