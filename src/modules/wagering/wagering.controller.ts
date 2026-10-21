import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { validated } from '../../common/validation.js';
import { CreateWagerDto } from './dto/create-wager.dto.js';
import {
  httpStatusFor,
  type WagerTransactionView,
} from './wagering.presenter.js';
import { WageringService } from './wagering.service.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(WageringService) private readonly wagering: WageringService,
  ) {}

  /**
   * 201 PROCESSED | 202 PENDING_REFERENCE | 422 REJECTED (ex.: saldo
   * insuficiente). Replays devolvem o mesmo status e corpo, com o header
   * `Idempotent-Replayed: true`. Mesma chave com outro payload → 409.
   */
  @Post()
  async create(
    @Body(validated(CreateWagerDto)) dto: CreateWagerDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerTransactionView> {
    const outcome = await this.wagering.process(dto);

    res.status(httpStatusFor(outcome.status));
    res.setHeader('Idempotent-Replayed', String(outcome.replayed));

    return outcome.view;
  }

  @Get(':id')
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<WagerTransactionView> {
    return this.wagering.getTransaction(id);
  }
}
