/**
 * Shared job-description parser used by both the SSG build plugin
 * (`build-plugins/jobsSeoPagesPlugin.ts`) and the React SPA renderer
 * (`components/community/JobBoard.tsx`).
 *
 * Crawler/AI-translated descriptions arrive with unbalanced `**` markers,
 * collapsed newlines, separator-only lines, and consecutive duplicate
 * paragraphs. This parser produces a stable AST so both render paths emit
 * the same structure.
 */

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'em'; value: string };

export type Block =
  | { kind: 'heading'; level: 2 | 3; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] };

function decodeNoiseEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_m, c) => {
      const n = Number(c);
      return n >= 32 && n < 0x10ffff ? String.fromCharCode(n) : ' ';
    });
}

const SEPARATOR_LINE_RE = /^[\s_\-=*•·~]{3,}$/;

const SECTION_LABELS = new Set(
  [
    'compiti',
    'responsabilità',
    'responsabilita',
    'requisiti',
    'profilo',
    'profilo richiesto',
    'profilo ricercato',
    'cosa offriamo',
    'cosa offre',
    'la tua missione',
    'le tue responsabilità',
    'cosa farai',
    'chi cerchiamo',
    'chi sei',
    'cosa cerchiamo',
    'esperienza',
    'formazione',
    'competenze',
    'lingue',
    'benefit',
    'candidatura',
    'come candidarsi',
    'tasks',
    'duties',
    'main duties',
    'main duties and responsibilities',
    'responsibilities',
    'requirements',
    'profile',
    'we offer',
    'what we offer',
    'your mission',
    'your responsibilities',
    'about you',
    'who you are',
    'experience',
    'education',
    'skills',
    'languages',
    'benefits',
    'how to apply',
    'aufgaben',
    'ihre aufgaben',
    'anforderungen',
    'profil',
    'ihr profil',
    'wir bieten',
    'was wir bieten',
    'erfahrung',
    'ausbildung',
    'kenntnisse',
    'sprachen',
    'vorteile',
    'bewerbung',
    'missions',
    'vos missions',
    'profil recherché',
    'nous offrons',
    'ce que nous offrons',
    'expérience',
    'formation',
    'compétences',
    'competences',
    'langues',
    'avantages',
    'candidature',
  ].map((s) => s.toLowerCase()),
);

function stripLabelDecoration(s: string): string {
  let t = s.trim();
  t = t.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '');
  t = t.replace(/[\s:：–—\-]+$/, '');
  return t.trim();
}

function isSectionLabel(line: string): boolean {
  const trimmed = line.trim();
  const cleaned = stripLabelDecoration(trimmed).toLowerCase();
  if (!cleaned) return false;
  if (cleaned.length > 60) return false;
  if (SECTION_LABELS.has(cleaned)) return true;
  if (trimmed.length <= 64 && /[:：]\s*$/.test(trimmed)) {
    const body = trimmed.replace(/[:：]\s*$/, '').trim();
    if (
      body.length >= 3 &&
      body.length <= 60 &&
      !/[.!?]/.test(body) &&
      /^[A-ZÀ-ÖØ-Þ*]/.test(body)
    ) {
      return true;
    }
  }
  return false;
}

function preprocess(raw: string): string {
  let s = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/ /g, ' ');
  s = decodeNoiseEntities(s);

  // Mid-line separator runs were paragraph breaks in the source HTML that
  // were flattened by AI-translation passes. Example seen in HFR (Hôpital
  // Fribourgeois) descriptions: "Ref.: HFR-M-251801 _______ Le Département…".
  // The whole-line and trailing-separator strips below only match separators
  // that already sit on their own line. Convert mid-line `_`/`=`/`~` runs to a
  // paragraph break first so the subsequent SEPARATOR_LINE_RE filter drops
  // them. Audit: no-literal-markdown 0-tol (CLAUDE.md rule #1).
  s = s.replace(/[ \t]+[_=~]{3,}[ \t]+/g, '\n\n');
  // PR #481 follow-up: above only catches separator runs with whitespace on
  // BOTH sides. AMEOS / Hôpital Fribourgeois descriptions sometimes flatten
  // to literal `text________________…________________text` (64+ chars, no
  // surrounding whitespace) — those slip through and trip
  // audit-no-literal-markdown. Threshold lowered from 6+ to 3+ (matches
  // `SEPARATOR_RUN_RE` in scripts/audit-no-literal-markdown.mjs and mirrors
  // the same fix PR #500 applied to `inlineTextToHtml`): with the fallback
  // splitter wired on 100% of jobs (PR #498), 3-5 char runs (`===`, `~~~~`)
  // mid-paragraph leaked into 156 job pages in validate-dist run
  // 26312619412. A real text identifier never carries 3+ `_=~` in a row, so
  // collapsing to `\n\n` (paragraph break) is always safe.
  s = s.replace(/[_=~]{3,}/g, '\n\n');

  s = s.replace(/;\s*([A-ZÀ-ÖØ-Þ][^.;!?\n]{1,80}[:：])/g, '\n$1');
  s = s.replace(/([a-zà-öø-þ.0-9%])\s*;\s*([A-ZÀ-ÖØ-Þ][a-zà-öø-þ])/g, '$1\n- $2');

  s = s.replace(/([^\n])\s+([•·]\s)/g, '$1\n$2');

  s = s.replace(
    /(^|\n)([ \t]*)\*\*([^*\n]{2,60})\*\*([ \t]*[:：]?)(?=[ \t]*\n|$)/g,
    '$1$2**$3**$4',
  );

  // "## Heading - item1 - item2 - item3" (≥3 inline dashes) → split into
  // heading + bullet list. Real pattern seen in Amministrazione Cantonale
  // (Ticino) job posts. Accepts both Capital and lowercase items.
  s = s.replace(
    /(^|\n)((?:#{2,4}\s+)?[^\n]+?)((?: - [^\n -][^\n]*){3,})(?=\n|$)/g,
    (_match, prefix, heading, dashes) => {
      const items = dashes
        .split(/ - /)
        .map((part: string) => part.trim())
        .filter((part: string) => part.length > 0);
      const cleanHeading = String(heading).trim();
      return `${prefix}${cleanHeading}\n- ${items.join('\n- ')}`;
    },
  );

  s = s
    .split('\n')
    .map((line) =>
      // Strip trailing separator runs that hug the end of a real line
      // (e.g. "Be part of something. ______" → "Be part of something.").
      line.replace(/\s+[_\-=~*]{3,}\s*$/g, '').trimEnd(),
    )
    .filter((line) => !SEPARATOR_LINE_RE.test(line))
    .join('\n');

  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

export function parseInline(text: string): Inline[] {
  if (!text) return [];

  let s = text.replace(/\*\*\s*[\s:;,.\-–—]*\s*\*\*/g, ' ');

  const doubleStars = (s.match(/\*\*/g) || []).length;
  if (doubleStars % 2 !== 0) {
    s = s.replace(/\*\*/g, '');
  }

  const out: Inline[] = [];
  const re = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: 'text', value: s.slice(lastIndex, m.index) });
    }
    const inner = (m[1] ?? m[2] ?? '').trim();
    if (!inner) {
      // skip empty
    } else if (m[1] !== undefined) {
      out.push({ kind: 'strong', value: inner });
    } else {
      out.push({ kind: 'em', value: inner });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < s.length) {
    out.push({ kind: 'text', value: s.slice(lastIndex) });
  }

  const collapsed: Inline[] = [];
  for (const tok of out) {
    if (tok.kind === 'text') {
      const v = tok.value.replace(/[ \t]+/g, ' ');
      if (!v.trim() && collapsed.length > 0) {
        const last = collapsed[collapsed.length - 1];
        if (last.kind === 'text') {
          last.value = (last.value + ' ').replace(/  +/g, ' ');
        } else {
          collapsed.push({ kind: 'text', value: ' ' });
        }
        continue;
      }
      collapsed.push({ kind: 'text', value: v });
    } else {
      collapsed.push(tok);
    }
  }
  while (collapsed.length > 0 && collapsed[0].kind === 'text' && !collapsed[0].value.trim()) {
    collapsed.shift();
  }
  while (
    collapsed.length > 0 &&
    collapsed[collapsed.length - 1].kind === 'text' &&
    !(collapsed[collapsed.length - 1] as { value: string }).value.trim()
  ) {
    collapsed.pop();
  }

  return collapsed;
}

function inlinesToText(inlines: Inline[]): string {
  return inlines.map((t) => t.value).join('').trim();
}

function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BULLET_RE = /^\s*[-•*]\s+(.+)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.+)$/;
const MAX_HEADING_CHARS = 120;

export function parseJobDescription(raw: string): Block[] {
  const pre = preprocess(raw);
  if (!pre) return [];

  const lines = pre.split('\n');
  const blocks: Block[] = [];

  let i = 0;
  const seenParagraphs = new Set<string>();

  const pushParagraph = (text: string): void => {
    const inlines = parseInline(text);
    if (inlines.length === 0) return;
    const plain = inlinesToText(inlines);
    if (plain.length < 2) return;
    const key = normalizeForDedup(plain);
    if (seenParagraphs.has(key)) return;
    seenParagraphs.add(key);
    blocks.push({ kind: 'paragraph', children: inlines });
  };

  const pushHeading = (text: string, level: 2 | 3 = 2): void => {
    const cleanText = stripLabelDecoration(text);
    if (!cleanText) return;
    if (cleanText.length > MAX_HEADING_CHARS) {
      pushParagraph(text);
      return;
    }
    const last = blocks[blocks.length - 1];
    if (
      last &&
      last.kind === 'heading' &&
      inlinesToText(last.children).toLowerCase() === cleanText.toLowerCase()
    ) {
      return;
    }
    blocks.push({
      kind: 'heading',
      level,
      children: parseInline(cleanText),
    });
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const mdHeader = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (mdHeader) {
      const level = mdHeader[1].length === 2 ? 2 : 3;
      pushHeading(mdHeader[2], level as 2 | 3);
      i++;
      continue;
    }

    if (isSectionLabel(trimmed)) {
      pushHeading(trimmed, 2);
      i++;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        const m = lines[i].match(BULLET_RE)!;
        const inline = parseInline(m[1]);
        if (inline.length > 0) items.push(inline);
        i++;
      }
      if (items.length > 0) blocks.push({ kind: 'list', ordered: false, items });
      continue;
    }

    if (NUMBERED_RE.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && NUMBERED_RE.test(lines[i])) {
        const m = lines[i].match(NUMBERED_RE)!;
        const inline = parseInline(m[1]);
        if (inline.length > 0) items.push(inline);
        i++;
      }
      if (items.length > 0) blocks.push({ kind: 'list', ordered: true, items });
      continue;
    }

    const buf: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrim = next.trim();
      if (!nextTrim) break;
      if (BULLET_RE.test(next) || NUMBERED_RE.test(next)) break;
      if (/^#{2,4}\s+/.test(nextTrim)) break;
      if (isSectionLabel(nextTrim)) break;
      buf.push(nextTrim);
      i++;
    }
    pushParagraph(buf.join(' '));
  }

  return blocks;
}

export function blocksToPlainText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      out.push(inlinesToText(b.children));
    } else if (b.kind === 'paragraph') {
      out.push(inlinesToText(b.children));
    } else {
      for (const item of b.items) out.push('• ' + inlinesToText(item));
    }
  }
  return out.join('\n').trim();
}
