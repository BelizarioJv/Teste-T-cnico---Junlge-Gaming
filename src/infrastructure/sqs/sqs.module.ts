import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SQSClient =>
        new SQSClient({
          region: config.sqs.region,
          endpoint: config.sqs.endpoint,
          credentials: {
            accessKeyId: config.sqs.accessKeyId,
            secretAccessKey: config.sqs.secretAccessKey,
          },
        }),
    },
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
