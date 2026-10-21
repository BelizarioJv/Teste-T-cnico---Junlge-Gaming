import { Controller, Get, Header, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';

import { HealthService, type ReadinessReport } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: 200 enquanto o processo responder. */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return this.health.live();
  }

  /** Readiness: 200 pronto | 503 com o detalhe de cada verificação. */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.ready();
    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
