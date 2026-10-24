/**
 * Canonical JobPosting field contract.
 *
 * The post-build validator, the structured-data completeness scan, and the
 * consolidated dist audit all inspect the same fields. Keep the field
 * semantics here so a new producer cannot pass one gate while failing another
 * because a copy drifted (issue #10499).
 *
 * Owner decision 2026-10-24: the JobPosting is always emitted for an active
 * job, and each field is present if and only if the source states it. So the
 * contract has two halves:
 *   - REQUIRED (Google's required set): title, description, datePosted,
 *     hiringOrganization.name, jobLocation with addressLocality and
 *     addressCountry. Missing = error, as before.
 *   - OPTIONAL fields (employmentType, baseSalary, postalCode,
 *     streetAddress): absent is the contract, present-but-malformed is an
 *     error. Whether a present value really comes from the source is checked
 *     against data/jobs.json by scripts/validate-jobs-rich-results-sample.mjs.
 *
 * Consumer-specific checks stay in their callers.
 */

export const MANDATORY_JOBPOSTING_FIELDS = Object.freeze([
  'title',
  'description',
  'datePosted',
  'hiringOrganization.name',
  'jobLocation',
  'jobLocation.address.addressLocality',
  'jobLocation.address.addressCountry',
]);

/** Validated when present, never required (they exist only when the source states them). */
export const OPTIONAL_JOBPOSTING_FIELDS = Object.freeze([
  'employmentType',
  'baseSalary',
  'jobLocation.address.postalCode',
  'jobLocation.address.streetAddress',
  'validThrough',
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
 * Validate the shared JobPosting contract: required fields present, optional
 * fields well-formed when present.
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

  if (posting.employmentType !== undefined) {
    const types = Array.isArray(posting.employmentType) ? posting.employmentType : [posting.employmentType];
    if (types.length === 0 || !types.every(isNonEmptyString)) {
      add('employmentType', 'employmentType present but empty');
    } else {
      for (const type of types) {
        if (!JOBPOSTING_EMPLOYMENT_TYPES.has(type)) {
          add('employmentType', `employmentType="${type}" not in schema.org enum`);
        }
      }
    }
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
      if (!isNonEmptyString(address.addressLocality)) {
        add('jobLocation.address.addressLocality', 'jobLocation.address.addressLocality missing/empty');
      }
      if (!isNonEmptyString(address.addressCountry)) {
        add('jobLocation.address.addressCountry', 'jobLocation.address.addressCountry missing/empty');
      }
      if (address.postalCode !== undefined && !/^\d{4,5}$/.test(String(address.postalCode).trim())) {
        add(
          'jobLocation.address.postalCode',
          `jobLocation.address.postalCode="${address.postalCode}" invalid`,
        );
      }
      if (address.streetAddress !== undefined && !isNonEmptyString(address.streetAddress)) {
        add('jobLocation.address.streetAddress', 'jobLocation.address.streetAddress present but empty');
      }
    }
  }

  const salary = posting.baseSalary;
  if (salary !== undefined) {
    if (!salary || typeof salary !== 'object') {
      add('baseSalary', 'baseSalary present but not an object');
    } else {
      if (!isNonEmptyString(salary.currency)) {
        add('baseSalary.currency', 'baseSalary.currency missing/empty');
      }
      if (!salary.value || typeof salary.value !== 'object') {
        add('baseSalary.value', 'baseSalary.value missing');
      } else {
        const min = Number(salary.value.minValue);
        if (!Number.isFinite(min) || !(min > 0)) {
          add(
            'baseSalary.value.minValue',
            `baseSalary.value.minValue=${salary.value.minValue} must be > 0`,
          );
        }
        if (salary.value.maxValue !== undefined) {
          const max = Number(salary.value.maxValue);
          if (!Number.isFinite(max) || !(max >= min)) {
            add(
              'baseSalary.value.maxValue',
              `baseSalary.value.maxValue=${salary.value.maxValue} must be >= minValue`,
            );
          }
        }
        if (!isNonEmptyString(salary.value.unitText)) {
          add('baseSalary.value.unitText', 'baseSalary.value.unitText missing/empty');
        }
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
