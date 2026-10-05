import { DynamicModule, Module } from '@nestjs/common';
import { SERVICE_NAME } from './health.constants';
import { HealthController } from './health.controller';

/** Adds `GET /health`. Requires `DatabaseModule` to be imported by the application. */
@Module({})
export class HealthModule {
  static forService(service: string): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: SERVICE_NAME, useValue: service }],
    };
  }
}
