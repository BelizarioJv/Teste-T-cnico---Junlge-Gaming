import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Entrada externa: aceita somente valores não negativos.
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (!AMOUNT_PATTERN.test(amount)) {
      throw new MoneyError('Invalid monetary amount');
    }

    if (!CURRENCY_PATTERN.test(currency)) {
      throw new MoneyError('Invalid currency');
    }

    const value = new Decimal(amount);

    if (!value.isFinite() || value.isNegative()) {
      throw new MoneyError('Amount must be non-negative');
    }

    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new MoneyError('Invalid currency');
    }

    return new Money(new Decimal(0), currency);
  }

  /**
   * Uso interno: permite resultados negativos intermediários,
   * por exemplo em subtract() e negate().
   */
  private static fromDecimal(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        `Currency mismatch: ${this.currency} and ${other.currency}`,
      );
    }
  }
}
