import { IsOptional, IsString, Length, Matches } from 'class-validator';

export const AMOUNT_REGEX = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
export const CURRENCY_REGEX = /^[A-Z]{3}$/;

export class CreateWalletDto {
  @IsString()
  @Length(1, 100)
  playerId!: string;

  @IsString()
  @Matches(CURRENCY_REGEX, { message: 'currency deve ser ISO 4217 (ex.: BRL)' })
  currency!: string;

  /** Valor decimal em string, ex.: "100.00". Padrão: "0.00". */
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_REGEX, {
    message: 'initialBalance deve ser decimal não negativo com até 2 casas',
  })
  initialBalance?: string;
}
