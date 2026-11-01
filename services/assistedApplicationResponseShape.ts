/**
 * A checkout response can be a 200 the client still refuses, and `http_200`
 * alone cannot say why. This names the shape of that body for telemetry: field
 * presence and short enum values only, never order ids, URLs or provider ids.
 */
const SHAPE_TOKEN_RE = /^[a-z0-9_-]{1,20}$/i;
const SHAPE_MAX_CHARS = 100;

function shapeToken(value: unknown): string {
 if (value === undefined || value === null || value === '') return 'none';
 return typeof value === 'string' && SHAPE_TOKEN_RE.test(value) ? value : 'other';
}

function hasText(value: unknown): 0 | 1 {
 return typeof value === 'string' && value.length > 0 ? 1 : 0;
}

export function describeAssistedPaymentResponse(status: number, data: any): string {
 return [
  `http=${status}`,
  `ok=${data?.ok ? 1 : 0}`,
  `status=${shapeToken(data?.status)}`,
  `provider=${shapeToken(data?.paymentProvider)}`,
  `order=${hasText(data?.orderId)}`,
  `url=${hasText(data?.url)}`,
  `checkout=${hasText(data?.checkoutId)}`,
 ].join(';').slice(0, SHAPE_MAX_CHARS);
}

export function withAssistedPaymentResponseShape<T extends Error>(error: T, status: number, data: unknown): T {
 return Object.assign(error, { responseShape: describeAssistedPaymentResponse(status, data) });
}

export function getAssistedPaymentResponseShape(error: unknown): string | undefined {
 const shape = (error as { responseShape?: unknown } | null)?.responseShape;
 return typeof shape === 'string' ? shape : undefined;
}
