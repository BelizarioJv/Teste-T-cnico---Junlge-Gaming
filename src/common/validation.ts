import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

type DtoClass<T> = new () => T;

/**
 * ValidationPipe com o tipo informado explicitamente (`expectedType`).
 * Não depende de `emitDecoratorMetadata`, então valida da mesma forma no
 * build do Nest (tsc), no Bun e no Vitest.
 */
export function validated<T>(type: DtoClass<T>): ValidationPipe {
  return new ValidationPipe({
    expectedType: type,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

/** Mesma validação, para payloads que não chegam via HTTP (ex.: SQS). */
export async function validatePlain<T extends object>(
  type: DtoClass<T>,
  plain: unknown,
): Promise<T> {
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
    throw new BadRequestException('Payload deve ser um objeto JSON.');
  }

  const instance = plainToInstance(type, plain);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (errors.length > 0) {
    throw new BadRequestException(formatErrors(errors));
  }

  return instance;
}

function formatErrors(errors: ValidationError[]): string[] {
  return errors.flatMap((error) =>
    Object.values(error.constraints ?? {}).concat(
      formatErrors(error.children ?? []),
    ),
  );
}
