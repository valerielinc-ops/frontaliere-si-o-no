/** Rexx's read-only cookie probe can fail when it repeats the session in the URL. */
export async function registerCookieSessionRecovery(context, { log = () => {} } = {}) {
  if (typeof context.route !== 'function') return;
  await context.route('**/cookiecheck-cc0.html?*', async (route) => {
    const request = route.request();
    let original;
    let recovered;
    try {
      const url = new URL(request.url());
      const frameUrl = new URL(request.frame().url());
      const session = url.searchParams.get('sid');
      if (request.method() !== 'GET' || url.origin !== frameUrl.origin
        || url.pathname !== '/cookiecheck-cc0.html' || url.searchParams.size !== 1 || !session) {
        return await route.fallback();
      }
      const cookies = (await context.cookies(url.href)).filter(cookie => cookie.name === 'sid');
      if (cookies.length !== 1 || cookies[0].value !== session) return await route.fallback();

      original = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      if (original.status() >= 500 && original.status() <= 599) {
        url.search = '';
        // Same origin, same browser cookies, one harmless GET. No application
        // upload, consent, CAPTCHA or final submission is replayed here.
        recovered = await route.fetch({ url: url.href, maxRedirects: 0, timeout: 15_000 });
        if (recovered.status() === 200) {
          const text = await recovered.text();
          const data = text.length <= 4096 ? JSON.parse(text) : null;
          if (data?.cookie_allowed === true && data.session_id === session) {
            await route.fulfill({ response: recovered });
            try { log('portal cookie session check recovered', url.hostname); } catch { /* Logging cannot change the response. */ }
            return;
          }
        }
      }
      await route.fulfill({ response: original });
    } catch {
      // Preserve the actual error response when the session cannot be proven.
      if (original) await route.fulfill({ response: original });
      else await route.fallback();
    } finally {
      await original?.dispose?.().catch(() => {});
      await recovered?.dispose?.().catch(() => {});
    }
  });
}
