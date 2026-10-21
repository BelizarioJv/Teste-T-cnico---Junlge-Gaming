# Como rodar o projeto

Guia passo a passo, do zero até a API respondendo, com testes, filas e
diagnóstico de problemas. Os comandos são mostrados para **Windows
(PowerShell)** e para **Linux / macOS / Git Bash** quando forem diferentes.

> Resumo para quem já tem tudo instalado:
>
> ```bash
> bun install
> cp .env.example .env            # Windows: Copy-Item .env.example .env
> docker compose up -d
> bun run migration:up
> bun run start:dev               # API em http://localhost:3000
> bun run smoke                   # em outro terminal
> ```

---

## Sumário

1. [O que vai rodar](#1-o-que-vai-rodar)
2. [Pré-requisitos](#2-pré-requisitos)
3. [Obter o código e instalar dependências](#3-obter-o-código-e-instalar-dependências)
4. [Configurar o `.env`](#4-configurar-o-env)
5. [Subir PostgreSQL e SQS (Docker)](#5-subir-postgresql-e-sqs-docker)
6. [Criar o schema do banco](#6-criar-o-schema-do-banco)
7. [Iniciar a API](#7-iniciar-a-api)
8. [Verificar se está tudo funcionando](#8-verificar-se-está-tudo-funcionando)
9. [Usar a API passo a passo](#9-usar-a-api-passo-a-passo)
10. [Usar as filas SQS](#10-usar-as-filas-sqs)
11. [Rodar os testes](#11-rodar-os-testes)
12. [Rodar várias instâncias e workers separados](#12-rodar-várias-instâncias-e-workers-separados)
13. [Reconciliação, métricas e logs](#13-reconciliação-métricas-e-logs)
14. [Parar, limpar e recomeçar](#14-parar-limpar-e-recomeçar)
15. [Problemas comuns](#15-problemas-comuns)

---

## 1. O que vai rodar

| Componente | Onde roda | Porta | Para quê |
| --- | --- | --- | --- |
| API NestJS | sua máquina (Bun/Node) | `3000` | HTTP, consumidor SQS, publicador do Outbox, reconciliação |
| PostgreSQL 16 | Docker (`wagering_postgres`) | `5433` → 5432 | Banco de dados |
| ElasticMQ | Docker (`wagering_elasticmq`) | `9324` | Implementação local da API do SQS (filas e DLQs) |

O PostgreSQL usa a porta **5433** (e não a 5432) para não conflitar com um
PostgreSQL que você já tenha instalado.

## 2. Pré-requisitos

| Ferramenta | Versão | Como verificar |
| --- | --- | --- |
| Bun | 1.4 ou superior | `bun --version` |
| Node.js | 22 ou superior (usado pelo Nest CLI no build/start) | `node --version` |
| Docker Desktop (ou Docker Engine) com Compose | recente | `docker compose version` |
| Git | qualquer | `git --version` |

### Instalação

**Windows (PowerShell):**

```powershell
# Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# Node.js 22 (via winget) — ou baixe em https://nodejs.org
winget install OpenJS.NodeJS.LTS

# Docker Desktop: https://www.docker.com/products/docker-desktop
# Na instalação, mantenha "Use WSL 2 based engine" marcado.
```

Feche e reabra o terminal depois de instalar, para o `PATH` ser atualizado.
Abra o Docker Desktop e espere o ícone indicar *Engine running* antes de
continuar.

**Linux / macOS:**

```bash
curl -fsSL https://bun.sh/install | bash
# Node 22: https://nodejs.org ou seu gerenciador (nvm, fnm, brew, apt)
# Docker: https://docs.docker.com/engine/install/
```

## 3. Obter o código e instalar dependências

Se recebeu o `.zip`, extraia e entre na pasta `wagering-processor`. Se for
pelo Git:

```bash
git clone <url-do-repositório>
cd wagering-processor
```

Instale as dependências (usa o `bun.lock`, então as versões são exatamente
as testadas):

```bash
bun install
```

## 4. Configurar o `.env`

Crie o seu `.env` a partir do exemplo:

```powershell
# Windows
Copy-Item .env.example .env
```

```bash
# Linux / macOS / Git Bash
cp .env.example .env
```

Abra o `.env` e troque `change-me` por uma senha de sua escolha. **As duas
senhas precisam ser iguais**: `POSTGRES_PASSWORD` é usada pelo Docker para
criar o banco e `DB_PASSWORD` é usada pela aplicação para conectar.

```dotenv
POSTGRES_PASSWORD=minha-senha
DB_PASSWORD=minha-senha
```

O restante já vem pronto para o ambiente local. As variáveis mais úteis:

| Variável | Valor no exemplo | Efeito |
| --- | --- | --- |
| `SQS_CONSUMER_ENABLED` | `true` | A API consome a fila `wager-transactions.fifo` |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | A API publica eventos em `wallet-events.fifo` |
| `RECONCILIATION_INTERVAL_MS` | `300000` | Reconciliação automática a cada 5 minutos (`0` desliga) |
| `LOG_FORMAT` | `json` | Use `pretty` para logs coloridos e legíveis no terminal |
| `LOG_LEVEL` | `info` | `debug` mostra também o acesso a `/health` e `/metrics` |

A lista completa está no [README](./README.md#configuração).

> O `.env` está no `.gitignore` e nunca deve ser commitado. Só o
> `.env.example` vai para o repositório.

## 5. Subir PostgreSQL e SQS (Docker)

```bash
docker compose up -d
```

Confira se os dois containers estão de pé (o PostgreSQL deve aparecer como
`healthy` após alguns segundos):

```bash
docker compose ps
```

Confira se as filas foram criadas pelo ElasticMQ:

```powershell
# Windows (use curl.exe, não o alias curl do PowerShell)
curl.exe "http://localhost:9324/?Action=ListQueues"
```

```bash
# Linux / macOS / Git Bash
curl "http://localhost:9324/?Action=ListQueues"
```

A resposta deve listar `wager-transactions.fifo`,
`wager-transactions-dlq.fifo`, `wallet-events.fifo` e `wallet-events-dlq.fifo`.
Elas são definidas em [`elasticmq.conf`](./elasticmq.conf), inclusive a
política de redrive (`maxReceiveCount = 3`).

## 6. Criar o schema do banco

```bash
bun run migration:up
```

Isso aplica as três migrations em ordem: tabelas base, transações de aposta
e a migration de consistência (CHECKs, ledger imutável, Inbox e Outbox).
Os scripts de migration configuram automaticamente a compatibilidade do CLI
do MikroORM com Bun; não é necessário definir `MIKRO_ORM_ALLOW_GLOBAL_CLI`
manualmente nem adicioná-la ao `.env`.

Para conferir:

```bash
bun run db:check
docker compose exec postgres psql -U postgres -d wagering_db -c "\dt"
```

Devem aparecer `wallets`, `ledger_entries`, `wager_transactions`,
`inbox_messages`, `outbox_events` e a tabela de controle das migrations.

## 7. Iniciar a API

**Desenvolvimento** (recompila a cada alteração):

```bash
bun run start:dev
```

**Produção** (build e execução do código compilado):

```bash
bun run build
bun run start:prod
```

Quando a API estiver pronta, o log mostra uma linha `app.started` com a porta
e os workers ligados:

```json
{"time":"…","level":"info","service":"wagering-processor","context":"Bootstrap","msg":"app.started","port":3000,"sqsConsumer":true,"outboxPublisher":true,"reconciliationIntervalMs":300000}
```

Para ver logs legíveis durante o desenvolvimento:

```powershell
# Windows (vale só para este terminal)
$env:LOG_FORMAT = "pretty"; bun run start:dev
```

```bash
# Linux / macOS / Git Bash
LOG_FORMAT=pretty bun run start:dev
```

## 8. Verificar se está tudo funcionando

**Health checks:**

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

O `ready` devolve `200` com `"status":"ok"` e o resultado de cada verificação
(`database`, `schema`, `sqs`, `sqsConsumer`, `outboxPublisher`, `shutdown`).
Se algo estiver errado ele devolve `503` e o campo `detail` explica o quê.

**Smoke test** (em outro terminal, com a API rodando):

```bash
bun run smoke
```

Ele cria uma carteira e verifica, contra a API de verdade: aposta, replay
idempotente, chave reutilizada (`409`), saldo insuficiente (`422`), duas
apostas concorrentes disputando o mesmo saldo, 50 requisições idênticas em
paralelo, ledger paginado, consulta de transação, reconciliação e métricas.
Cada verificação aparece com ✔ ou ✘ e o comando termina com código 1 se
alguma falhar. Para apontar para outro endereço: `BASE_URL=http://host:porta`.

## 9. Usar a API passo a passo

Valores monetários são sempre **strings** com até 2 casas decimais
(`"80.00"`), nunca números.

### 9.1 Com curl (Linux, macOS ou Git Bash no Windows)

```bash
API=http://localhost:3000

# Criar carteira com R$ 100,00
curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","currency":"BRL","initialBalance":"100.00"}'
# → copie o "id" da resposta
WALLET=<id-da-carteira>

# Apostar R$ 30,00 (201 PROCESSED)
curl -si -X POST $API/wagering/transactions -H 'content-type: application/json' -d "{
  \"walletId\":\"$WALLET\",\"playerId\":\"player-1\",\"operation\":\"BET\",
  \"amount\":\"30.00\",\"currency\":\"BRL\",\"idempotencyKey\":\"bet-001\"}"

# Repetir exatamente a mesma requisição: mesma resposta,
# header Idempotent-Replayed: true, saldo não muda.

# Prêmio de R$ 50,00 sobre a aposta bet-001
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' -d "{
  \"walletId\":\"$WALLET\",\"playerId\":\"player-1\",\"operation\":\"WIN\",
  \"amount\":\"50.00\",\"currency\":\"BRL\",\"idempotencyKey\":\"win-001\",\"referenceKey\":\"bet-001\"}"

# ROLLBACK chegando ANTES da aposta (202 PENDING_REFERENCE)
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' -d "{
  \"walletId\":\"$WALLET\",\"playerId\":\"player-1\",\"operation\":\"ROLLBACK\",
  \"amount\":\"10.00\",\"currency\":\"BRL\",\"idempotencyKey\":\"rb-002\",\"referenceKey\":\"bet-002\"}"

# A aposta chega depois: é processada e o ROLLBACK pendente é aplicado em seguida
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' -d "{
  \"walletId\":\"$WALLET\",\"playerId\":\"player-1\",\"operation\":\"BET\",
  \"amount\":\"10.00\",\"currency\":\"BRL\",\"idempotencyKey\":\"bet-002\"}"

# Consultas
curl -s $API/wallets/$WALLET
curl -s "$API/wallets/$WALLET/ledger?limit=10"
curl -s $API/wallets/$WALLET/reconciliation
```

### 9.2 Com PowerShell 7+ (Windows)

```powershell
$API = "http://localhost:3000"

function Api($Method, $Path, $Body) {
  $params = @{
    Method = $Method; Uri = "$API$Path"; ContentType = "application/json"
    SkipHttpErrorCheck = $true; StatusCodeVariable = "status"
  }
  if ($Body) { $params.Body = $Body | ConvertTo-Json -Compress }
  $response = Invoke-RestMethod @params
  Write-Host "HTTP $status" -ForegroundColor Cyan
  $response
}

$wallet = Api POST "/wallets" @{ playerId = "player-1"; currency = "BRL"; initialBalance = "100.00" }
$W = $wallet.id

Api POST "/wagering/transactions" @{
  walletId = $W; playerId = "player-1"; operation = "BET"
  amount = "30.00"; currency = "BRL"; idempotencyKey = "bet-001"
}

Api POST "/wagering/transactions" @{
  walletId = $W; playerId = "player-1"; operation = "WIN"
  amount = "50.00"; currency = "BRL"; idempotencyKey = "win-001"; referenceKey = "bet-001"
}

Api GET "/wallets/$W"
Api GET "/wallets/$W/ledger?limit=10"
Api GET "/wallets/$W/reconciliation"
```

> `SkipHttpErrorCheck` e `StatusCodeVariable` exigem o **PowerShell 7**
> (`pwsh`). No Windows PowerShell 5.1, use o Git Bash com os exemplos de curl
> ou instale o PowerShell 7: `winget install Microsoft.PowerShell`.

### 9.3 Respostas possíveis

| HTTP | `status` | Significado |
| --- | --- | --- |
| `201` | `PROCESSED` | Saldo e ledger atualizados |
| `202` | `PENDING_REFERENCE` | A transação original ainda não chegou; será aplicada quando chegar |
| `422` | `REJECTED` | Regra de negócio; motivo em `reason` (ex.: `INSUFFICIENT_FUNDS`) |
| `400` | — | Payload inválido |
| `404` | — | Carteira inexistente |
| `409` | — | `idempotencyKey` reutilizada com outro payload, ou carteira duplicada |

Regras de cada operação (WIN, LOSS, REFUND, ROLLBACK) estão no
[ARCHITECTURE.md](./ARCHITECTURE.md#operações-e-referências-fora-de-ordem).

## 10. Usar as filas SQS

Com `SQS_CONSUMER_ENABLED=true`, a API consome comandos da fila
`wager-transactions.fifo` no **mesmo formato** do `POST /wagering/transactions`.
O utilitário `bun run sqs` evita precisar do AWS CLI:

```bash
# Enviar um comando (Linux / macOS / Git Bash)
bun run sqs send '{"walletId":"<id>","playerId":"player-1","operation":"BET","amount":"5.00","currency":"BRL","idempotencyKey":"sqs-001"}'
```

No PowerShell, aspas dentro de JSON costumam ser removidas na passagem de
argumentos. Use um arquivo:

```powershell
@{ walletId = $W; playerId = "player-1"; operation = "BET"; amount = "5.00"; currency = "BRL"; idempotencyKey = "sqs-001" } |
  ConvertTo-Json | Set-Content comando.json
bun run sqs send-file comando.json
```

Outros comandos:

```bash
bun run sqs stats          # quantas mensagens há em cada fila
bun run sqs peek events    # eventos publicados pelo Outbox (sem remover)
bun run sqs peek dlq       # mensagens que foram para a DLQ, com errorCode/errorMessage
bun run sqs purge dlq      # esvazia a DLQ
```

Para ver a DLQ funcionando, envie um comando inválido
(`bun run sqs send '{"operation":"BET"}'`) e depois rode `bun run sqs peek dlq`.

**O que acontece com cada mensagem:**

| Situação | Resultado |
| --- | --- |
| Processada (inclusive rejeição de negócio, como saldo insuficiente) | Inbox `PROCESSED`, mensagem removida da fila |
| Mesma mensagem entregue de novo | Detectada pelo Inbox e removida, sem novo efeito |
| Erro permanente (JSON inválido, carteira inexistente…) | Enviada à DLQ com o motivo, Inbox `FAILED` |
| Erro transitório (banco fora do ar) | Volta para a fila com backoff; após 3 recebimentos o SQS a move para a DLQ |

**LocalStack em vez de ElasticMQ:** crie as quatro filas FIFO com a mesma
redrive policy e ajuste no `.env` o `SQS_ENDPOINT` e as três URLs para
`http://localhost:4566/000000000000/<fila>`.

## 11. Rodar os testes

### Unitários (não precisam de Docker)

```bash
bun run test
```

Cobrem `Money`, regras de WIN/LOSS/REFUND/ROLLBACK, hash de idempotência,
backoff, métricas, logger e avaliação da reconciliação.

### Integração (precisam do Docker e das migrations)

```bash
docker compose up -d
bun run migration:up
bun run test:integration
```

Cobrem, contra o PostgreSQL real: BET, saldo insuficiente, replay, 50
requisições idênticas em paralelo, duas apostas de R$ 80 por R$ 100,
operações derivadas e `PENDING_REFERENCE`, Inbox/Outbox/DLQ, 4 processos
`bun` independentes, várias instâncias da API, crash do publicador com
`SIGKILL`, SQS real com redrive, health, métricas e reconciliação. Levam
alguns minutos.

Testes que dependem do ElasticMQ ou de subir processos `bun` são **pulados**
(e não falham) se esses recursos não estiverem disponíveis. Para exigir que
rodem:

```powershell
# Windows
$env:REQUIRE_SQS = "1"; $env:REQUIRE_MULTIPROCESS = "1"; bun run test:integration
```

```bash
# Linux / macOS / Git Bash
REQUIRE_SQS=1 REQUIRE_MULTIPROCESS=1 bun run test:integration
```

Rodar um único arquivo:

```bash
bunx vitest run --config vitest.config.integration.ts test/integration/wagering.integration.spec.ts
```

### Tudo de uma vez

```bash
bun run test:all
bun run typecheck
bun run lint
```

### No GitHub

O workflow [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) roda a
cada push e pull request: instala, faz lint e typecheck, roda os unitários,
aplica e reverte as migrations, roda a integração com SQS real e múltiplos
processos (sem pular nada), faz o build, sobe a API e executa o smoke test e
a reconciliação. Acompanhe na aba **Actions** do repositório.

## 12. Rodar várias instâncias e workers separados

Os workers são ligados por variável de ambiente, então o mesmo código pode
rodar como "só API" ou "só worker". Exemplo com duas instâncias na mesma
máquina (cada uma em um terminal, depois de `bun run build`):

```powershell
# Windows — terminal 1: API sem workers
$env:PORT = "3000"; $env:SQS_CONSUMER_ENABLED = "false"; $env:OUTBOX_PUBLISHER_ENABLED = "false"
bun run start:prod

# Windows — terminal 2: worker (consumidor + publicador) na porta 3001
$env:PORT = "3001"; $env:SQS_CONSUMER_ENABLED = "true"; $env:OUTBOX_PUBLISHER_ENABLED = "true"
bun run start:prod
```

```bash
# Linux / macOS / Git Bash
PORT=3000 SQS_CONSUMER_ENABLED=false OUTBOX_PUBLISHER_ENABLED=false bun run start:prod
PORT=3001 SQS_CONSUMER_ENABLED=true  OUTBOX_PUBLISHER_ENABLED=true  bun run start:prod
```

Variáveis definidas no terminal têm prioridade sobre o `.env`. Pode haver
quantas instâncias quiser de cada tipo: a concorrência é resolvida no banco
(lock por carteira, `SKIP LOCKED` no Outbox, `UNIQUE` no Inbox).

Para parar uma instância use `Ctrl+C`: ela sai do readiness (`503`), termina
o lote em andamento e fecha as conexões.

## 13. Reconciliação, métricas e logs

```bash
# Reconciliação de todas as carteiras (código 1 se houver divergência)
bun run reconcile

# De uma carteira
bun run reconcile <walletId>

# Pela API
curl -X POST http://localhost:3000/reconciliation/runs
curl http://localhost:3000/reconciliation/last

# Métricas no formato Prometheus
curl http://localhost:3000/metrics
```

Cada linha de log é um JSON com `requestId`. Para seguir uma requisição,
envie `X-Request-Id: meu-id` no header e procure por ele nos logs; a
resposta também traz o header `X-Request-Id`. Mensagens SQS aparecem com
`requestId` igual a `sqs:<MessageId>`.

## 14. Parar, limpar e recomeçar

```bash
# Parar os containers mantendo os dados
docker compose stop

# Remover os containers mantendo os dados
docker compose down

# Apagar TUDO (inclusive o banco) e recomeçar do zero
docker compose down -v
docker compose up -d
bun run migration:up
```

O ledger é **imutável**: `UPDATE`, `DELETE` e `TRUNCATE` em `ledger_entries`
são bloqueados por trigger. Para limpar dados no ambiente local, use
`docker compose down -v`. A outra saída é reverter as migrations com
`bun run migration:down`, uma de cada vez, da mais recente para a mais antiga.

Se alterar entidades e o MikroORM se comportar de forma estranha, apague o
cache de metadados (pasta `temp/`). Ele é recriado sozinho.

## 15. Problemas comuns

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| `bun: command not found` / `bun não é reconhecido` | Terminal aberto antes da instalação | Feche e reabra o terminal |
| `docker compose` falha com erro de conexão | Docker Desktop fechado | Abra o Docker Desktop e espere *Engine running* |
| `port is already allocated` (5433, 9324 ou 3000) | Outro processo usando a porta | Pare o processo ou mude a porta em `docker-compose.yml` / `.env` (`DB_PORT`, `PORT`) |
| `password authentication failed for user "postgres"` | Senhas diferentes no `.env`, ou volume criado com senha antiga | Iguale `POSTGRES_PASSWORD` e `DB_PASSWORD`; se mudou a senha depois, `docker compose down -v` |
| `ECONNREFUSED 127.0.0.1:5433` | PostgreSQL não subiu | `docker compose ps` / `docker compose logs postgres` |
| `/health/ready` com `schema: error` ou "Schema desatualizado" nos testes | Migrations não aplicadas | `bun run migration:up` |
| `/health/ready` com `sqs: error` | ElasticMQ fora do ar ou URLs erradas | `docker compose logs elasticmq`; confira as URLs no `.env` |
| `QueueDoesNotExist` | `elasticmq.conf` não foi montado | Rode o `docker compose` a partir da pasta do projeto; no Windows, a pasta precisa estar acessível ao Docker Desktop (Settings → Resources → File sharing) |
| Testes de múltiplos processos sempre pulados | `bun` fora do `PATH` do processo de teste | Defina `BUN_BIN` com o caminho completo, ex.: `$env:BUN_BIN = "$HOME\.bun\bin\bun.exe"` |
| `ledger_entries is append-only` | Comportamento esperado | Veja a seção 14 |
| `migration:create` gera mudanças que já existem | Snapshot do MikroORM desatualizado | Com o banco migrado, apague `src/infrastructure/database/migrations/.snapshot-*.json` e gere de novo |
| `bun install --frozen-lockfile` falha | `package.json` mudou sem atualizar o lock | Rode `bun install` e commite o `bun.lock` |

Ainda com problemas? Rode a API com `LOG_LEVEL=debug LOG_FORMAT=pretty` e
consulte `GET /health/ready`: os campos `detail` dizem qual dependência está
falhando e por quê.
