/**
 * A mutation with no definitive rejection may already have been accepted by
 * the platform. Keep its reservation and never replay it automatically.
 * @param {{ status?: number|string|null }|null|undefined} response
 * @returns {boolean}
 */
export function isAmbiguousSocialPublishResponse(response) {
  const rawStatus = response?.status;
  if (rawStatus === undefined || rawStatus === null || rawStatus === '') return true;
  const status = Number(rawStatus);
  return !Number.isInteger(status) || status < 200 || (status >= 300 && status < 400) || status === 408 || status >= 500;
}
