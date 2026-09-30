/**
 * Canonical JobPosting mandatory-field contract.
 *
 * The post-build validator, the structured-data completeness scan, and the
 * consolidated dist audit all inspect the same nine fields. Keep the field
 * semantics here so a new producer cannot pass one gate while failing another
 * because a copy drifted (issue #10499).
 *
 * Consumer-specific checks stay in their callers. For example, `validThrough`
 * belongs to the structured-data completeness consumer and is not one of the
 * nine fields in AGENTS.md rule #3.
 */

export const MANDATORY_JOBPOSTING_FIELDS = Object.freeze([
  'title',
  'description',
  'datePosted',
  'employmentType',
  'hiringOrganization.name',
  'jobLocation',
  'jobLocation.address.postalCode',
  'jobLocation.address.streetAddress',
  'baseSalary',
]);

export const JOBPOSTING_EMPLOYMENT_TYPES = new Set([
  'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY',
  'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER',
]);

export const JOBPOSTING_MIN_DESCRIPTION_LENGTH = 50;

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidIsoDate(value) {
  if (!isNonEmptyString(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * @typedef {{field: string, message: string}} JobPostingMandatoryError
 */

/**
 * Validate the shared nine-field JobPosting contract.
 *
 * The returned `field` is the canonical field path used by structured-data
 * reports. A single top-level field may produce more than one detail (for
 * example `baseSalary.currency` and `baseSalary.value.minValue`).
 *
 * @param {unknown} schema
 * @returns {JobPostingMandatoryError[]}
 */
export function validateMandatoryJobPostingFields(schema) {
  const posting = schema && typeof schema === 'object' ? schema : {};
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (!isNonEmptyString(posting.title)) add('title', 'title missing/empty');

  if (!isNonEmptyString(posting.description)) {
    add('description', 'description missing/empty');
  } else if (posting.description.trim().length < JOBPOSTING_MIN_DESCRIPTION_LENGTH) {
    add(
      'description',
      `description too short (${posting.description.trim().length} < ${JOBPOSTING_MIN_DESCRIPTION_LENGTH})`,
    );
  }

  if (!isValidIsoDate(posting.datePosted)) add('datePosted', 'datePosted missing/invalid');

  if (!isNonEmptyString(posting.employmentType)) {
    add('employmentType', 'employmentType missing/empty');
  } else if (!JOBPOSTING_EMPLOYMENT_TYPES.has(posting.employmentType)) {
    add(
      'employmentType',
      `employmentType="${posting.employmentType}" not in schema.org enum`,
    );
  }

  if (!posting.hiringOrganization || typeof posting.hiringOrganization !== 'object') {
    add('hiringOrganization.name', 'hiringOrganization missing');
  } else if (!isNonEmptyString(posting.hiringOrganization.name)) {
    add('hiringOrganization.name', 'hiringOrganization.name missing/empty');
  }

  const location = posting.jobLocation;
  if (!location || typeof location !== 'object') {
    add('jobLocation', 'jobLocation missing');
  } else {
    const address = location.address;
    if (!address || typeof address !== 'object') {
      add('jobLocation', 'jobLocation.address missing');
    } else {
      if (!isNonEmptyString(address.postalCode)) {
        add('jobLocation.address.postalCode', 'jobLocation.address.postalCode missing/empty');
      } else if (!/^\d{4,5}$/.test(String(address.postalCode).trim())) {
        add(
          'jobLocation.address.postalCode',
          `jobLocation.address.postalCode="${address.postalCode}" invalid`,
        );
      }
      if (!isNonEmptyString(address.streetAddress)) {
        add('jobLocation.address.streetAddress', 'jobLocation.address.streetAddress missing/empty');
      }
    }
  }

  const salary = posting.baseSalary;
  if (!salary || typeof salary !== 'object') {
    add('baseSalary', 'baseSalary missing');
  } else {
    if (!isNonEmptyString(salary.currency)) {
      add('baseSalary.currency', 'baseSalary.currency missing/empty');
    }
    if (!salary.value || typeof salary.value !== 'object') {
      add('baseSalary.value', 'baseSalary.value missing');
    } else {
      const min = Number(salary.value.minValue);
      const max = Number(salary.value.maxValue);
      if (!Number.isFinite(min) || !(min > 0)) {
        add(
          'baseSalary.value.minValue',
          `baseSalary.value.minValue=${salary.value.minValue} must be > 0`,
        );
      }
      if (!Number.isFinite(max) || !(max >= min)) {
        add(
          'baseSalary.value.maxValue',
          `baseSalary.value.maxValue=${salary.value.maxValue} must be >= minValue`,
        );
      }
      if (!isNonEmptyString(salary.value.unitText)) {
        add('baseSalary.value.unitText', 'baseSalary.value.unitText missing/empty');
      }
    }
  }

  return errors;
}

/**
 * Adapt a shared violation to the error shape used by the completeness gates.
 * Keeping this formatter here prevents the three consumers from inventing
 * different field/message mappings while preserving their existing report
 * shape.
 */
export function toStructuredDataJobPostingError(error, filePath) {
  return {
    file: filePath,
    type: 'JobPosting',
    field: error.field,
    message: `JobPosting ${error.message}`,
  };
}
