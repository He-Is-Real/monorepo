/**
 * A service start-up whose database refuses the sign-in, run as its own process by
 * `failed-to-start.spec.ts`: the services' main.ts bootstrap (`START_UP_OPTIONS`,
 * `failedToStart`) and the real `startConnecting`, with a client whose server refuses the
 * sign-in with a `ServerError` carrying the text given as the first argument.
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServerError, type Surreal } from 'surrealdb';
import type { SecretsService } from '@heisreal/secrets';
import { SURREAL } from '../database.constants';
import {
  failedToStart,
  START_UP_OPTIONS,
  startConnecting,
} from '../database.module';

const serverText = process.argv[2] ?? '';

/** Answers every connect with the server's refusal, as the SDK does for a wrong password. */
function refusingClient(): Surreal {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    status: 'disconnected',
    subscribe(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    async connect() {
      const refusal = new ServerError({
        kind: 'NotAllowed',
        message: `There was a problem with authentication: ${serverText}`,
        details: { kind: 'Auth' },
      });
      for (const listener of listeners.get('error') ?? []) listener(refusal);
      throw new Error(`Authentication failed: ${serverText}`, {
        cause: refusal,
      });
    },
    async close() {
      return true;
    },
  } as unknown as Surreal;
}

const secrets = { get: async () => serverText } as unknown as SecretsService;

class RefusedModule {}
Module({
  providers: [
    {
      provide: SURREAL,
      useFactory: () =>
        startConnecting(
          refusingClient(),
          {
            url: 'ws://database.invalid:8000',
            namespace: 'heisreal',
            database: 'app',
            username: 'api_public_read',
            passwordSecret: 'unused',
          },
          secrets,
        ),
    },
  ],
})(RefusedModule);

async function bootstrap() {
  const app = await NestFactory.create(RefusedModule, START_UP_OPTIONS).catch(
    failedToStart,
  );
  app.flushLogs();
  await app.listen(0, '127.0.0.1');
  await app.close();
}

bootstrap();
