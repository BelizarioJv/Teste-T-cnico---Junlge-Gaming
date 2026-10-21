import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Serialização canônica: chaves ordenadas recursivamente e campos
 * `undefined` descartados. Assim, o mesmo payload gera o mesmo hash
 * independentemente da ordem das propriedades no JSON recebido.
 */
export function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (typeof value === 'object') {
    const result: { [key: string]: Json } = {};

    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];

      if (item !== undefined) {
        result[key] = canonicalize(item);
      }
    }

    return result;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  throw new TypeError(`Unsupported value in payload: ${String(value)}`);
}

export function generatePayloadHash(payload: Record<string, unknown>): string {
  const canonicalPayload = JSON.stringify(canonicalize(payload));

  return createHash('sha256').update(canonicalPayload).digest('hex');
}
