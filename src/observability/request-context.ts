import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

/**
 * Contexto por requisição propagado por toda a cadeia assíncrona (handlers,
 * serviços, queries). O logger lê daqui o `requestId` para correlacionar
 * todas as linhas de uma mesma requisição/mensagem.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}
