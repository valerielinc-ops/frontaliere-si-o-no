/**
 * PublisherPublishPage — self-serve publisher ad-authoring form.
 *
 * Flow:
 *  1. Auth gate (useAuth) — publishers must be signed in.
 *  2. Author the ad (company / ad / locations / apply) with a live price preview
 *     from services/publisherPricing.ts.
 *  3. On submit: reCAPTCHA verify (action PUBLISH_JOB) → write ONE publisher_jobs
 *     doc (status 'pending_payment', the full `locations` array) → call the
 *     createPublisherCheckout Cloud Function → redirect to the Stripe URL.
 *
 * Pricing is RECOMPUTED server-side by the CF from the publisher_jobs docs; the
 * client preview is informational only.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, Plus, Trash2, Send, AlertTriangle, Clock, CheckCircle2, Shield, Sparkles, ShoppingCart, Mail, Loader2, AlertCircle, Star, Check, PartyPopper } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { buildPath } from '@/services/router';
import { useAuth, getAuthEmail } from '@/services/authService';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import {
 upsertNewsletterSubscriber,
 requestConfirmationEmail,
 markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';
import { recaptchaService } from '@/services/recaptchaService';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import {
 getFirestore,
 collection,
 addDoc,
 doc,
 getDoc,
 setDoc,
 serverTimestamp,
 deleteField,
} from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { renderPublisherMarkdown, stripPublisherMarkdown } from '@/services/publisherMarkdown';
import { priceForCart, PRICE_PER_UNIT_CHF, PRICING_CURRENCY } from '@/services/publisherPricing';
import { listCantonOptions } from '@/services/cantonList';
import type {
 ApplyMode,
 PublisherLegalForm,
 PublisherJobLocation,
 PublisherJobStatus,
 PublisherTier,
} from '@/services/publisherTypes';

const CREATE_CHECKOUT_ENDPOINT =
 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createPublisherCheckout';
const GEMINI_ENDPOINT =
 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/geminiGenerate';

const VALID_EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN'];

/** GDPR consent proof recorded when a publisher signs in through the gate. */
const PUBLISHER_CONSENT_TEXT =
 'Accedendo per pubblicare un\'offerta, accetto di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.';

/** Minimum words required in the description (mirrors the projection content gate). */
const DESCRIPTION_MIN_WORDS = 50;

/** Job-category slugs offered in the form (value = stable slug, label = i18n). */
const CATEGORY_SLUGS = [
 'health',
 'it',
 'construction',
 'hospitality',
 'retail',
 'finance',
 'education',
 'logistics',
 'manufacturing',
 'admin',
 'sales',
 'engineering',
 'other',
] as const;
type CategorySlug = (typeof CATEGORY_SLUGS)[number];
const VALID_CATEGORY_SLUGS = new Set<string>(CATEGORY_SLUGS);

/** Contract-type values (persisted as `contractType`). */
const CONTRACT_TYPES: { value: string; labelKey: string }[] = [
 { value: 'permanent', labelKey: 'publisher.ad.contractType.permanent' },
 { value: 'fixed-term', labelKey: 'publisher.ad.contractType.fixedTerm' },
 { value: 'temporary', labelKey: 'publisher.ad.contractType.temporary' },
 { value: 'internship', labelKey: 'publisher.ad.contractType.internship' },
 { value: 'apprenticeship', labelKey: 'publisher.ad.contractType.apprenticeship' },
];

/** Per-location form row: human label + optional structured address fields. */
interface LocationRow {
 label: string;
 postalCode: string;
 canton: string;
 street: string;
}

const emptyLocationRow = (): LocationRow => ({ label: '', postalCode: '', canton: 'TI', street: '' });

/** Apply-method snapshot stored per cart item. */
interface ApplySpec {
 mode: ApplyMode;
 url: string;
 email: string;
 privacyPolicyUrl: string;
}

/**
 * One authored ad captured into the multi-ad cart. Mirrors the per-ad field
 * state (NOT company / tier, which are shared across the whole purchase).
 * A unique `id` lets React key the list and the cart removal stay stable.
 */
interface CartItem {
 id: string;
 title: string;
 description: string;
 category: string;
 sector: string;
 employmentType: string;
 contractType: string;
 salaryMin: string;
 salaryMax: string;
 featured: boolean;
 locations: LocationRow[];
 apply: ApplySpec;
}

/** Parse the model's reply (may be fenced ```json) into a job-post object. */
function parseAiJobPost(text: string): {
 title?: string;
 description?: string;
 employmentType?: string;
 sector?: string;
 category?: string;
} | null {
 if (!text) return null;
 const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
 const start = cleaned.indexOf('{');
 const end = cleaned.lastIndexOf('}');
 if (start === -1 || end === -1 || end <= start) return null;
 try {
 const obj = JSON.parse(cleaned.slice(start, end + 1));
 return obj && typeof obj === 'object' ? obj : null;
 } catch {
 return null;
 }
}

const LEGAL_FORMS: { value: PublisherLegalForm; labelKey: string }[] = [
 { value: 'ditta_individuale', labelKey: 'publisher.company.legalForm.dittaIndividuale' },
 { value: 'persona_fisica', labelKey: 'publisher.company.legalForm.personaFisica' },
 { value: 'azienda', labelKey: 'publisher.company.legalForm.azienda' },
];

const EMPLOYMENT_TYPES: { value: string; labelKey: string }[] = [
 { value: 'FULL_TIME', labelKey: 'publisher.ad.employmentType.fullTime' },
 { value: 'PART_TIME', labelKey: 'publisher.ad.employmentType.partTime' },
 { value: 'CONTRACTOR', labelKey: 'publisher.ad.employmentType.contract' },
 { value: 'TEMPORARY', labelKey: 'publisher.ad.employmentType.temporary' },
 { value: 'INTERN', labelKey: 'publisher.ad.employmentType.internship' },
];

const APPLY_MODES: { value: ApplyMode; labelKey: string }[] = [
 { value: 'external_url', labelKey: 'publisher.apply.mode.externalUrl' },
 { value: 'forward_email', labelKey: 'publisher.apply.mode.forwardEmail' },
 { value: 'in_house', labelKey: 'publisher.apply.mode.inHouse' },
];

/**
 * Top perk highlights shown on the plan cards. Reuses the For-Employers landing
 * `compare.row.*` i18n keys so the Free/Sponsored story stays identical across
 * the marketing page and the authoring form (single source of truth).
 */
const TIER_PERKS: Record<PublisherTier, string[]> = {
 free: ['publisherLanding.compare.row.listing', 'publisherLanding.compare.row.seoPage'],
 sponsored: [
 'publisherLanding.compare.row.featured',
 'publisherLanding.compare.row.newsletter',
 'publisherLanding.compare.row.inHouse',
 'publisherLanding.compare.row.analytics',
 ],
 azienda: [
 'publisher.tier.azienda.perk.allAds',
 'publisherLanding.compare.row.featured',
 'publisherLanding.compare.row.newsletter',
 'publisherLanding.compare.row.inHouse',
 'publisherLanding.compare.row.analytics',
 ],
};

const inputClass =
 'w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow]';
const labelClass = 'block text-sm font-medium text-body mb-1.5';
const sectionTitleClass = 'text-lg font-semibold font-display text-strong mb-4';
const mdBtnClass = 'min-h-[32px] px-2.5 py-1 text-xs font-semibold rounded-lg border border-edge bg-surface-alt text-body hover:bg-accent-subtle transition-colors';

function countWords(text: string): number {
 const trimmed = text.trim();
 if (!trimmed) return 0;
 return trimmed.split(/\s+/).length;
}

/** Distinct, non-empty location labels (case-insensitive) for one ad's rows. */
function distinctLocationLabels(rows: LocationRow[]): string[] {
 const seen = new Set<string>();
 const out: string[] = [];
 for (const loc of rows) {
 const label = loc.label.trim();
 const key = label.toLowerCase();
 if (label && !seen.has(key)) {
 seen.add(key);
 out.push(label);
 }
 }
 return out;
}

function isValidUrl(value: string): boolean {
 return /^https?:\/\/.+/i.test(value.trim());
}

function isValidEmail(value: string): boolean {
 return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

type SubmitStatus = 'idle' | 'submitting' | 'redirecting' | 'published' | 'edited' | 'error';

/**
 * Build the distinct PublisherJobLocation[] from a cart item's rows, attaching
 * the structured address the projection reads (raw.canton + raw.address.*).
 * Empty address subfields are omitted so the projection's `|| fallback` logic
 * stays clean. Shared by the create loop and the edit-update path.
 */
function buildJobLocations(rows: LocationRow[]): PublisherJobLocation[] {
 const seen = new Set<string>();
 const out: PublisherJobLocation[] = [];
 for (const row of rows) {
 const label = row.label.trim();
 const key = label.toLowerCase();
 if (!label || seen.has(key)) continue;
 seen.add(key);
 const canton = row.canton.trim() || 'TI';
 const postalCode = row.postalCode.trim();
 const streetAddress = row.street.trim();
 out.push({
 label,
 canton,
 address: {
 addressLocality: label,
 addressRegion: canton,
 addressCountry: 'CH',
 ...(postalCode ? { postalCode } : {}),
 ...(streetAddress ? { streetAddress } : {}),
 },
 });
 }
 return out;
}

const PublisherPublishPage: React.FC = () => {
 const { t, locale } = useTranslation();
 const { user, loading } = useAuth();

 // ── Auth gate: email path state ─────────────────────────────
 // The gate offers Google + LinkedIn (SocialSignInButtons) AND an email
 // path. Email reuses the newsletter double-opt-in: a NEW address gets the
 // opt-in email (which doubles as a sign-in link via ?action=confirm_newsletter
 // auto-login, wired in App.tsx); an EXISTING address gets a login link sent
 // explicitly (requestConfirmationEmail purpose:'login'). All three methods
 // also subscribe the user to the newsletter (implicit consent, owner policy).
 const [gateEmail, setGateEmail] = useState('');
 const [gateStatus, setGateStatus] = useState<'idle' | 'loading' | 'sent' | 'error'>('idle');
 const [gateError, setGateError] = useState('');
 const gateSocialSyncedRef = useRef(false);

 // ── Tier ────────────────────────────────────────────────────
 // free      → plain crawler-style listing (no featured/blast, external apply only), no payment.
 // sponsored → paid subscription (featured/blast/all apply modes), Stripe checkout.
 const [tier, setTier] = useState<PublisherTier>('sponsored');
 const isFree = tier === 'free';

 // ── Form state ──────────────────────────────────────────────
 const [companyName, setCompanyName] = useState('');
 const [legalForm, setLegalForm] = useState<PublisherLegalForm>('ditta_individuale');
 const [domain, setDomain] = useState('');
 const [logoUrl, setLogoUrl] = useState('');

 const [title, setTitle] = useState('');
 const [description, setDescription] = useState('');
 const [category, setCategory] = useState<string>('');
 const [sector, setSector] = useState('');
 const [employmentType, setEmploymentType] = useState<string>('FULL_TIME');
 const [contractType, setContractType] = useState<string>('permanent');
 const [salaryMin, setSalaryMin] = useState('');
 const [salaryMax, setSalaryMax] = useState('');
 // Featured = top-of-listing + newsletter boost. Sponsored-only benefit
 // (Firestore rules reject featured on free); slot-capped per canton by the
 // projection. No extra Stripe charge — included in the sponsored plan.
 const [featured, setFeatured] = useState(false);

 const [locations, setLocations] = useState<LocationRow[]>([emptyLocationRow()]);

 const [applyMode, setApplyMode] = useState<ApplyMode>('external_url');
 const [applyUrl, setApplyUrl] = useState('');
 const [applyEmail, setApplyEmail] = useState('');
 const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState('');

 // ── Markdown editor (sponsored only) ────────────────────────
 // Sponsored descriptions support a tiny markdown subset (## sections,
 // - bullets, **bold**) rendered by services/publisherMarkdown — the same
 // renderer the static /lavoro/ page uses, so the preview is exact.
 const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
 const [showMdPreview, setShowMdPreview] = useState(false);

 const insertMd = (prefix: string, suffix = '', placeholder = '') => {
 const el = descriptionRef.current;
 if (!el) return;
 const start = el.selectionStart ?? description.length;
 const end = el.selectionEnd ?? start;
 const selected = description.slice(start, end) || placeholder;
 // Block tokens (## , - ) must sit at a line start.
 const needsNl = prefix.startsWith('#') || prefix.startsWith('- ');
 const before = description.slice(0, start);
 const lead = needsNl && before && !before.endsWith('\n') ? '\n' : '';
 const next = `${before}${lead}${prefix}${selected}${suffix}${description.slice(end)}`;
 setDescription(next);
 requestAnimationFrame(() => {
 el.focus();
 const pos = start + lead.length + prefix.length + selected.length + suffix.length;
 el.setSelectionRange(pos, pos);
 });
 };

 // Appends the recommended job-page structure (the same sections crawled job
 // pages surface: about / responsibilities / requirements / what we offer).
 const insertMdTemplate = () => {
 const tpl = [
 `## ${t('publisher.editor.tpl.about')}`, '', '',
 `## ${t('publisher.editor.tpl.tasks')}`, '- ', '- ', '',
 `## ${t('publisher.editor.tpl.requirements')}`, '- ', '- ', '',
 `## ${t('publisher.editor.tpl.offer')}`, '- ', '- ',
 ].join('\n');
 setDescription((d) => (d.trim() ? `${d.replace(/\s+$/, '')}\n\n${tpl}\n` : `${tpl}\n`));
 setShowMdPreview(true);
 };

 // ── Multi-ad cart ───────────────────────────────────────────
 // Each item is a snapshot of the per-ad fields above. Company + tier are
 // shared across the whole cart (one company, one tier per purchase), so they
 // are NOT captured here. The checkout CF sums distinct locations across every
 // ad → the volume discount is reachable across several distinct ads.
 const [cart, setCart] = useState<CartItem[]>([]);

 // ── Edit mode ───────────────────────────────────────────────
 // When the dashboard links here with `?edit=<id>`, we load that publisher_jobs
 // doc, prefill every field, and switch the form to a single-ad "edit" flow:
 // the cart / "add another ad" affordances are hidden, the tier is read-only,
 // and submit updates the doc in place (no checkout, no status/tier change).
 const [editId, setEditId] = useState<string | null>(null);
 const [editStatus, setEditStatus] = useState<PublisherJobStatus | null>(null);
 const isEdit = editId != null;

 const [status, setStatus] = useState<SubmitStatus>('idle');
 const [errors, setErrors] = useState<string[]>([]);
 const [errorMessage, setErrorMessage] = useState('');

 // True when the page is the Stripe-checkout return (?publisher_checkout=success).
 const [checkoutSuccess, setCheckoutSuccess] = useState(false);

 // ── AI auto-fill (sponsored only) ───────────────────────────
 const [aiPosition, setAiPosition] = useState('');
 const [aiStatus, setAiStatus] = useState<'idle' | 'loading' | 'error'>('idle');

 const handleAiFill = async () => {
 const position = aiPosition.trim();
 if (!position || aiStatus === 'loading') return;
 setAiStatus('loading');
 try {
 const userPrompt =
 `Sei un esperto di annunci di lavoro per il mercato Ticino/Svizzera (frontalieri). ` +
 `Genera un annuncio in ITALIANO per la posizione: "${position}". ` +
 `Rispondi SOLO con JSON valido, senza testo extra, con queste chiavi: ` +
 `"title" (titolo conciso), "description" (almeno 70 parole, professionale, con responsabilità e requisiti), ` +
 `"employmentType" (uno tra ${VALID_EMPLOYMENT_TYPES.join(', ')}), ` +
 `"sector" (settore breve, es. "sanità", "edilizia", "IT"), ` +
 `"category" (uno tra ${CATEGORY_SLUGS.join(', ')}).`;
 const res = await fetch(GEMINI_ENDPOINT, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ userPrompt, maxTokens: 1024, temperature: 0.6 }),
 });
 const data = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string };
 const parsed = data?.ok && data.text ? parseAiJobPost(data.text) : null;
 if (!parsed) throw new Error('ai_parse_failed');
 if (parsed.title) setTitle(String(parsed.title).slice(0, 200));
 if (parsed.description) setDescription(String(parsed.description));
 if (parsed.employmentType && VALID_EMPLOYMENT_TYPES.includes(parsed.employmentType)) {
 setEmploymentType(parsed.employmentType);
 }
 if (parsed.sector) setSector(String(parsed.sector).slice(0, 80));
 if (parsed.category && VALID_CATEGORY_SLUGS.has(String(parsed.category))) {
 setCategory(String(parsed.category) as CategorySlug);
 }
 setAiStatus('idle');
 Analytics.trackUIInteraction('publisher', 'ai', 'autofill', 'success');
 } catch (error) {
 setAiStatus('error');
 Analytics.trackUIInteraction('publisher', 'ai', 'autofill', 'error');
 reportCaughtError(error, 'publisher.aiFill');
 }
 };

 useEffect(() => {
 Analytics.trackPageView('/pubblica-offerta/', 'Publisher Publish Page');
 Analytics.trackUIInteraction('publisher', 'page', 'publish_page', 'view');
 }, []);

 // ── Stripe checkout return ──────────────────────────────────
 // The checkout CF sets successUrl to `…/pubblica-offerta/?publisher_checkout=success`.
 // Without handling it the user lands on a blank form with no confirmation (the
 // ad was already created client-side before the redirect; the webhook flips it
 // to `paid`). Show a success screen and strip the param so a refresh or a later
 // visit doesn't re-trigger it.
 useEffect(() => {
 const params = new URLSearchParams(window.location.search);
 if (params.get('publisher_checkout') !== 'success') return;
 setCheckoutSuccess(true);
 Analytics.trackUIInteraction('publisher', 'checkout', 'return', 'success');
 params.delete('publisher_checkout');
 const qs = params.toString();
 window.history.replaceState(
 window.history.state,
 '',
 `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
 );
 }, []);

 // ── Implicit newsletter subscribe on social sign-in ─────────
 // When a visitor authenticates via Google/LinkedIn through the gate, also
 // record them as a newsletter subscriber (owner policy: all three access
 // methods imply consent). Idempotent + guarded so it runs once and never
 // re-asks an already-known subscriber. The email path subscribes in its own
 // submit handler, so this only needs to cover the OAuth providers.
 useEffect(() => {
 if (!user || gateSocialSyncedRef.current) return;
 if (typeof window !== 'undefined' && localStorage.getItem('newsletter_subscribed') === 'true') {
 gateSocialSyncedRef.current = true;
 return;
 }
 const email = getAuthEmail(user);
 if (!email) return;
 gateSocialSyncedRef.current = true;
 void (async () => {
 try {
 const firestore = getFirestore(await getApp());
 const providerId = String(user?.providerData?.[0]?.providerId || '').toLowerCase();
 const consentMethod = providerId.includes('google')
 ? 'google_oauth'
 : providerId.includes('linkedin')
 ? 'linkedin_oauth'
 : providerId.includes('facebook')
 ? 'facebook_oauth'
 : 'social_oauth';
 await upsertNewsletterSubscriber(firestore, {
 email,
 userId: user?.uid || null,
 name: user?.displayName || null,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
 source: 'publisher_gate_social',
 sourcePage: '/pubblica-offerta',
 sourceCta: 'publisher_gate_social',
 sourceComponent: 'PublisherPublishPage',
 sourceRouteFamily: 'publisher',
 locale: navigator.language || 'it-IT',
 // OAuth-verified email + implicit consent → no double-opt-in email.
 isActive: true,
 status: 'confirmed',
 consentGiven: true,
 consentText: PUBLISHER_CONSENT_TEXT,
 consentMethod,
 consentUserAgent: navigator.userAgent,
 });
 markNewsletterSubscribedLocally();
 } catch (error) {
 reportCaughtError(error, 'publisher.gateSocialSubscribe');
 }
 })();
 }, [user]);

 // ── SEO meta (title + description) ──────────────────────────
 useEffect(() => {
 const prevTitle = document.title;
 document.title = t('publisher.metaTitle');
 const meta = document.querySelector('meta[name="description"]');
 const prevDesc = meta?.getAttribute('content') ?? null;
 if (meta) meta.setAttribute('content', t('publisher.metaDescription'));
 return () => {
 document.title = prevTitle;
 if (meta && prevDesc != null) meta.setAttribute('content', prevDesc);
 };
 }, [t]);

 // Free tier is external-apply only — force the mode when switching to free.
 useEffect(() => {
 if (isFree && applyMode !== 'external_url') setApplyMode('external_url');
 }, [isFree, applyMode]);

 // ── Edit-mode load ──────────────────────────────────────────
 // Read `?edit=<id>` once the user is known. If the doc exists AND belongs to
 // the user, prefill every field from it and enter edit mode. The router
 // preserves window.location.search, so this query param survives navigation.
 useEffect(() => {
 if (!user) return;
 const wantEditId = new URLSearchParams(window.location.search).get('edit');
 if (!wantEditId) return;
 let cancelled = false;
 (async () => {
 try {
 const db = getFirestore(await getApp());
 const snap = await getDoc(doc(db, 'publisher_jobs', wantEditId));
 if (cancelled || !snap.exists()) return;
 const d = snap.data() as Record<string, unknown>;
 if (d.publisherUid !== user.uid) return; // not the owner's ad — ignore

 setEditId(wantEditId);
 setEditStatus((d.status as PublisherJobStatus) ?? null);
 setTier((d.tier as PublisherTier) || 'sponsored');

 const c = (d.company as Record<string, unknown>) || {};
 setCompanyName(c.name ? String(c.name) : '');
 if (c.legalForm) setLegalForm(c.legalForm as PublisherLegalForm);
 setDomain(c.domain ? String(c.domain) : '');
 setLogoUrl(c.logoUrl ? String(c.logoUrl) : '');

 setTitle(d.title ? String(d.title) : '');
 // Sponsored ads may carry a markdown source (descriptionMd) — edit that,
 // not the derived plain text, so formatting survives an edit round-trip.
 setDescription(d.descriptionMd ? String(d.descriptionMd) : (d.description ? String(d.description) : ''));
 setCategory(d.category ? String(d.category) : '');
 setSector(d.sector ? String(d.sector) : '');
 if (d.employmentType) setEmploymentType(String(d.employmentType));
 if (d.contractType) setContractType(String(d.contractType));
 setSalaryMin(d.salaryMin != null ? String(d.salaryMin) : '');
 setSalaryMax(d.salaryMax != null ? String(d.salaryMax) : '');
 setFeatured(Boolean(d.featured));

 const docLocations = Array.isArray(d.locations) ? (d.locations as PublisherJobLocation[]) : [];
 const rows: LocationRow[] = docLocations.map(loc => ({
 label: loc.label || '',
 postalCode: loc.address?.postalCode || '',
 canton: loc.canton || loc.address?.addressRegion || 'TI',
 street: loc.address?.streetAddress || '',
 }));
 setLocations(rows.length > 0 ? rows : [emptyLocationRow()]);

 const apply = (d.apply as Record<string, unknown>) || {};
 if (apply.mode) setApplyMode(apply.mode as ApplyMode);
 setApplyUrl(apply.url ? String(apply.url) : '');
 setApplyEmail(apply.email ? String(apply.email) : '');
 setPrivacyPolicyUrl(apply.privacyPolicyUrl ? String(apply.privacyPolicyUrl) : '');
 } catch (error) {
 reportCaughtError(error, 'publisher.editLoad');
 }
 })();
 return () => { cancelled = true; };
 }, [user]);

 // ── Claim / pre-fill from a crawled listing ─────────────────
 // The "Sei l'azienda?" link on a crawled job stashes its fields in
 // sessionStorage and routes here with `?claim=1`. We seed the per-ad fields
 // once (company stays editable, tier/payment unaffected) so the employer
 // doesn't retype their own posting. Edit-mode (`?edit`) always wins; the
 // stash is one-shot (removed after read) and purely client-side (no fetch).
 useEffect(() => {
 if (!user) return;
 const sp = new URLSearchParams(window.location.search);
 if (sp.get('edit') || !sp.get('claim')) return;
 let raw: string | null = null;
 try { raw = sessionStorage.getItem('claimJobPrefill'); } catch { /* storage blocked */ }
 if (!raw) return;
 try { sessionStorage.removeItem('claimJobPrefill'); } catch { /* ignore */ }
 let d: Record<string, unknown>;
 try { d = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
 if (!d || typeof d !== 'object') return;
 if (d.company) setCompanyName(String(d.company));
 if (d.title) setTitle(String(d.title).slice(0, 200));
 if (d.description) setDescription(String(d.description));
 if (d.category) setCategory(String(d.category));
 if (d.sector) setSector(String(d.sector).slice(0, 80));
 if (d.employmentType) setEmploymentType(String(d.employmentType));
 if (d.contractType) setContractType(String(d.contractType));
 if (d.applyUrl) setApplyUrl(String(d.applyUrl));
 // Salary is stashed CHF-only by the claim CTA (the form submits currency: 'CHF').
 if (d.salaryMin != null) setSalaryMin(String(d.salaryMin));
 if (d.salaryMax != null) setSalaryMax(String(d.salaryMax));
 if (d.location) {
 setLocations([{ label: String(d.location), postalCode: '', canton: String(d.canton || 'TI'), street: '' }]);
 }
 }, [user]);

 // Prefill the company section from a saved publisher profile (repeat posters
 // shouldn't re-type their company on every ad). Skipped in edit mode — the
 // edited ad's own company snapshot is the source of truth there.
 useEffect(() => {
 if (!user || isEdit) return;
 let cancelled = false;
 (async () => {
 try {
 const { getFirestore: gf, doc: fDoc, getDoc: fGet } = await import('firebase/firestore');
 const snap = await fGet(fDoc(gf(await getApp()), 'publishers', user.uid));
 if (cancelled || !snap.exists()) return;
 const data = snap.data() as { company?: Record<string, unknown>; tier?: string };
 // Auto-tier: an active azienda publisher inherits tier='azienda' by default
 // so a new ad lands featured without re-picking the card. Only nudges the
 // untouched default ('sponsored') — a manual switch (e.g. to 'free') wins.
 if (data.tier === 'azienda') setTier((v) => (v === 'sponsored' ? 'azienda' : v));
 const c = data.company;
 if (!c) return;
 if (c.name) setCompanyName((v) => v || String(c.name));
 if (c.legalForm) setLegalForm(c.legalForm as PublisherLegalForm);
 if (c.domain) setDomain((v) => v || String(c.domain));
 if (c.logoUrl) setLogoUrl((v) => v || String(c.logoUrl));
 } catch {
 // best-effort prefill
 }
 })();
 return () => { cancelled = true; };
 }, [user, isEdit]);

 // ── Live price preview ──────────────────────────────────────
 // Billing counts DISTINCT non-empty location labels (one ad × location unit each).
 const distinctLocations = useMemo(() => distinctLocationLabels(locations), [locations]);
 // Whole order = every ad already in the cart + the current in-progress ad.
 // The CF recomputes the same way, so the discount applies across all of them.
 const price = useMemo(
 () =>
 priceForCart([
 ...cart.map(c => ({ id: c.id, locations: distinctLocationLabels(c.locations) })),
 { id: 'current', locations: distinctLocations },
 ]),
 [cart, distinctLocations],
 );

 // ── Location helpers ────────────────────────────────────────
 const updateLocation = (index: number, patch: Partial<LocationRow>) => {
 setLocations(prev => prev.map((loc, i) => (i === index ? { ...loc, ...patch } : loc)));
 };
 // In edit mode the location COUNT is locked: billing is per-location and the
 // Stripe subscription quantity is fixed at checkout (firestore.rules pins the
 // count too). Adding/removing locations requires a new purchase.
 const addLocation = () => { if (isEdit) return; setLocations(prev => [...prev, emptyLocationRow()]); };
 const removeLocation = (index: number) => {
 if (isEdit) return;
 setLocations(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
 };

 const cantonOptions = useMemo(() => listCantonOptions(locale), [locale]);
 // Word count / validation run on the PLAIN text — markdown syntax characters
 // (##, -, **) must not count toward the 50-word minimum.
 const descriptionPlain = useMemo(() => stripPublisherMarkdown(description), [description]);
 const descriptionWords = useMemo(() => countWords(descriptionPlain), [descriptionPlain]);

 // ── Client-side validation ──────────────────────────────────
 // Per-ad validation (title / description / ≥1 location / apply fields). Reused
 // both when adding an ad to the cart and when validating the final ad on submit.
 const validateCurrentAd = (): string[] => {
 const found: string[] = [];
 if (!title.trim()) found.push(t('publisher.error.title'));
 if (countWords(stripPublisherMarkdown(description)) < DESCRIPTION_MIN_WORDS) found.push(t('publisher.error.description'));
 if (distinctLocations.length < 1) found.push(t('publisher.error.locations'));
 if (applyMode === 'external_url' && !isValidUrl(applyUrl)) {
 found.push(t('publisher.error.applyUrl'));
 }
 if ((applyMode === 'forward_email' || applyMode === 'in_house') && !isValidEmail(applyEmail)) {
 found.push(t('publisher.error.applyEmail'));
 }
 return found;
 };

 // True when the current ad form is meaningfully started (so submit knows
 // whether to include it on top of the cart, or treat it as blank).
 const currentAdHasContent = (): boolean =>
 Boolean(title.trim()) || countWords(description) > 0 || distinctLocations.length > 0;

 // Snapshot the current ad fields into a cart item (company / tier excluded).
 const snapshotCurrentAd = (): CartItem => ({
 id: `ad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
 title,
 description,
 category,
 sector,
 employmentType,
 contractType,
 salaryMin,
 salaryMax,
 featured,
 locations: locations.map(loc => ({ ...loc })),
 apply: { mode: applyMode, url: applyUrl, email: applyEmail, privacyPolicyUrl },
 });

 // Reset the per-ad fields after stashing one in the cart. KEEPS company + tier.
 const resetAdFields = () => {
 setTitle('');
 setDescription('');
 setCategory('');
 setSector('');
 setEmploymentType('FULL_TIME');
 setContractType('permanent');
 setSalaryMin('');
 setSalaryMax('');
 setFeatured(false);
 setLocations([emptyLocationRow()]);
 setApplyMode(isFree ? 'external_url' : applyMode);
 setApplyUrl('');
 setApplyEmail('');
 setPrivacyPolicyUrl('');
 setAiPosition('');
 };

 // "Aggiungi un altro annuncio": validate the current ad, snapshot it, reset.
 const handleAddToCart = () => {
 const adErrors = validateCurrentAd();
 if (adErrors.length > 0) {
 setErrors(adErrors);
 return;
 }
 setErrors([]);
 setCart(prev => [...prev, snapshotCurrentAd()]);
 resetAdFields();
 Analytics.trackUIInteraction('publisher', 'cart', 'add', 'ok');
 };

 const removeCartItem = (id: string) => setCart(prev => prev.filter(item => item.id !== id));

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (status === 'submitting' || status === 'redirecting') return;
 if (!user) return;

 // Company is shared across the whole purchase; validate it once.
 const companyErrors: string[] = [];
 if (!companyName.trim()) companyErrors.push(t('publisher.error.companyName'));

 // Collect every ad to publish: the cart items, plus the current in-progress
 // ad when it has content. An empty current form with a non-empty cart simply
 // checks out the cart. The current ad (when present) must still pass per-ad
 // validation.
 const includeCurrent = cart.length === 0 || currentAdHasContent();
 const currentAdErrors = includeCurrent ? validateCurrentAd() : [];
 const ads: CartItem[] = [...cart, ...(includeCurrent ? [snapshotCurrentAd()] : [])];

 const validationErrors = [...companyErrors, ...currentAdErrors];
 if (validationErrors.length === 0 && ads.length === 0) {
 validationErrors.push(t('publisher.error.title'));
 }
 if (validationErrors.length > 0) {
 setErrors(validationErrors);
 setStatus('idle');
 return;
 }
 setErrors([]);
 setStatus('submitting');
 setErrorMessage('');

 try {
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'start');

 // reCAPTCHA: generate + verify server-side ONCE before persisting anything
 // (one human gesture covers the whole multi-ad checkout, not per ad).
 const token = await recaptchaService.getTokenForApi('PUBLISH_JOB');
 if (!token) throw new Error('recaptcha_token_missing');
 const verification = await recaptchaService.verifyToken(token, 'PUBLISH_JOB');
 if (!verification.passed) {
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'recaptcha_blocked');
 throw new Error(`recaptcha_blocked:${verification.error ?? 'unknown'}`);
 }

 const firebaseApp = await getApp();
 const db = getFirestore(firebaseApp);

 const company = {
 name: companyName.trim(),
 legalForm,
 ...(domain.trim() ? { domain: domain.trim() } : {}),
 ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}),
 };

 // ── Edit mode: update the existing doc in place ──────────────
 // Merge only the CONTENT fields — status / tier / publisherUid / createdAt
 // are deliberately left untouched (firestore.rules' contentEditOk requires
 // them unchanged, and the webhook/Admin SDK still owns paid/expired). No
 // checkout: a paid ad stays paid, a free ad stays free.
 if (isEdit && editId) {
 const ad = ads[0];
 const jobLocations = buildJobLocations(ad.locations);
 const parsedMin = ad.salaryMin.trim() ? Number(ad.salaryMin) : undefined;
 const parsedMax = ad.salaryMax.trim() ? Number(ad.salaryMax) : undefined;
 // Sponsored: `description` stays PLAIN text (JSON-LD / meta / search all
 // consume it); the markdown source ships separately as `descriptionMd`.
 const editPlainDesc = isFree ? ad.description.trim() : stripPublisherMarkdown(ad.description);
 const editMdDesc = !isFree && ad.description.trim() && ad.description.trim() !== editPlainDesc
 ? ad.description.trim() : null;
 await setDoc(
 doc(db, 'publisher_jobs', editId),
 {
 title: ad.title.trim(),
 description: editPlainDesc,
 // merge:true → explicitly delete a stale markdown source when the
 // publisher removed all formatting in this edit.
 descriptionMd: editMdDesc ?? deleteField(),
 company,
 locations: jobLocations,
 employmentType: ad.employmentType,
 ...(ad.category.trim() ? { category: ad.category.trim() } : {}),
 ...(ad.sector.trim() ? { sector: ad.sector.trim() } : {}),
 ...(ad.contractType.trim() ? { contractType: ad.contractType.trim() } : {}),
 ...(parsedMin != null && Number.isFinite(parsedMin) ? { salaryMin: parsedMin } : {}),
 ...(parsedMax != null && Number.isFinite(parsedMax) ? { salaryMax: parsedMax } : {}),
 // Featured is a sponsored-only benefit; never persist it on free ads.
 ...(!isFree && ad.featured ? { featured: true } : { featured: false }),
 currency: 'CHF',
 apply: {
 mode: ad.apply.mode,
 ...(ad.apply.mode === 'external_url' ? { url: ad.apply.url.trim() } : {}),
 ...(ad.apply.mode === 'forward_email' || ad.apply.mode === 'in_house' ? { email: ad.apply.email.trim() } : {}),
 ...(ad.apply.privacyPolicyUrl.trim() ? { privacyPolicyUrl: ad.apply.privacyPolicyUrl.trim() } : {}),
 },
 // Marks the ad as edited — the dashboard shows a "changes pending publication"
 // hint on live ads until the next slice sync (~1–2h) picks the edit up.
 contentEditedAt: serverTimestamp(),
 updatedAt: serverTimestamp(),
 },
 { merge: true },
 );

 // Keep the saved company profile fresh too (best-effort, non-blocking).
 try {
 await setDoc(
 doc(db, 'publishers', user.uid),
 { email: user.email || null, company, updatedAt: serverTimestamp() },
 { merge: true },
 );
 } catch {
 // non-fatal — the ad edit is already saved
 }

 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'edited');
 setStatus('edited');
 return;
 }

 // Write one publisher_jobs doc per ad (same shape as before). The CF sums
 // distinct locations across ALL of them for billing + volume discount.
 // status 'pending_payment' — only the Stripe webhook (Admin SDK) may set 'paid'.
 const jobIds: string[] = [];
 for (const ad of ads) {
 const jobLocations = buildJobLocations(ad.locations);
 const parsedSalaryMin = ad.salaryMin.trim() ? Number(ad.salaryMin) : undefined;
 const parsedSalaryMax = ad.salaryMax.trim() ? Number(ad.salaryMax) : undefined;
 // Sponsored: `description` stays PLAIN text (JSON-LD / meta / search all
 // consume it); the markdown source ships separately as `descriptionMd`.
 const plainDesc = isFree ? ad.description.trim() : stripPublisherMarkdown(ad.description);
 const mdDesc = !isFree && ad.description.trim() && ad.description.trim() !== plainDesc
 ? ad.description.trim() : null;

 const docRef = await addDoc(collection(db, 'publisher_jobs'), {
 publisherUid: user.uid,
 tier,
 // free → live immediately as a plain listing; sponsored → awaits Stripe.
 status: isFree ? 'published' : 'pending_payment',
 title: ad.title.trim(),
 description: plainDesc,
 ...(mdDesc ? { descriptionMd: mdDesc } : {}),
 sourceLang: 'it',
 company,
 locations: jobLocations,
 employmentType: ad.employmentType,
 ...(ad.category.trim() ? { category: ad.category.trim() } : {}),
 ...(ad.sector.trim() ? { sector: ad.sector.trim() } : {}),
 ...(ad.contractType.trim() ? { contractType: ad.contractType.trim() } : {}),
 ...(parsedSalaryMin != null && Number.isFinite(parsedSalaryMin) ? { salaryMin: parsedSalaryMin } : {}),
 ...(parsedSalaryMax != null && Number.isFinite(parsedSalaryMax) ? { salaryMax: parsedSalaryMax } : {}),
 // Featured is a sponsored-only benefit; never persist it on free ads.
 ...(!isFree && ad.featured ? { featured: true } : { featured: false }),
 currency: 'CHF',
 apply: {
 mode: ad.apply.mode,
 ...(ad.apply.mode === 'external_url' ? { url: ad.apply.url.trim() } : {}),
 ...(ad.apply.mode === 'forward_email' || ad.apply.mode === 'in_house' ? { email: ad.apply.email.trim() } : {}),
 ...(ad.apply.privacyPolicyUrl.trim() ? { privacyPolicyUrl: ad.apply.privacyPolicyUrl.trim() } : {}),
 },
 createdAt: serverTimestamp(),
 updatedAt: serverTimestamp(),
 });
 jobIds.push(docRef.id);
 }

 // Save the company profile so the next ad prefills (best-effort, non-blocking).
 try {
 const { doc: fDoc, setDoc: fSet } = await import('firebase/firestore');
 await fSet(
 fDoc(db, 'publishers', user.uid),
 {
 email: user.email || null,
 company,
 updatedAt: serverTimestamp(),
 },
 { merge: true },
 );
 } catch {
 // non-fatal — the ad is already created
 }

 // Free tier: no payment — the ad is already 'published' and the sync
 // workflow will pick it up into the crawler slice. Done.
 if (isFree) {
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'published_free');
 setStatus('published');
 return;
 }

 // Sponsored: authenticated call to the checkout Cloud Function.
 const idToken = await user.getIdToken();
 setStatus('redirecting');
 const res = await fetch(CREATE_CHECKOUT_ENDPOINT, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Authorization: `Bearer ${idToken}`,
 },
 body: JSON.stringify({
 jobIds,
 ...(tier === 'azienda' ? { plan: 'azienda' } : {}),
 successUrl: `${window.location.origin}${window.location.pathname}?publisher_checkout=success`,
 cancelUrl: window.location.href,
 }),
 });

 const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
 if (!res.ok || !data.ok || !data.url) {
 throw new Error(`checkout_failed:${data.error ?? `http_${res.status}`}`);
 }

 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'success');
 window.location.assign(data.url);
 } catch (error) {
 console.error('Error creating publisher checkout:', error);
 setStatus('error');
 setErrorMessage(t('publisher.error'));
 Analytics.trackUIInteraction('publisher', 'form', 'submit', 'error');
 reportCaughtError(error, 'publisher.formSubmit');
 }
 };

 // ── Auth gate: email sign-in handler ────────────────────────
 // Subscribe to the newsletter (= the access workflow) and deliver a sign-in
 // link. A NEW address: the opt-in email IS the link (auto-sent by the upsert).
 // An EXISTING address: the opt-in is suppressed server-side, so we request a
 // dedicated login link (purpose:'login'). Either way the user clicks the
 // link → App.tsx ?action=confirm_newsletter handler auto-logs them in and
 // returns them to /pubblica-offerta, authenticated.
 const handleGateEmailSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (gateStatus === 'loading') return;
 const email = gateEmail.trim();
 if (!validateEmailStrict(email).valid) {
 setGateError(t('newsletter.invalidEmail'));
 setGateStatus('error');
 return;
 }
 setGateStatus('loading');
 setGateError('');
 try {
 const firestore = getFirestore(await getApp());
 const upsert = await upsertNewsletterSubscriber(firestore, {
 email,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
 source: 'publisher_gate_email',
 sourcePage: '/pubblica-offerta',
 sourceCta: 'publisher_gate_email',
 sourceComponent: 'PublisherPublishPage',
 sourceRouteFamily: 'publisher',
 locale: navigator.language || 'it-IT',
 // Do NOT pass status/isActive: inferNewsletterSubscriptionState gives
 // explicit fields absolute precedence, so forcing 'pending' here would
 // DOWNGRADE an already-confirmed subscriber who types their email in the
 // gate. Omitting them preserves a confirmed subscriber and defaults a new
 // address to 'pending' (→ auto opt-in/login email).
 consentGiven: true,
 consentText: PUBLISHER_CONSENT_TEXT,
 consentMethod: 'email_checkbox',
 consentUserAgent: navigator.userAgent,
 });
 // New pending subscribers already received the opt-in (= login) email from
 // the upsert. Existing subscribers need an explicit login link.
 if (upsert.existed) {
 await requestConfirmationEmail(email, 'login');
 }
 setGateStatus('sent');
 Analytics.trackUIInteraction('publisher', 'gate', 'email_login', 'sent');
 } catch (error) {
 reportCaughtError(error, 'publisher.gateEmailSubmit');
 setGateError(t('newsletter.subscribeError'));
 setGateStatus('error');
 }
 };

 // ── Stripe checkout success ─────────────────────────────────
 // Takes priority over the auth gate: the param is the source of truth and
 // auth may still be resolving on this fresh page load. The ad already exists
 // (created before the redirect); send the user to their dashboard, not a form.
 if (checkoutSuccess) {
 return (
 <div className="max-w-2xl mx-auto px-4 py-12">
 <div className="text-center space-y-4">
 <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success-subtle">
 <CheckCircle2 className="w-8 h-8 text-success" />
 </div>
 <h2 className="text-2xl font-bold font-display text-strong">{t('publisher.checkoutSuccess.title')}</h2>
 <p className="text-subtle max-w-md mx-auto">{t('publisher.checkoutSuccess.message')}</p>
 <a
 href={buildPath({ activeTab: 'publisher-dashboard' }, locale)}
 className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors"
 >
 <Briefcase className="w-4 h-4" />
 {t('publisher.checkoutSuccess.cta')}
 </a>
 </div>
 </div>
 );
 }

 // ── Auth gate ───────────────────────────────────────────────
 // While auth resolves, show a spinner — NEVER flash the form for an
 // as-yet-unauthenticated visitor (the form is authenticated-only).
 if (loading && !user) {
 return (
 <div className="max-w-2xl mx-auto px-4 py-24 flex flex-col items-center justify-center text-center">
 <div
 className="animate-spin rounded-full h-8 w-8 border-2 border-edge border-t-accent"
 role="status"
 aria-label={t('publisher.loadingAuth')}
 />
 <span className="sr-only">{t('publisher.loadingAuth')}</span>
 </div>
 );
 }
 if (!loading && !user) {
 // After an email submit: tell the user to open the sign-in link we sent.
 if (gateStatus === 'sent') {
 return (
 <div className="max-w-md mx-auto px-4 py-12">
 <div className="text-center space-y-4">
 <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-success-subtle mb-2">
 <Mail className="w-7 h-7 text-success" />
 </div>
 <h1 className="text-2xl font-bold font-display text-strong">
 {t('publisher.gate.checkEmailTitle')}
 </h1>
 <p className="text-subtle max-w-sm mx-auto">{t('publisher.gate.checkEmailBody')}</p>
 </div>
 </div>
 );
 }
 return (
 <div className="max-w-md mx-auto px-4 py-12">
 <div className="text-center space-y-3">
 <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-1">
 <Briefcase className="w-7 h-7 text-link" />
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong">
 {t('publisher.title')}
 </h1>
 <p className="text-subtle max-w-sm mx-auto">{t('publisher.gate.subtitle')}</p>
 </div>

 <div className="mt-6 space-y-4">
 {/* Social sign-in — same row as the newsletter box (Google + LinkedIn) */}
 <SocialSignInButtons locale={locale} googleWidth={320} errorContext="publisher.gate" />

 {/* Divider */}
 <div className="flex items-center gap-3">
 <div className="flex-1 h-px bg-edge" />
 <span className="text-xs text-muted uppercase tracking-wider">{t('publisher.gate.or')}</span>
 <div className="flex-1 h-px bg-edge" />
 </div>

 {/* Email path → newsletter opt-in / login link */}
 <form onSubmit={handleGateEmailSubmit} className="space-y-2">
 <label htmlFor="publisher-gate-email" className="sr-only">{t('newsletter.emailPlaceholder')}</label>
 <EmailInput
 id="publisher-gate-email"
 value={gateEmail}
 onChange={(val) => { setGateEmail(val); if (gateStatus === 'error') setGateStatus('idle'); }}
 placeholder={t('newsletter.emailPlaceholder')}
 className="w-full px-4 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm"
 />
 {gateStatus === 'error' && gateError && (
 <div className="flex items-start gap-2 p-2 bg-danger-subtle rounded-lg text-danger text-xs">
 <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
 <span>{gateError}</span>
 </div>
 )}
 <button
 type="submit"
 disabled={gateStatus === 'loading'}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
 >
 {gateStatus === 'loading'
 ? <><Loader2 className="w-4 h-4 animate-spin" /> {t('publisher.gate.emailCta')}</>
 : <><Mail className="w-4 h-4" /> {t('publisher.gate.emailCta')}</>}
 </button>
 </form>

 <p className="flex items-start gap-1.5 text-xs text-muted leading-relaxed">
 <Shield className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
 <span>{t('publisher.gate.consentNote')}</span>
 </p>
 </div>
 </div>
 );
 }

 // ── Free-tier published success ─────────────────────────────
 if (status === 'published') {
 return (
 <div className="max-w-2xl mx-auto px-4 py-16">
 <div className="text-center space-y-4 animate-fade-in-up">
 <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-success-subtle ring-8 ring-success-subtle/40">
 <PartyPopper className="w-10 h-10 text-success" aria-hidden="true" />
 </div>
 <h2 className="text-2xl sm:text-3xl font-bold font-display text-strong">{t('publisher.published.title')}</h2>
 <p className="text-subtle max-w-md mx-auto">{t('publisher.published.message')}</p>
 <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
 <a
 href={buildPath({ activeTab: 'publisher-dashboard' }, locale)}
 className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors no-underline"
 >
 <Briefcase className="w-4 h-4" />
 {t('publisher.published.viewDashboard')}
 </a>
 <button
 type="button"
 onClick={() => { resetAdFields(); setCart([]); setStatus('idle'); window.scrollTo({ top: 0 }); }}
 className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface-alt transition-colors"
 >
 <Plus className="w-4 h-4" />
 {t('publisher.published.publishAnother')}
 </button>
 </div>
 </div>
 </div>
 );
 }

 // ── Edit saved success ──────────────────────────────────────
 if (status === 'edited') {
 return (
 <div className="max-w-2xl mx-auto px-4 py-16">
 <div className="text-center space-y-4 animate-fade-in-up">
 <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-success-subtle ring-8 ring-success-subtle/40">
 <CheckCircle2 className="w-10 h-10 text-success" aria-hidden="true" />
 </div>
 <h2 className="text-2xl sm:text-3xl font-bold font-display text-strong">{t('publisher.editSuccess.title')}</h2>
 <p className="text-subtle max-w-md mx-auto">{t('publisher.editSuccess.message')}</p>
 <div className="pt-2">
 <a
 href={buildPath({ activeTab: 'publisher-dashboard' }, locale)}
 className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors no-underline"
 >
 <Briefcase className="w-4 h-4" />
 {t('publisher.published.viewDashboard')}
 </a>
 </div>
 </div>
 </div>
 );
 }

 return (
 <div className="max-w-2xl mx-auto px-4 py-8">
 {/* Header */}
 <div className="text-center mb-8">
 <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-4">
 <Briefcase className="w-7 h-7 text-link" />
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong mb-2">
 {isEdit ? t('publisher.editTitle') : t('publisher.title')}
 </h1>
 <p className="text-subtle max-w-lg mx-auto">{t('publisher.subtitle')}</p>
 </div>

 <form onSubmit={handleSubmit} className="space-y-8">
 {/* ── Tier selector (plan cards) ─────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.tier.section')}</h2>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
 {([
 { value: 'free', titleKey: 'publisher.tier.free.title', price: t('publisher.price.free'), priceNote: '' },
 { value: 'sponsored', titleKey: 'publisher.tier.sponsored.title', price: `${PRICING_CURRENCY} ${PRICE_PER_UNIT_CHF}`, priceNote: t('publisherLanding.plan.sponsored.priceNote') },
 { value: 'azienda', titleKey: 'publisher.tier.azienda.title', price: `${PRICING_CURRENCY} 299`, priceNote: t('publisher.tier.azienda.priceNote') },
 ] as const).map(opt => {
 const selected = tier === opt.value;
 const isSponsoredCard = opt.value === 'sponsored';
 // Sponsored = warm "gold" identity (warning token + Star); free = neutral.
 const selectedRing = isSponsoredCard
 ? 'border-warning ring-2 ring-warning-border bg-warning-subtle'
 : 'border-accent ring-2 ring-accent-border bg-accent-subtle';
 const idleRing = isSponsoredCard
 ? 'border-warning-border bg-warning-subtle/40 hover:border-warning'
 : 'border-edge bg-surface-alt hover:border-accent';
 return (
 <button
 key={opt.value}
 type="button"
 aria-pressed={selected}
 disabled={isEdit}
 aria-disabled={isEdit}
 onClick={() => { if (!isEdit) setTier(opt.value as PublisherTier); }}
 className={`relative text-left p-5 rounded-2xl border transition-all ${selected ? selectedRing : idleRing} ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
 >
 {isSponsoredCard && (
 <span className="absolute -top-2.5 right-4 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-warning text-on-accent shadow-sm">
 <Star className="w-3 h-3 fill-current" aria-hidden="true" />
 {t('publisherLanding.plan.sponsored.badge')}
 </span>
 )}
 <span className="flex items-center justify-between gap-2">
 <span className={`text-sm font-bold font-display ${isSponsoredCard ? 'text-warning' : 'text-strong'}`}>
 {t(opt.titleKey)}
 </span>
 <span
 className={`inline-flex items-center justify-center w-5 h-5 rounded-full border transition-colors ${selected ? (isSponsoredCard ? 'bg-warning border-warning text-on-accent' : 'bg-accent border-accent text-on-accent') : 'border-edge text-transparent'}`}
 aria-hidden="true"
 >
 <Check className="w-3.5 h-3.5" />
 </span>
 </span>
 <span className="mt-2 flex items-baseline gap-1.5">
 <span className="text-2xl font-bold font-display text-strong">{opt.price}</span>
 {opt.priceNote && <span className="text-xs text-subtle">{opt.priceNote}</span>}
 </span>
 <span className="mt-3 block space-y-1.5">
 {TIER_PERKS[opt.value].map(perkKey => (
 <span key={perkKey} className="flex items-start gap-2 text-xs text-body">
 <Check className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${isSponsoredCard ? 'text-warning' : 'text-success'}`} aria-hidden="true" />
 {t(perkKey)}
 </span>
 ))}
 </span>
 </button>
 );
 })}
 </div>
 </section>
 {/* ── Company ────────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.company.section')}</h2>
 <div className="space-y-5">
 <div>
 <label htmlFor="pub-company-name" className={labelClass}>
 {t('publisher.company.name')} *
 </label>
 <input
 id="pub-company-name"
 type="text"
 required
 value={companyName}
 onChange={e => setCompanyName(e.target.value)}
 autoComplete="organization"
 className={inputClass}
 placeholder={t('publisher.company.namePlaceholder')}
 />
 </div>
 <div>
 <label htmlFor="pub-legal-form" className={labelClass}>
 {t('publisher.company.legalForm')}
 </label>
 <select
 id="pub-legal-form"
 value={legalForm}
 onChange={e => setLegalForm(e.target.value as PublisherLegalForm)}
 className={inputClass}
 >
 {LEGAL_FORMS.map(opt => (
 <option key={opt.value} value={opt.value}>
 {t(opt.labelKey)}
 </option>
 ))}
 </select>
 </div>
 <div>
 <label htmlFor="pub-domain" className={labelClass}>
 {t('publisher.company.website')}
 </label>
 <input
 id="pub-domain"
 type="url"
 value={domain}
 onChange={e => setDomain(e.target.value)}
 autoComplete="url"
 className={inputClass}
 placeholder={t('publisher.company.websitePlaceholder')}
 />
 </div>
 <div>
 <label htmlFor="pub-logo" className={labelClass}>
 {t('publisher.company.logo')}
 </label>
 <input
 id="pub-logo"
 type="url"
 value={logoUrl}
 onChange={e => setLogoUrl(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.company.logoPlaceholder')}
 />
 </div>
 </div>
 </section>

 {/* ── Ad ─────────────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.ad.section')}</h2>
 <div className="space-y-5">
 {!isFree && (
 <div className="rounded-xl border border-accent/40 bg-accent-subtle p-4">
 <label htmlFor="pub-ai-position" className="block text-sm font-medium text-strong mb-1.5">
 {t('publisher.ai.label')}
 </label>
 <div className="flex flex-col sm:flex-row gap-2">
 <input
 id="pub-ai-position"
 type="text"
 value={aiPosition}
 onChange={e => setAiPosition(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.ai.placeholder')}
 />
 <button
 type="button"
 onClick={() => { void handleAiFill(); }}
 disabled={!aiPosition.trim() || aiStatus === 'loading'}
 className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-on-accent bg-accent hover:bg-accent-hover disabled:bg-surface-muted disabled:cursor-not-allowed rounded-xl transition-colors"
 >
 {aiStatus === 'loading' ? (
 <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
 ) : (
 <Sparkles className="w-4 h-4" />
 )}
 {t('publisher.ai.button')}
 </button>
 </div>
 <p className="mt-1.5 text-xs text-muted">{t('publisher.ai.hint')}</p>
 {aiStatus === 'error' && (
 <p className="mt-1 text-xs text-danger">{t('publisher.ai.error')}</p>
 )}
 </div>
 )}
 <div>
 <label htmlFor="pub-title" className={labelClass}>
 {t('publisher.ad.title')} *
 </label>
 <input
 id="pub-title"
 type="text"
 required
 value={title}
 onChange={e => setTitle(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.ad.titlePlaceholder')}
 />
 </div>
 <div>
 <label htmlFor="pub-description" className={labelClass}>
 {t('publisher.ad.description')} *
 </label>
 {!isFree && (
 <div className="flex flex-wrap items-center gap-1.5 mb-2" role="toolbar" aria-label={t('publisher.editor.toolbar')}>
 <button type="button" onClick={() => insertMd('## ', '', t('publisher.editor.sectionPh'))} className={mdBtnClass}>
 {t('publisher.editor.section')}
 </button>
 <button type="button" onClick={() => insertMd('- ', '', t('publisher.editor.bulletPh'))} className={mdBtnClass}>
 • {t('publisher.editor.bullet')}
 </button>
 <button type="button" onClick={() => insertMd('**', '**', t('publisher.editor.boldPh'))} className={mdBtnClass} aria-label={t('publisher.editor.bold')}>
 <strong>B</strong>
 </button>
 <button type="button" onClick={insertMdTemplate} className={mdBtnClass}>
 <Sparkles className="inline-block w-3.5 h-3.5 mr-1" aria-hidden="true" />
 {t('publisher.editor.template')}
 </button>
 <button
 type="button"
 onClick={() => setShowMdPreview(v => !v)}
 aria-pressed={showMdPreview}
 className={`${mdBtnClass} ${showMdPreview ? 'bg-accent-subtle text-link' : ''}`}
 >
 {showMdPreview ? t('publisher.editor.hidePreview') : t('publisher.editor.preview')}
 </button>
 </div>
 )}
 <textarea
 id="pub-description"
 required
 rows={6}
 ref={descriptionRef}
 value={description}
 onChange={e => setDescription(e.target.value)}
 spellCheck={true}
 aria-describedby="pub-description-count"
 className={`${inputClass} resize-y min-h-[140px]`}
 placeholder={t('publisher.ad.descriptionPlaceholder')}
 />
 <div className="mt-1 flex items-center justify-between gap-2">
 <p className="text-xs text-muted">
 {t('publisher.ad.descriptionHint')}
 {!isFree && <> {t('publisher.editor.hint')}</>}
 </p>
 <p
 id="pub-description-count"
 className={`text-xs font-medium tabular-nums ${descriptionWords < DESCRIPTION_MIN_WORDS ? 'text-danger' : 'text-success'}`}
 aria-live="polite"
 >
 {t('publisher.ad.descriptionWordCount', { current: descriptionWords, min: DESCRIPTION_MIN_WORDS })}
 </p>
 </div>
 {!isFree && showMdPreview && (
 <div
 className="mt-2 rounded-xl border border-edge bg-surface-alt p-4 text-sm text-body"
 aria-label={t('publisher.editor.preview')}
 dangerouslySetInnerHTML={{
 __html: renderPublisherMarkdown(description)
 || `<p class="text-muted">${t('publisher.editor.previewEmpty')}</p>`,
 }}
 />
 )}
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
 <div>
 <label htmlFor="pub-category" className={labelClass}>
 {t('publisher.ad.category')}
 </label>
 <select
 id="pub-category"
 value={category}
 onChange={e => setCategory(e.target.value)}
 className={inputClass}
 >
 <option value="">{t('publisher.ad.category.placeholder')}</option>
 {CATEGORY_SLUGS.map(slug => (
 <option key={slug} value={slug}>
 {t(`publisher.ad.category.${slug}`)}
 </option>
 ))}
 </select>
 </div>
 <div>
 <label htmlFor="pub-contract-type" className={labelClass}>
 {t('publisher.ad.contractType')}
 </label>
 <select
 id="pub-contract-type"
 value={contractType}
 onChange={e => setContractType(e.target.value)}
 className={inputClass}
 >
 {CONTRACT_TYPES.map(opt => (
 <option key={opt.value} value={opt.value}>
 {t(opt.labelKey)}
 </option>
 ))}
 </select>
 </div>
 </div>
 <div>
 <label htmlFor="pub-sector" className={labelClass}>
 {t('publisher.ad.sector')}
 </label>
 <input
 id="pub-sector"
 type="text"
 value={sector}
 onChange={e => setSector(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.ad.sector.placeholder')}
 />
 </div>
 <div>
 <label htmlFor="pub-employment" className={labelClass}>
 {t('publisher.ad.employmentType')}
 </label>
 <select
 id="pub-employment"
 value={employmentType}
 onChange={e => setEmploymentType(e.target.value)}
 className={inputClass}
 >
 {EMPLOYMENT_TYPES.map(opt => (
 <option key={opt.value} value={opt.value}>
 {t(opt.labelKey)}
 </option>
 ))}
 </select>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
 <div>
 <label htmlFor="pub-salary-min" className={labelClass}>
 {t('publisher.ad.salaryMin')}
 </label>
 <input
 id="pub-salary-min"
 type="number"
 min={0}
 inputMode="numeric"
 value={salaryMin}
 onChange={e => setSalaryMin(e.target.value)}
 className={inputClass}
 />
 </div>
 <div>
 <label htmlFor="pub-salary-max" className={labelClass}>
 {t('publisher.ad.salaryMax')}
 </label>
 <input
 id="pub-salary-max"
 type="number"
 min={0}
 inputMode="numeric"
 value={salaryMax}
 onChange={e => setSalaryMax(e.target.value)}
 className={inputClass}
 />
 </div>
 </div>
 {!isFree && (
 <div className="rounded-xl border border-accent/40 bg-accent-subtle p-4">
 <label className="flex items-start gap-2 cursor-pointer">
 <input
 type="checkbox"
 checked={featured}
 onChange={e => setFeatured(e.target.checked)}
 className="mt-1 flex-shrink-0"
 />
 <span>
 <span className="block text-sm font-medium text-strong">{t('publisher.featured.label')}</span>
 <span className="block text-xs text-muted mt-0.5">{t('publisher.featured.hint')}</span>
 </span>
 </label>
 </div>
 )}
 </div>
 </section>

 {/* ── Locations ──────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.locations.section')}</h2>
 <p className="text-xs text-muted mb-3">{t('publisher.locations.hint')}</p>
 <div className="space-y-4">
 {locations.map((loc, index) => (
 <div key={index} className="rounded-2xl border border-edge bg-surface-alt p-4 space-y-3">
 <div className="flex items-end gap-2">
 <div className="flex-1">
 <label htmlFor={`pub-location-${index}`} className={labelClass}>
 {t('publisher.locations.label')} {index + 1} *
 </label>
 <input
 id={`pub-location-${index}`}
 type="text"
 value={loc.label}
 onChange={e => updateLocation(index, { label: e.target.value })}
 className={inputClass}
 placeholder={t('publisher.locations.placeholder')}
 />
 </div>
 {!isEdit && locations.length > 1 && (
 <button
 type="button"
 onClick={() => removeLocation(index)}
 aria-label={t('publisher.locations.remove')}
 className="flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl border border-edge text-subtle hover:text-danger hover:border-danger-border transition-colors"
 >
 <Trash2 className="w-4 h-4" />
 </button>
 )}
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <div>
 <label htmlFor={`pub-location-postal-${index}`} className={labelClass}>
 {t('publisher.locations.postalCode')}
 </label>
 <input
 id={`pub-location-postal-${index}`}
 type="text"
 inputMode="numeric"
 autoComplete="postal-code"
 value={loc.postalCode}
 onChange={e => updateLocation(index, { postalCode: e.target.value })}
 className={inputClass}
 placeholder="6900"
 />
 </div>
 <div>
 <label htmlFor={`pub-location-canton-${index}`} className={labelClass}>
 {t('publisher.locations.canton')}
 </label>
 <select
 id={`pub-location-canton-${index}`}
 value={loc.canton}
 onChange={e => updateLocation(index, { canton: e.target.value })}
 className={inputClass}
 >
 {cantonOptions.map(opt => (
 <option key={opt.code} value={opt.code}>
 {opt.label} ({opt.code})
 </option>
 ))}
 </select>
 </div>
 </div>
 <div>
 <label htmlFor={`pub-location-street-${index}`} className={labelClass}>
 {t('publisher.locations.street')}
 </label>
 <input
 id={`pub-location-street-${index}`}
 type="text"
 autoComplete="street-address"
 value={loc.street}
 onChange={e => updateLocation(index, { street: e.target.value })}
 className={inputClass}
 placeholder="Via Nassa 5"
 />
 </div>
 </div>
 ))}
 </div>
 {!isEdit && (
 <button
 type="button"
 onClick={addLocation}
 className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-link border border-edge rounded-xl hover:bg-surface-alt transition-colors"
 >
 <Plus className="w-4 h-4" />
 {t('publisher.locations.add')}
 </button>
 )}
 </section>

 {/* ── Apply ──────────────────────────────────────────── */}
 <section>
 <h2 className={sectionTitleClass}>{t('publisher.apply.section')}</h2>
 <div className="space-y-5">
 {isFree ? (
 <p className="text-xs text-muted">{t('publisher.apply.freeOnlyExternal')}</p>
 ) : (
 <div>
 <label htmlFor="pub-apply-mode" className={labelClass}>
 {t('publisher.apply.mode')}
 </label>
 <select
 id="pub-apply-mode"
 value={applyMode}
 onChange={e => setApplyMode(e.target.value as ApplyMode)}
 className={inputClass}
 >
 {APPLY_MODES.map(opt => (
 <option key={opt.value} value={opt.value}>
 {t(opt.labelKey)}
 </option>
 ))}
 </select>
 </div>
 )}
 {applyMode === 'external_url' && (
 <div>
 <label htmlFor="pub-apply-url" className={labelClass}>
 {t('publisher.apply.url')} *
 </label>
 <input
 id="pub-apply-url"
 type="url"
 value={applyUrl}
 onChange={e => setApplyUrl(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.apply.urlPlaceholder')}
 />
 </div>
 )}
 {(applyMode === 'forward_email' || applyMode === 'in_house') && (
 <div>
 <label htmlFor="pub-apply-email" className={labelClass}>
 {t('publisher.apply.email')} *
 </label>
 <input
 id="pub-apply-email"
 type="email"
 value={applyEmail}
 onChange={e => setApplyEmail(e.target.value)}
 autoComplete="email"
 className={inputClass}
 placeholder={t('publisher.apply.emailPlaceholder')}
 />
 </div>
 )}
 <div>
 <label htmlFor="pub-privacy-url" className={labelClass}>
 {t('publisher.apply.privacyPolicyUrl')}
 </label>
 <input
 id="pub-privacy-url"
 type="url"
 value={privacyPolicyUrl}
 onChange={e => setPrivacyPolicyUrl(e.target.value)}
 className={inputClass}
 placeholder={t('publisher.apply.urlPlaceholder')}
 />
 </div>
 </div>
 </section>

 {/* ── Add-another-ad + cart ──────────────────────────── */}
 {/* Hidden in edit mode — editing is a single-ad, in-place update. */}
 {!isEdit && (
 <section>
 <button
 type="button"
 onClick={handleAddToCart}
 className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-link border border-dashed border-edge rounded-xl hover:bg-surface-alt transition-colors"
 >
 <Plus className="w-4 h-4" />
 {t('publisher.cart.add')}
 </button>
 {cart.length > 0 && (
 <div className="mt-4 rounded-2xl border border-edge bg-surface-alt p-4">
 <h2 className="flex items-center gap-2 text-base font-semibold font-display text-strong mb-3">
 <ShoppingCart className="w-4 h-4 text-link flex-shrink-0" />
 {t('publisher.cart.title')}
 </h2>
 <ul className="space-y-2">
 {cart.map(item => {
 const count = distinctLocationLabels(item.locations).length;
 return (
 <li
 key={item.id}
 className="flex items-center gap-3 rounded-xl border border-edge bg-surface p-3"
 >
 <div className="flex-1 min-w-0">
 <p className="text-sm font-medium text-strong truncate">
 {item.title.trim() || t('publisher.ad.title')}
 </p>
 <p className="text-xs text-subtle mt-0.5">
 {t('publisher.cart.locationsCount', { n: count })}
 </p>
 </div>
 <button
 type="button"
 onClick={() => removeCartItem(item.id)}
 aria-label={`${t('publisher.cart.remove')}: ${item.title.trim() || t('publisher.ad.title')}`}
 className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-xl border border-edge text-subtle hover:text-danger hover:border-danger-border transition-colors"
 >
 <Trash2 className="w-4 h-4" />
 </button>
 </li>
 );
 })}
 </ul>
 </div>
 )}
 </section>
 )}

 {/* ── Price preview ──────────────────────────────────── */}
 <section className="rounded-2xl border border-edge bg-surface-alt p-5">
 <h2 className="text-base font-semibold font-display text-strong mb-2">
 {t('publisher.price.title')}
 </h2>
 {isFree ? (
 <>
 <p className="text-2xl font-bold text-strong">{t('publisher.price.free')}</p>
 <p className="text-xs text-muted mt-2">{t('publisher.price.freeNote')}</p>
 </>
 ) : (
 <>
 <p className="text-2xl font-bold text-strong">
 {t('publisher.price.perPeriod', { n: price.netChf })}
 </p>
 <p className="text-sm text-subtle mt-1">
 {t('publisher.price.units', { n: price.units })}
 </p>
 {price.discountRate > 0 && (
 <p className="text-sm text-success mt-1">
 {t('publisher.price.discount', {
 pct: Math.round(price.discountRate * 100),
 amount: price.discountChf,
 })}
 </p>
 )}
 <p className="text-xs text-muted mt-2">{t('publisher.price.autoRenew')}</p>
 <p className="text-xs text-muted mt-1">{t('publisher.price.invoiceNote')}</p>
 </>
 )}
 </section>

 {/* ── Validation errors ──────────────────────────────── */}
 {errors.length > 0 && (
 <div className="flex items-start gap-2 p-3 rounded-xl bg-danger-subtle border border-danger-border">
 <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
 <ul className="text-sm text-danger space-y-1">
 {errors.map((err, i) => (
 <li key={i}>{err}</li>
 ))}
 </ul>
 </div>
 )}

 {/* ── Submit error ───────────────────────────────────── */}
 {status === 'error' && (
 <div className="flex items-center gap-2 p-3 rounded-xl bg-danger-subtle border border-danger-border">
 <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
 <p className="text-sm text-danger">{errorMessage || t('publisher.error')}</p>
 </div>
 )}

 {/* ── Post-payment notice ────────────────────────────── */}
 <div className="flex items-center gap-2 text-sm text-subtle">
 <Clock className="w-4 h-4 flex-shrink-0" />
 <span>{t('publisher.postPaymentNotice')}</span>
 </div>

 {/* ── Submit ─────────────────────────────────────────── */}
 <button
 type="submit"
 disabled={status === 'submitting' || status === 'redirecting'}
 className="w-full flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover disabled:bg-surface-muted disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
 >
 {status === 'submitting' || status === 'redirecting' ? (
 <>
 <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
 {status === 'redirecting' ? t('publisher.redirecting') : t('publisher.submitting')}
 </>
 ) : (
 <>
 <Send className="w-4 h-4" />
 {isEdit ? t('publisher.editSubmit') : isFree ? t('publisher.submitFree') : t('publisher.submit')}
 </>
 )}
 </button>

 {/* ── reCAPTCHA notice ───────────────────────────────── */}
 <div className="flex items-center justify-center gap-1.5 text-xs text-muted">
 <Shield className="w-3 h-3 flex-shrink-0" />
 <span>{t('publisher.recaptchaNotice')}</span>
 </div>
 </form>
 </div>
 );
};

export default PublisherPublishPage;
