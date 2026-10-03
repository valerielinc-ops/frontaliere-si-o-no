import {
  emailTagChip,
  formatSalary,
  normalizeContract,
  parseDateField,
  resolveLogoUrl,
} from '../newsletter-content.mjs';

const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const DARK_CARD = '#1e293b';
const MUTED_ON_DARK = '#94a3b8';
const POSTED_DATE_LOCALE = { it: 'it-CH', en: 'en-GB', de: 'de-CH', fr: 'fr-CH' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

/**
 * Format a source-backed posting date for a newsletter card.
 * Missing or invalid dates stay absent instead of becoming "Invalid Date".
 */
export function formatPostedDate(raw, locale) {
  if (!raw) return '';
  const ts = parseDateField(raw);
  if (!Number.isFinite(ts)) return '';
  const localeTag = POSTED_DATE_LOCALE[locale] || POSTED_DATE_LOCALE.it;
  try {
    return new Date(ts).toLocaleDateString(localeTag, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Render the job card shared by the saved-jobs and application-intent emails.
 * Each optional field is conditional so incomplete job data never leaves a
 * dangling separator or an empty badge.
 */
export function renderJobCard(entry, locale, strings, {
  expired = false,
  expiredUrl = null,
  applicationIntent = false,
} = {}) {
  const url = expired ? (expiredUrl || entry.url) : entry.url;
  const titleBadges = [];
  if (expired && strings.expiredBadge) {
    titleBadges.push(`<span style="display:inline-block;background:rgba(239,68,68,0.2);color:#fca5a5;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;margin-left:8px;">${escapeHtml(strings.expiredBadge)}</span>`);
  }
  if (applicationIntent) {
    const intentBadge = strings.applicationIntentBadge || strings.badge || '';
    if (intentBadge) {
      titleBadges.push(`<span style="display:inline-block;background:rgba(249,115,22,0.2);color:#fdba74;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;margin-left:8px;">${escapeHtml(intentBadge)}</span>`);
    }
  }

  const locationLabel = entry.location || entry.canton || '';
  const dateLabel = expired ? '' : formatPostedDate(entry.postedDate, locale);
  const sectorLabel = entry.sector || entry.category || '';
  const logoSrc = expired ? null : resolveLogoUrl(entry);
  const initial = (entry.company || '?').trim().charAt(0).toUpperCase() || '?';
  const avatarHtml = logoSrc
    ? `<img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(entry.company || '')}" width="44" height="44" style="display:block;width:44px;height:44px;border-radius:10px;background:#ffffff;object-fit:contain;padding:4px;box-sizing:border-box;">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,${BRAND_DARK},#334155);text-align:center;line-height:44px;font-size:18px;font-weight:800;color:${BRAND_ORANGE};">${escapeHtml(initial)}</div>`;

  const metaLine = `${strings.at} ${escapeHtml(entry.company)}${locationLabel ? ` · ${escapeHtml(locationLabel)}` : ''}`;
  const badges = [];
  if (!expired && strings.newBadge) {
    const firstSeen = entry.firstSeenAt ? new Date(entry.firstSeenAt).getTime() : 0;
    if (firstSeen > 0 && (Date.now() - firstSeen) < 48 * 60 * 60 * 1000) {
      badges.push(emailTagChip(strings.newBadge, 'green'));
    }
  }
  const salaryLabel = formatSalary(entry, locale);
  if (salaryLabel) badges.push(emailTagChip(escapeHtml(salaryLabel), 'blue'));
  if (entry.contract) badges.push(emailTagChip(escapeHtml(normalizeContract(entry.contract, locale))));
  if (locationLabel) badges.push(emailTagChip(escapeHtml(locationLabel)));
  const badgesHtml = badges.length ? `<div style="margin-top:6px;">${badges.join(' ')}</div>` : '';

  const detailParts = [];
  if (dateLabel && strings.postedOn) detailParts.push(`${escapeHtml(strings.postedOn)} ${escapeHtml(dateLabel)}`);
  if (sectorLabel) detailParts.push(escapeHtml(sectorLabel));
  const detailHtml = detailParts.length
    ? `<div style="font-size:12px;color:${MUTED_ON_DARK};margin-top:6px;">${detailParts.join(' &middot; ')}</div>`
    : '';

  return `
    <tr><td style="padding:0 0 10px;">
      <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(url)}" style="text-decoration:none;display:block;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${DARK_CARD};border-radius:12px;">
          <tr>
            <td width="58" style="padding:16px 0 16px 18px;vertical-align:top;">${avatarHtml}</td>
            <td style="padding:16px 18px 16px 14px;vertical-align:top;">
              <div style="font-size:15px;font-weight:700;color:#f1f5f9;">${escapeHtml(entry.title)}${titleBadges.join('')}</div>
              <div style="font-size:13px;color:${MUTED_ON_DARK};margin-top:2px;">${metaLine}</div>
              ${badgesHtml}
              ${detailHtml}
              <div style="margin-top:8px;font-size:13px;color:${BRAND_ORANGE};font-weight:600;">${escapeHtml(strings.viewJob)}</div>
            </td>
          </tr>
        </table>
      </a>
    </td></tr>`;
}
