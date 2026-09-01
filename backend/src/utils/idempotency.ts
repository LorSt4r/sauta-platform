import crypto from 'node:crypto';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function lengthPrefix(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function computeIdempotencyDedupKey(
  route: string,
  actorUserId: string,
  rawKey: string
): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        'sauta:idempotency:v1',
        lengthPrefix(route),
        lengthPrefix(actorUserId),
        lengthPrefix(rawKey),
      ].join('\0')
    )
    .digest('hex');
}

export function computeRequestHash(payload: unknown): string {
  return crypto
    .createHash('sha256')
    .update(`sauta:request:v1\0${stableJson(payload ?? {})}`)
    .digest('hex');
}
