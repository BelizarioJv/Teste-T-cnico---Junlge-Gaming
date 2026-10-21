import { describe, expect, it } from 'vitest';
import { generatePayloadHash } from './payload-hash.js';

describe('generatePayloadHash', () => {
  it('gera um hash SHA-256 de 64 caracteres', () => {
    const hash = generatePayloadHash({
      playerId: 'player-123',
      amount: '10.00',
      currency: 'BRL',
    });

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('gera o mesmo hash para o mesmo payload', () => {
    const payload = {
      playerId: 'player-123',
      amount: '10.00',
      currency: 'BRL',
    };

    expect(generatePayloadHash(payload)).toBe(generatePayloadHash(payload));
  });

  it('gera hashes diferentes quando o payload muda', () => {
    const first = generatePayloadHash({
      playerId: 'player-123',
      amount: '10.00',
    });

    const second = generatePayloadHash({
      playerId: 'player-123',
      amount: '20.00',
    });

    expect(first).not.toBe(second);
  });

  it('ignora a ordem das chaves e campos undefined', () => {
    const first = generatePayloadHash({
      playerId: 'player-123',
      amount: '10.00',
      referenceKey: undefined,
    });

    const second = generatePayloadHash({
      amount: '10.00',
      playerId: 'player-123',
    });

    expect(first).toBe(second);
  });
});
