# Ti.CH Crawler Fix Notes - COMPREHENSIVE

## Project: `/Users/saggesel/Projects/frontaliere-si-o-no`
## Main file: `scripts/lib/shared-jobs-crawler.mjs`
## Wrapper: `scripts/update-tich-jobs.mjs` (525 lines)

## EXACT CODE TO CHANGE:

### 1. SLUG TRUNCATION FIX (line 831-839)
Current code:
```javascript
function slugify(input = '') {
  return normalizeSpace(decodeNumericEntities(decodeHtmlEntities(input)))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}
```
FIX: Change `.slice(0, 90)` → `.slice(0, 120)`

### 2. NOISE PATTERNS FIX (after line 926)
Current DESCRIPTION_NOISE_PATTERNS array ends with:
```javascript
  /\s*-\s*Privacy\s*-\s*Termini di utilizzo\s*-\s*Cookies\s*$/i,
];
```
ADD BEFORE closing bracket:
```javascript
  // Rexx Systems / ATS portal navigation noise
  /\bIndietro\b\s*$/im,
  /\bcandidatura online\s*[»>]?\s*$/im,
  /\bStampa\s*$/im,
  /\bIndietro\s+candidatura online\s*[»>]?\s*$/im,
  /\bBack\b\s*$/im,
  /\bOnline application\s*[»>]?\s*$/im,
```

### 3. cleanDescription IMPROVEMENTS (line 870-889)  
Current:
```javascript
function cleanDescription(desc) {
  let text = stripHtml(desc);
  text = text
    .replace(/(privacy policy|cookie policy|all rights reserved|accept all cookies|manage preferences)/gi, ' ')
    .replace(/(apply now|candidati ora|learn more|scopri di più)\s*$/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
  text = stripDescriptionBoilerplate(text);
  if (text.length > MAX_DESC_CHARS) text = text.slice(0, MAX_DESC_CHARS).trim();
  return text;
}
```
ADD after stripHtml:
- Strip excessive bold/strong: `text = text.replace(/\*\*([^*]+)\*\*/g, '$1')` - only if >3 bold segments
- Strip duplicate consecutive lines 
- Strip "Descrizione posizione Descrizione" pattern
- Strip "Indietro candidatura online »"

### 4. formatRexxDescription IMPROVEMENTS (line 1090-1228)
This is the Rexx Systems HTML parser. Issues:
- Too much bold text from <strong>/<b> tags
- Duplicate "Descrizione" heading text
- Missing noise cleanup for "Indietro candidatura online »"
- Need to strip bold inside paragraph content (keep for headings only)

FIX: In formatRexxDescription:
- Strip <strong>/<b> tags (keep content) before section extraction
- Add "Descrizione posizione" as noise section to strip
- Strip "Indietro" and "candidatura online" fragments
- Strip duplicate consecutive sections

### 5. extractCompanyFromText is ALREADY CORRECT (line 1969-1986)
It checks for Rexx page first and returns "Repubblica e Cantone Ticino" or department.
But the wrong company issue means isRexxPage check (`/emp_nr_(?:inner|outer)frame/i.test(html)`) 
may be FAILING on some pages. NEED TO CHECK: does the HTML from these pages actually contain 
emp_nr_innerframe? If not, the check falls through and picks up garbage.

### 6. extractRexxSalary is CORRECT (line 1230-1300)
Regex for salary: /Classe e stipendio annuo\s*\([^)]*\)\s*:?\s*(?:\n|\r|\s)*(\d{1,2})\s+(\d[\d'\u2019]*)\.--\s*\/\s*(\d[\d'\u2019]*)\.--/i
Falls through to range fallback. But may fail on specific formats.

### 7. ensureJobSlug (line 3973) - uses slugify internally

## KEY CONTEXT:
- extractRichJobDescription at line 1680 calls formatRexxDescription for Rexx pages:
```javascript
const rexxMatch = String(html).match(/<div class=["']emp_nr_innerframe["']>([\s\S]*)/i);
if (rexxMatch) {
    const rexxText = formatRexxDescription(rexxMatch[1]);
    if (rexxText.length >= 100) return rexxText;
}
```
- Job creation at lines 3870-3946 uses extractCompanyFromText, extractRexxSalary
- isRexxPage check: /emp_nr_(?:inner|outer)frame/i.test(html)

## IMPLEMENTATION ORDER:
1. Fix slugify (.slice(0,120)) - line 838
2. Fix cleanDescription - add dedup + noise removal (line 870-889)
3. Fix DESCRIPTION_NOISE_PATTERNS - add Rexx/ATS noise (after line 926)
4. Fix formatRexxDescription - strip bold overuse, dedup sections (line 1090-1228)
5. Test: `npx vitest run` + `npx vite build`  
6. Commit and push

## ADDITIONAL COMMON FIXES (benefit all crawlers):
- cleanDescription: strip duplicate consecutive lines
- cleanDescription: strip excessive bold (>3 bold segments → strip all bold)
- DESCRIPTION_NOISE_PATTERNS: add more universal ATS noise patterns
