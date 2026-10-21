import { describe, expect, it } from 'vitest';

import { Money } from '../money/money.js';
import {
  applyEffect,
  assertCommandShape,
  decideBet,
  decideDerived,
  type ReferenceTarget,
  WagerValidationError,
} from './wager-rules.js';
import { RejectionReason, WagerOperation, WagerStatus } from './wager.types.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const WALLET = 'wallet-1';

function target(overrides: Partial<ReferenceTarget> = {}): ReferenceTarget {
  return {
    operation: WagerOperation.BET,
    status: WagerStatus.PROCESSED,
    amount: brl('80.00'),
    walletId: WALLET,
    settled: false,
    reversed: false,
    ...overrides,
  };
}

describe('assertCommandShape', () => {
  it('aceita BET sem referência e com valor positivo', () => {
    expect(() =>
      assertCommandShape(WagerOperation.BET, brl('10.00'), null, 'k1'),
    ).not.toThrow();
  });

  it('rejeita BET com referenceKey', () => {
    expect(() =>
      assertCommandShape(WagerOperation.BET, brl('10.00'), 'k0', 'k1'),
    ).toThrow(WagerValidationError);
  });

  it('rejeita BET de valor zero', () => {
    expect(() =>
      assertCommandShape(WagerOperation.BET, brl('0'), null, 'k1'),
    ).toThrow(WagerValidationError);
  });

  it.each([WagerOperation.WIN, WagerOperation.REFUND, WagerOperation.ROLLBACK])(
    '%s exige referenceKey',
    (operation) => {
      expect(() => assertCommandShape(operation, brl('10.00'), null, 'k1')).toThrow(
        WagerValidationError,
      );
    },
  );

  it('LOSS exige amount 0.00', () => {
    expect(() =>
      assertCommandShape(WagerOperation.LOSS, brl('0.00'), 'bet', 'loss'),
    ).not.toThrow();
    expect(() =>
      assertCommandShape(WagerOperation.LOSS, brl('1.00'), 'bet', 'loss'),
    ).toThrow(WagerValidationError);
  });

  it('rejeita referência para si mesma', () => {
    expect(() =>
      assertCommandShape(WagerOperation.WIN, brl('1.00'), 'same', 'same'),
    ).toThrow(WagerValidationError);
  });
});

describe('decideBet', () => {
  it('debita o valor apostado', () => {
    const decision = decideBet(brl('80.00'));
    expect(decision).toEqual({
      outcome: 'APPLY',
      effect: { kind: 'DEBIT', amount: brl('80.00') },
    });
  });
});

describe('decideDerived', () => {
  it('aguarda (PENDING_REFERENCE) quando a original não existe', () => {
    expect(
      decideDerived(WagerOperation.ROLLBACK, brl('80.00'), WALLET, null),
    ).toEqual({ outcome: 'WAIT' });
  });

  it('aguarda quando a original também está pendente', () => {
    expect(
      decideDerived(
        WagerOperation.ROLLBACK,
        brl('80.00'),
        WALLET,
        target({ operation: WagerOperation.WIN, status: WagerStatus.PENDING_REFERENCE }),
      ),
    ).toEqual({ outcome: 'WAIT' });
  });

  it('rejeita referência de outra carteira', () => {
    expect(
      decideDerived(WagerOperation.WIN, brl('10.00'), 'other', target()),
    ).toEqual({ outcome: 'REJECT', reason: RejectionReason.REFERENCE_WALLET_MISMATCH });
  });

  it('rejeita quando a original foi rejeitada', () => {
    expect(
      decideDerived(
        WagerOperation.WIN,
        brl('10.00'),
        WALLET,
        target({ status: WagerStatus.REJECTED }),
      ),
    ).toEqual({ outcome: 'REJECT', reason: RejectionReason.REFERENCE_NOT_PROCESSED });
  });

  it('WIN credita o prêmio', () => {
    expect(decideDerived(WagerOperation.WIN, brl('150.00'), WALLET, target())).toEqual({
      outcome: 'APPLY',
      effect: { kind: 'CREDIT', amount: brl('150.00') },
    });
  });

  it('LOSS não movimenta saldo', () => {
    expect(decideDerived(WagerOperation.LOSS, brl('0'), WALLET, target())).toEqual({
      outcome: 'APPLY',
      effect: { kind: 'NONE' },
    });
  });

  it('não permite liquidar a mesma aposta duas vezes', () => {
    expect(
      decideDerived(WagerOperation.WIN, brl('10.00'), WALLET, target({ settled: true })),
    ).toEqual({ outcome: 'REJECT', reason: RejectionReason.BET_ALREADY_SETTLED });
  });

  it('REFUND exige o mesmo valor da aposta', () => {
    expect(decideDerived(WagerOperation.REFUND, brl('79.99'), WALLET, target())).toEqual({
      outcome: 'REJECT',
      reason: RejectionReason.AMOUNT_MISMATCH,
    });
    expect(decideDerived(WagerOperation.REFUND, brl('80.00'), WALLET, target())).toEqual({
      outcome: 'APPLY',
      effect: { kind: 'CREDIT', amount: brl('80.00') },
    });
  });

  it('REFUND não se aplica a aposta já liquidada', () => {
    expect(
      decideDerived(WagerOperation.REFUND, brl('80.00'), WALLET, target({ settled: true })),
    ).toEqual({ outcome: 'REJECT', reason: RejectionReason.BET_ALREADY_SETTLED });
  });

  it('ROLLBACK de BET credita; de WIN debita', () => {
    expect(decideDerived(WagerOperation.ROLLBACK, brl('80.00'), WALLET, target())).toEqual({
      outcome: 'APPLY',
      effect: { kind: 'CREDIT', amount: brl('80.00') },
    });
    expect(
      decideDerived(
        WagerOperation.ROLLBACK,
        brl('80.00'),
        WALLET,
        target({ operation: WagerOperation.WIN }),
      ),
    ).toEqual({ outcome: 'APPLY', effect: { kind: 'DEBIT', amount: brl('80.00') } });
  });

  it('não reverte duas vezes', () => {
    expect(
      decideDerived(WagerOperation.ROLLBACK, brl('80.00'), WALLET, target({ reversed: true })),
    ).toEqual({ outcome: 'REJECT', reason: RejectionReason.TRANSACTION_ALREADY_REVERSED });
  });

  it('WIN só pode referenciar BET', () => {
    expect(
      decideDerived(
        WagerOperation.WIN,
        brl('1.00'),
        WALLET,
        target({ operation: WagerOperation.REFUND }),
      ),
    ).toEqual({ outcome: 'REJECT', reason: RejectionReason.INVALID_REFERENCE_OPERATION });
  });
});

describe('applyEffect', () => {
  it('debita quando há saldo suficiente (inclusive saldo exato)', () => {
    const result = applyEffect(brl('80.00'), { kind: 'DEBIT', amount: brl('80.00') });
    expect(result.ok && result.balance.toString()).toBe('0.00');
  });

  it('nunca deixa o saldo negativo', () => {
    expect(applyEffect(brl('20.00'), { kind: 'DEBIT', amount: brl('80.00') })).toEqual({
      ok: false,
      reason: RejectionReason.INSUFFICIENT_FUNDS,
    });
  });

  it('credita sem perda de precisão', () => {
    const result = applyEffect(brl('0.10'), { kind: 'CREDIT', amount: brl('0.20') });
    expect(result.ok && result.balance.toString()).toBe('0.30');
  });
});
