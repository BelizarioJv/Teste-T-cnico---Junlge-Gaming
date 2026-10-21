import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import { validated } from '../../common/validation.js';
import { LedgerQueryDto } from '../ledger/dto/ledger-query.dto.js';
import { LedgerService, type LedgerPage } from '../ledger/ledger.service.js';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import type { WalletView } from './wallet.presenter.js';
import { WalletService } from './wallet.service.js';

@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(WalletService) private readonly wallets: WalletService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(validated(CreateWalletDto)) dto: CreateWalletDto,
  ): Promise<WalletView> {
    return this.wallets.createWallet(dto);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<WalletView> {
    return this.wallets.getWallet(id);
  }

  @Get(':id/ledger')
  ledgerPage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(validated(LedgerQueryDto)) query: LedgerQueryDto,
  ): Promise<LedgerPage> {
    return this.ledger.listByWallet(id, query);
  }
}
