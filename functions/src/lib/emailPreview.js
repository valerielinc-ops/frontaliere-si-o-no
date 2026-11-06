/**
 * A readable opening summary also supplies inbox preview text. Keep it visible:
 * hidden preheaders and zero-width padding trigger antispam HTML heuristics.
 * Dependency-free so both Cloud Functions and browser previews can use it.
 */
export function renderEmailPreview(text) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  const escaped = value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  return `<div class="email-preview" style="box-sizing:border-box;width:100%;max-width:620px;margin:0 auto;padding:12px 24px;background:#f1f5f9;color:#475569;font-family:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:12px;line-height:18px;text-align:left;">${escaped}</div>`;
}
