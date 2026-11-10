/**
 * The value-shape invariant (2026-11-10, SuccessFactors #17094/#17181): a
 * value the runner writes must have the shape its field asks for. A section
 * caption read as the field's label put the applicant e-mail into «Vorname»
 * and «Nachname»; the portal cut it at its maxlength and the run stopped as
 * `portal_needs_candidate` without anyone seeing why, because the public stop
 * report carries no values.
 *
 * Pure helpers, no field-topic detection (that lives in plan.mjs, which owns
 * the label regexes: `expectedValueShape`, `valueFitsField`): what shape a
 * value has, whether it fits an expected shape, and how a value read back
 * from the page relates to the planned one. None of them returns the value
 * itself, so their output is safe in a public report.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DIGIT_RE = /\p{Nd}/u;
const DIGITS_ONLY_RE = /^[\p{Nd}\s]+$/u;
const PHONE_RE = /^\+?[\p{Nd}\s()./-]{6,}$/u;
const NUMERIC_DATE_RE = /^(?:\p{Nd}{4}-\p{Nd}{1,2}-\p{Nd}{1,2}|\p{Nd}{1,2}[./-]\p{Nd}{1,2}[./-]\p{Nd}{2,4}|\p{Nd}{1,2}[./-]\p{Nd}{4})$/u;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .’-]*$/u;

/** The shapes a field can expect (plan.mjs `expectedValueShape`). */
export const EXPECTED_VALUE_SHAPES = Object.freeze(['name', 'email', 'phone', 'date', 'postal_code']);

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();

/** The shape of a value, never the value: `email`, `digits`, `date`, `phone`, `name`, `text` or `empty`. */
export function valueShapeOf(value) {
  const shown = text(value);
  if (!shown) return 'empty';
  if (EMAIL_RE.test(shown)) return 'email';
  if (DIGITS_ONLY_RE.test(shown)) return 'digits';
  if (NUMERIC_DATE_RE.test(shown)) return 'date';
  if (PHONE_RE.test(shown) && DIGIT_RE.test(shown)) return 'phone';
  if (NAME_RE.test(shown)) return 'name';
  return 'text';
}

/**
 * Whether `value` can stand in a field that expects `expected`. An unknown
 * expectation or an empty value is accepted: the guard only vetoes a value
 * whose shape contradicts the field, it never decides what the field wants.
 * `identityEmail` is the applicant e-mail: a name field never holds it.
 */
export function shapeFits(expected, value, { identityEmail = '' } = {}) {
  const shown = text(value);
  if (!expected || !EXPECTED_VALUE_SHAPES.includes(expected) || !shown) return true;
  const email = text(identityEmail).toLowerCase();
  switch (expected) {
    case 'name':
      return !shown.includes('@')
        && !DIGITS_ONLY_RE.test(shown)
        && !(email && shown.toLowerCase() === email);
    case 'email':
      return EMAIL_RE.test(shown);
    case 'phone':
    case 'date':
      return DIGIT_RE.test(shown) && !shown.includes('@');
    case 'postal_code':
      return DIGIT_RE.test(shown) && !shown.includes('@') && shown.length <= 12;
    default:
      return true;
  }
}

const normalized = (value) => text(value).toLowerCase().replace(/\s+/g, ' ');

/**
 * How the value read back from the page relates to the planned one: `match`,
 * `empty`, `truncated` (the page holds a strict prefix of the plan and the
 * control caps its length, so the portal or `fitToLength` cut it), or
 * `mismatch`.
 */
export function readbackShape({ planned, read, maxLength } = {}) {
  const want = normalized(planned);
  const got = normalized(read);
  if (got === want) return 'match';
  if (!got) return 'empty';
  const cap = Number(maxLength);
  if (Number.isSafeInteger(cap) && cap > 0 && got.length <= cap && got.length < want.length && want.startsWith(got)) return 'truncated';
  return 'mismatch';
}

/**
 * The shape a public stop report shows for one field: `mismatch:<expected>`
 * when the value on the page contradicts what the field asks for, otherwise
 * the value's own shape. The value never leaves this function.
 */
export function reportedValueShape({ expected = '', value = '', identityEmail = '' } = {}) {
  const shape = valueShapeOf(value);
  if (shape !== 'empty' && expected && !shapeFits(expected, value, { identityEmail })) return `mismatch:${expected}`;
  return shape;
}

// `truncated` and `changed` come from a read-back (portal.mjs
// registrationReadbackFindings); `mismatch:<shape>` from reportedValueShape.
const PUBLIC_SHAPE_RE = /^(?:empty|email|digits|phone|date|name|text|truncated|changed|mismatch:(?:name|email|phone|date|postal_code))$/;

/** A shape safe to publish: one of the closed vocabulary above, else ''. */
export function publicValueShape(shape) {
  const value = String(shape || '').trim();
  return PUBLIC_SHAPE_RE.test(value) ? value : '';
}
