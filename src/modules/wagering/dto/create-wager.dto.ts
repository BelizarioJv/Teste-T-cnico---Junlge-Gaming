import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

import { WagerOperation } from '../../../domain/wagering/wager.types.js';
import {
  AMOUNT_REGEX,
  CURRENCY_REGEX,
} from '../../wallet/dto/create-wallet.dto.js';

/**
 * Comando de aposta. O mesmo formato é aceito via HTTP e via SQS.
 */
export class CreateWagerDto {
  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(1, 100)
  playerId!: string;

  @IsEnum(WagerOperation)
  operation!: WagerOperation;

  /** Decimal em string, ex.: "80.00". LOSS deve enviar "0.00". */
  @IsString()
  @Matches(AMOUNT_REGEX, {
    message: 'amount deve ser decimal não negativo com até 2 casas',
  })
  amount!: string;

  @IsString()
  @Matches(CURRENCY_REGEX, { message: 'currency deve ser ISO 4217 (ex.: BRL)' })
  currency!: string;

  /** Identificador único da transação no provedor. */
  @IsString()
  @Length(1, 200)
  idempotencyKey!: string;

  /**
   * idempotencyKey da transação original. Obrigatório para WIN, LOSS,
   * REFUND e ROLLBACK; proibido para BET.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  referenceKey?: string;
}
