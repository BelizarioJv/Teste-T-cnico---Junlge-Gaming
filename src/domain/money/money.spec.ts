import { describe, expect, test } from 'vitest';
import { Money, MoneyError } from './money.js';

describe('Money', () => {
  test('soma valores monetários corretamente', () => {
    const a = Money.from({
      amount: '10.10',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '20.20',
      currency: 'BRL',
    });

    expect(a.add(b).toString()).toBe('30.30');
  });

  test('subtrai valores monetários corretamente', () => {
    const a = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '80.00',
      currency: 'BRL',
    });

    expect(a.subtract(b).toString()).toBe('20.00');
  });

  test('rejeita valores com mais de duas casas decimais', () => {
    expect(() =>
      Money.from({
        amount: '10.999',
        currency: 'BRL',
      }),
    ).toThrow(MoneyError);
  });

  test('rejeita valores negativos na entrada', () => {
    expect(() =>
      Money.from({
        amount: '-10.00',
        currency: 'BRL',
      }),
    ).toThrow(MoneyError);
  });

  test('rejeita operações entre moedas diferentes', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => brl.add(usd)).toThrow(MoneyError);
  });

  test('mantém valores negativos em operações internas', () => {
    const a = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '20.00',
      currency: 'BRL',
    });

    expect(a.subtract(b).toString()).toBe('-10.00');
    expect(a.subtract(b).isNegative()).toBe(true);
  });

  test('serializa com duas casas decimais', () => {
    const money = Money.from({
      amount: '25',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });
});
