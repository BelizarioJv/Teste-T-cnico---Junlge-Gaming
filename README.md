# Wagering Processor

Carteira e ledger financeiro para transações de apostas (iGaming), com foco em
**consistência**: atomicidade, idempotência, concorrência segura, ledger
imutável e entrega confiável de mensagens.

- **Stack:** NestJS 12 · Bun · TypeScript strict · PostgreSQL 16 · MikroORM 7 · SQS (ElasticMQ local)
- **Operações:** `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (inclusive fora de ordem)
- **Entrada:** HTTP e fila SQS (com Inbox e DLQ) · **Saída:** eventos via Outbox
- **Operação:** health/live e health/ready, métricas Prometheus, logs JSON, reconciliação wallet × ledger

- **Passo a passo completo para rodar** (Windows e Linux/macOS, testes, filas,
  problemas comuns): [COMO-RODAR.md](./COMO-RODAR.md)
- **Decisões de projeto, garantias e limitações:** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Sumário

- [Requisitos](#requisitos)
- [Início rápido](#início-rápido)
- [Configuração](#configuração)
- [Comandos](#comandos)
- [API](#api)
- [Mensageria](#mensageria)
- [Observabilidade](#observabilidade)
- [Testes](#testes)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Solução de problemas](#solução-de-problemas)

## Requisitos

| Ferramenta | Versão |
| --- | --- |
| [Bun](https://bun.sh) | 1.4+ |
| Docker + Docker Compose | qualquer versão recente |
| Node.js (usado pelo Nest CLI) | 22+ |

## Início rápido

```bash
# 1. Dependências
bun install

# 2. Configuração (ajuste a senha se quiser)
cp .env.example .env

# 3. PostgreSQL (porta 5433) e ElasticMQ/SQS (porta 9324)
docker compose up -d

# 4. Schema
bun run migration:up

# 5. API em http://localhost:3000
bun run start:dev

# 6. (outro terminal) verificação ponta a ponta
bun run smoke
```

O `smoke` cria uma carteira e testa aposta, replay idempotente, saldo
insuficiente, concorrência, ledger, reconciliação e métricas contra a API em
execução.

## Configuração

Todas as variáveis são lidas de `.env` (veja `.env.example`). Valores
inválidos fazem a aplicação falhar na inicialização.

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost` / `5433` / `wagering_db` / `postgres` / — | PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:9324` | Endpoint SQS (ElasticMQ; LocalStack: `http://localhost:4566`; AWS real: vazio) |
| `SQS_WAGER_QUEUE_URL` | `…/wager-transactions.fifo` | Fila de entrada (comandos de aposta) |
| `SQS_WAGER_DLQ_URL` | `…/wager-transactions-dlq.fifo` | DLQ da fila de entrada |
| `SQS_EVENTS_QUEUE_URL` | `…/wallet-events.fifo` | Fila de saída (eventos do Outbox) |
| `SQS_CONSUMER_ENABLED` | `false` | Liga o consumidor da fila de entrada |
| `SQS_MAX_RECEIVE_COUNT` | `3` | Deve ser igual ao `maxReceiveCount` da redrive policy |
| `SQS_RETRY_BASE_MS` / `SQS_RETRY_MAX_MS` | `2000` / `300000` | Backoff de erros transitórios |
| `OUTBOX_PUBLISHER_ENABLED` | `false` | Liga o publicador do Outbox |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Intervalo de polling quando não há eventos |
| `OUTBOX_BATCH_SIZE` | `20` | Eventos reservados por lote |
| `OUTBOX_LEASE_MS` | `30000` | Lease de um lote reservado (recuperação após crash) |
| `OUTBOX_MAX_ATTEMPTS` | `10` | Tentativas antes de marcar o evento como `FAILED` |
| `RECONCILIATION_INTERVAL_MS` | `0` (desligado) | Intervalo do job de reconciliação |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `LOG_FORMAT` | `json` | `json` (produção) ou `pretty` (desenvolvimento) |
| `HEALTH_TIMEOUT_MS` | `2000` | Timeout de cada verificação do readiness |

> Os workers (consumidor SQS, publicador do Outbox e reconciliação) são
> ligados por variável de ambiente. Assim é possível ter réplicas só de API e
> réplicas de worker com o mesmo binário.

## Comandos

| Comando | O que faz |
| --- | --- |
| `bun run start:dev` | API em modo watch |
| `bun run build` / `bun run start:prod` | Build e execução de produção |
| `bun run migration:up` / `migration:down` | Aplica / reverte a última migration |
| `bun run migration:create` | Gera uma migration a partir das entidades |
| `bun run test` | Testes unitários (sem infraestrutura) |
| `bun run test:integration` | Testes de integração (PostgreSQL + SQS) |
| `bun run test:all` | Unitários + integração |
| `bun run typecheck` · `bun run lint` | Verificação de tipos e lint |
| `bun run smoke` | Teste ponta a ponta contra a API em execução (`BASE_URL`) |
| `bun run reconcile [walletId]` | Reconciliação wallet × ledger; exit code 1 se houver divergência |
| `bun run sqs <send\|send-file\|peek\|stats\|purge>` | Envia e inspeciona mensagens nas filas locais sem AWS CLI |
| `bun run db:check` | Testa a conexão com o PostgreSQL |

## API

Valores monetários são **strings decimais com até 2 casas** (`"80.00"`, `"80"`),
nunca `number`. Respostas usam `{ "amount": "80.00", "currency": "BRL" }`.

### Carteiras

```bash
# Criar (initialBalance opcional, gera um lançamento OPENING no ledger)
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","currency":"BRL","initialBalance":"100.00"}'

# Consultar
curl localhost:3000/wallets/<walletId>

# Ledger paginado (mais recente primeiro; use nextCursor como before)
curl 'localhost:3000/wallets/<walletId>/ledger?limit=20'
curl 'localhost:3000/wallets/<walletId>/ledger?limit=20&before=<nextCursor>'
```

| Status | Quando |
| --- | --- |
| `201` | Carteira criada |
| `400` | Payload inválido |
| `409` | Já existe carteira para o jogador nessa moeda (`walletId` no corpo) |

### Transações de aposta

```bash
curl -i -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' -d '{
  "walletId": "<walletId>",
  "playerId": "player-1",
  "operation": "BET",
  "amount": "80.00",
  "currency": "BRL",
  "idempotencyKey": "provider-tx-123"
}'

# Operações derivadas apontam para a original por referenceKey
#   WIN     amount = prêmio        referenceKey = BET
#   LOSS    amount = "0.00"        referenceKey = BET
#   REFUND  amount = valor do BET  referenceKey = BET (não liquidado)
#   ROLLBACK amount = valor do alvo referenceKey = BET (não liquidado) ou WIN

curl localhost:3000/wagering/transactions/<transactionId>
```

| Status | `status` no corpo | Quando |
| --- | --- | --- |
| `201` | `PROCESSED` | Saldo e ledger atualizados |
| `202` | `PENDING_REFERENCE` | A transação original ainda não chegou; será aplicada automaticamente quando chegar |
| `422` | `REJECTED` | Regra de negócio: `INSUFFICIENT_FUNDS`, `BET_ALREADY_SETTLED`, `AMOUNT_MISMATCH`… (`reason`) |
| `400` | — | Payload inválido |
| `404` | — | Carteira inexistente |
| `409` | — | `idempotencyKey` reutilizada com payload diferente |

**Idempotência:** repetir a mesma requisição devolve exatamente o mesmo status
e corpo, com o header `Idempotent-Replayed: true`, sem movimentar saldo.

### Operação

| Endpoint | Descrição |
| --- | --- |
| `GET /health/live` | Liveness (processo de pé) |
| `GET /health/ready` | Readiness: banco, schema, SQS, workers e shutdown; `503` com detalhes se algo falhar |
| `GET /metrics` | Métricas no formato Prometheus |
| `GET /wallets/:id/reconciliation` | Reconciliação de uma carteira |
| `POST /reconciliation/runs` | Executa a reconciliação de todas as carteiras |
| `GET /reconciliation/last` | Resultado da última execução |

> Os endpoints de operação não têm autenticação nesta versão — veja
> [ARCHITECTURE.md › Autenticação](./ARCHITECTURE.md#autenticação).

## Mensageria

As filas são criadas automaticamente pelo ElasticMQ a partir de
[`elasticmq.conf`](./elasticmq.conf):

| Fila | Papel |
| --- | --- |
| `wager-transactions.fifo` | Entrada: mesmo payload do `POST /wagering/transactions`. Use `MessageGroupId = walletId` |
| `wager-transactions-dlq.fifo` | DLQ: erros permanentes (enviados pela aplicação com `errorCode`) e mensagens que excederam `maxReceiveCount` (redrive nativo) |
| `wallet-events.fifo` | Saída: eventos do Outbox (`wallet.created`, `wager.transaction.processed`, `…rejected`, `…pending_reference`) |
| `wallet-events-dlq.fifo` | DLQ dos consumidores de eventos |

Enviar um comando pela fila (com o AWS CLI):

```bash
aws --endpoint-url http://localhost:9324 sqs send-message \
  --queue-url http://localhost:9324/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id provider-tx-456 \
  --message-body '{"walletId":"<walletId>","playerId":"player-1","operation":"BET","amount":"10.00","currency":"BRL","idempotencyKey":"provider-tx-456"}'
```

Para usar **LocalStack** em vez de ElasticMQ, crie as mesmas filas com a
redrive policy (`maxReceiveCount=3`) e aponte `SQS_ENDPOINT` e as URLs para
`http://localhost:4566`.

## Observabilidade

- **Logs:** uma linha JSON por evento (`time`, `level`, `context`, `msg`,
  `requestId` e campos de negócio como `walletId`, `transactionId`, `status`).
  O `X-Request-Id` recebido (ou gerado) é devolvido na resposta e aparece em
  todos os logs da requisição. Mensagens SQS usam `requestId = sqs:<MessageId>`.
  Use `LOG_FORMAT=pretty` no desenvolvimento.
- **Métricas** (`GET /metrics`):

| Métrica | Tipo | Uso |
| --- | --- | --- |
| `http_requests_total{method,route,status}` | counter | Tráfego e taxa de erro |
| `http_request_duration_seconds{method,route}` | histogram | Latência (p95/p99) |
| `wager_transactions_total{operation,status}` | counter | Volume e rejeições por tipo |
| `wager_idempotent_replays_total{operation}` | counter | Retentativas de clientes/provedores |
| `sqs_messages_total{result}` | counter | `processed`, `duplicate`, `dead-lettered`, `retry` |
| `outbox_publish_total{result}` | counter | `published`, `retried`, `failed` |
| `outbox_events{status}` · `outbox_oldest_pending_age_seconds` | gauge | Atraso da publicação |
| `inbox_failed_messages` · `wager_pending_reference_transactions` | gauge | Itens que exigem atenção |
| `reconciliation_inconsistent_wallets` · `reconciliation_last_run_timestamp_seconds` | gauge | **Alerta crítico se > 0** |

## Testes

```bash
bun run test               # unitários: Money, regras de domínio, métricas, logger, reconciliação
docker compose up -d && bun run migration:up
bun run test:integration   # integração
```

Os testes de integração usam o PostgreSQL real e cobrem:

- BET, saldo insuficiente, replay idempotente e chave reutilizada (`409`);
- **50 requisições idênticas em paralelo** → um único débito;
- **duas apostas de R$ 80 concorrendo por R$ 100** → uma aceita, uma rejeitada;
- WIN/LOSS/REFUND/ROLLBACK, `PENDING_REFERENCE` e resolução em cascata;
- imutabilidade do ledger e `CHECK` de saldo no banco;
- Inbox (redelivery, deduplicação), DLQ e erros transitórios;
- **múltiplos processos** (4 processos `bun` independentes) e **múltiplas
  instâncias** (consumidores e publicadores concorrentes);
- **reinício e recuperação do Outbox** (processo morto com `SIGKILL` no meio
  da publicação, ACK tardio, publicação após reinício);
- SQS real: consumo ponta a ponta, DLQ e redrive após `maxReceiveCount`;
- health, métricas, correlação de logs e reconciliação.

Os testes com SQS real e com múltiplos processos são pulados se o ElasticMQ ou
o `bun` não estiverem disponíveis — exceto com `REQUIRE_SQS=1` /
`REQUIRE_MULTIPROCESS=1`, que o CI usa para não pular nada.

O workflow [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) executa o
projeto **do zero** a cada push: instalação, lint, typecheck, testes
unitários, migrations (up → down → up), testes de integração, build, subida da
API, smoke test e reconciliação.

## Estrutura do projeto

```
src/
├── domain/                     # regras puras, sem framework
│   ├── money/                  # Money (decimal.js, 2 casas, moeda)
│   └── wagering/               # operações, status e decisões (WIN/LOSS/…)
├── modules/
│   ├── wallet/                 # POST/GET /wallets
│   ├── wagering/               # POST/GET /wagering/transactions (núcleo transacional)
│   ├── ledger/                 # único ponto que altera saldo + leitura paginada
│   ├── inbox/                  # consumidor SQS + deduplicação persistente
│   ├── outbox/                 # gravação transacional + publicador com retry
│   ├── reconciliation/         # wallet × ledger (núcleo SQL, endpoints, job)
│   └── health/                 # /health/live e /health/ready
├── observability/              # logger JSON, métricas, request-id
├── infrastructure/
│   ├── database/               # entidades, migrations, config do MikroORM
│   └── sqs/                    # cliente SQS
└── config/                     # configuração tipada
scripts/                        # smoke e reconcile
test/integration/               # testes de integração + fixtures de processos
```

## Solução de problemas

| Sintoma | Causa provável |
| --- | --- |
| `Schema desatualizado` nos testes / `/health/ready` com `schema: error` | Rode `bun run migration:up` |
| `ECONNREFUSED 127.0.0.1:5433` | `docker compose up -d` (o PostgreSQL do compose escuta na **5433**) |
| `/health/ready` com `sqs: error` | ElasticMQ fora do ar ou URLs de fila erradas no `.env` |
| `migration:create` gera mudanças já aplicadas | Snapshot desatualizado: apague `src/infrastructure/database/migrations/.snapshot-*.json` com o banco migrado |
| `ledger_entries is append-only` | Comportamento esperado: o ledger não aceita UPDATE/DELETE. Para resetar o ambiente local use `docker compose down -v` |
