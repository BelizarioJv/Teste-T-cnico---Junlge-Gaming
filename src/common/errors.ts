import { HttpException } from '@nestjs/common';

/**
 * Erro permanente = reprocessar não muda o resultado (payload inválido,
 * carteira inexistente, chave reutilizada com outro payload...). Vai direto
 * para a DLQ em vez de consumir tentativas.
 *
 * Qualquer outro erro (banco indisponível, deadlock, timeout) é transitório.
 */
export function isPermanentError(error: unknown): boolean {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  return error instanceof SyntaxError;
}

export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof HttpException) {
    const response = error.getResponse();

    if (typeof response === 'object' && response !== null) {
      const body = response as Record<string, unknown>;
      const message = Array.isArray(body.message)
        ? body.message.join('; ')
        : String(body.message ?? error.message);

      return { code: String(body.code ?? error.name), message };
    }

    return { code: error.name, message: String(response) };
  }

  if (error instanceof Error) {
    return { code: error.name, message: error.message };
  }

  return { code: 'UnknownError', message: String(error) };
}
