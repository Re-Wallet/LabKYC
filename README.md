# LabKYC

Laboratorio funcional de **KYC + wallet no-custodial + Claimable Balance** sobre Stellar,
implementado con **Node.js + TypeScript + Fastify** y **arquitectura hexagonal**.

El objetivo es validar el dominio completo (alta de usuario → KYC → envío a usuario existente
o a tag sin cuenta → reclamo → expiración/reverso → reconciliación) **en local**, sin fondos reales.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Lenguaje | TypeScript 5.5 (Node 22) |
| HTTP | Fastify 4 |
| BD | PostgreSQL 15+ (`pgcrypto`, `citext`) |
| Tests | Vitest 2 |
| Blockchain | Stellar Testnet (SDK real pendiente; cliente simulado por ahora) |
| KYC | Didit v3 (cliente HTTP real pendiente; cliente simulado por ahora) |

---

## Arquitectura hexagonal

```
src/
├── domain/          # Entidades, value objects, excepciones y PUERTOS (interfaces).
│                    # Sin dependencias de frameworks ni de infraestructura.
├── application/     # Casos de uso: orquestan puertos. Sin SQL, sin HTTP.
├── infrastructure/  # ADAPTADORES: Postgres, Didit, Stellar, repositorios, jobs.
└── interfaces/      # Rutas FastAPI: schemas (zod), status codes, DTOs.
```

Regla de dependencia: `interfaces → application → domain`, y `infrastructure → domain`.
El dominio nunca importa `pg`, `fastify` ni `stellar-sdk`.

---

## Puesta en marcha local

### 1. Requisitos

- Node.js 22+
- PostgreSQL 15+ (o Docker)

### 2. Base de datos

Opción A — Docker:

```bash
docker compose up -d          # Postgres 15 en puerto 5432
```

Opción B — PostgreSQL local:

```bash
# Crear rol y base
sudo -u postgres psql -c "CREATE USER labkyc WITH PASSWORD 'labkyc' SUPERUSER;"
sudo -u postgres createdb -O labkyc labkyc
```

### 3. Variables de entorno

```bash
cp .env.example .env
# Ajustar DATABASE_URL según el puerto que uses
```

| Variable | Default local | Para qué sirve |
|----------|---------------|----------------|
| `DATABASE_URL` | `postgresql://labkyc:labkyc@localhost:5432/labkyc` | Conexión a Postgres |
| `APP_PORT` | `8000` | Puerto del server |
| `APP_URL` | `http://localhost:8000` | Callback URL para Didit |
| `DIDIT_API_KEY` | mock | API key de Didit |
| `DIDIT_WORKFLOW_ID` | mock | Workflow de verificación |
| `DIDIT_WEBHOOK_SECRET` | mock | Secreto HMAC del webhook |
| `STELLAR_SPONSOR_PUBLIC_KEY` | mock | Cuenta sponsor (fee-bump) |
| `STELLAR_USDC_ISSUER` | mock | Emisor del asset USDC |
| `CLAIM_TTL_DAYS` | `30` | Vigencia del claim (usar `0` para probar expiración) |
| `CLAIM_TOKEN_BYTES` | `32` | Largo del token plano del claim |
| `PENDING_LIMIT_USD` | `200` | Tope de envíos a tags sin cuenta |

### 4. Migraciones

```bash
psql "$DATABASE_URL" -f migrations/001_init.sql
```

Verificar el invariante del ledger sobre BD vacía:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM check_ledger_invariants();"   # debe dar 0
```

### 5. Instalar y correr

```bash
npm install
npm run dev        # tsx watch src/interfaces/main.ts
npm test           # suite completa
npm run build      # tsc -> dist/
```

---

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/users` | Registra usuario (tag único, compliance profile 1:1) |
| `POST` | `/kyc/start` | Crea sesión de verificación en Didit |
| `POST` | `/webhooks/didit` | Webhook de Didit (HMAC-SHA256 `X-Signature-V2`) |
| `POST` | `/wallets` | Crea wallet no-custodial |
| `GET` | `/wallets/me?userId=` | Wallet del usuario |
| `POST` | `/ledger/grupo` | Grupo de asientos balanceado (uso interno/debug) |
| `POST` | `/transfers` | Transferencia P2P a usuario existente |
| `POST` | `/transfers/claim` | Transferencia a tag **sin** usuario (Claimable Balance) |
| `GET` | `/claims/:token` | Vista pública del claim (monto, remitente, estado) |
| `POST` | `/claims/:token/redeem` | Registra/vincula usuario y arranca el KYC |
| `POST` | `/fees/calculate` | Calcula fee según `fee_configs` |
| `POST` | `/jobs/expiracion` | Dispara el job de expiración y reverso |
| `POST` | `/jobs/reconciliacion` | Dispara el job de reconciliación on-chain |
| `GET` | `/health` | Health check |

---

## Decisiones no negociables

1. **No-custodia siempre** — `wallets.custody_type` es constante `non_custodial` (CHECK en DB).
   Ningún secret se persiste; sólo IDs de referencia (`turnkey_sub_org_id`).
2. **El destinatario no existe hasta el reclamo** — enviar a un tag sin cuenta **no** crea fila en `users`.
3. **KYC es la puerta del claim** — sin `users.kyc_status = 'approved'` no se ejecuta
   `claimClaimableBalance` ni se mueve saldo en el ledger.
4. **Doble asiento con suma cero** — cada operación genera ≥2 asientos con el mismo
   `transaction_group_id`; si `credit - debit != 0` por asset, se revierte todo el grupo.
5. **Idempotencia obligatoria** — `webhook_events (provider, event_id)` y `transfers.idempotency_key`.
6. **Firma antes que lógica** — el webhook se persiste siempre (auditoría) pero con firma inválida
   **no** se ejecuta lógica de negocio.
7. **Token plano del claim una sola vez** — en DB sólo `claims.claim_token_hash` (SHA-256).
8. **Estados de transfer** — `pending → pending_claim → claimed_onchain → completed` (o `failed`/`reversed`).

Ver `docs/decisions/` para los ADRs.

---

## Simular un webhook de Didit

El webhook valida **HMAC-SHA256 sobre el body crudo** con el header `X-Signature-V2`.

```bash
BODY='{"event_id":"evt_1","event_type":"status.updated","session_id":"didit_x","status":"Approved","decision":{"id_verifications":[{"full_name":"Ana Perez"}]}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$DIDIT_WEBHOOK_SECRET" -hex | sed 's/^.* //')"

curl -X POST http://localhost:8000/webhooks/didit \
  -H 'Content-Type: application/json' \
  -H "X-Signature-V2: $SIG" \
  -d "$BODY"
```

Firma inválida → el evento queda guardado con `signature_valid = false` y **no** se procesa.

---

## Tests

```bash
DATABASE_URL="postgresql://labkyc:labkyc@localhost:5432/labkyc" npm test
```

Los tests comparten una única BD, por eso corren **secuencialmente** (`fileParallelism: false`).
Cada archivo limpia las tablas con `tests/helpers.ts → limpiarTodo()` respetando el orden de FKs.

---

## Fuera de alcance (esta fase)

Integración real con Pollar, on/off-ramp reales, frontend, KYC tiers dinámicos, multi-chain,
notificaciones transaccionales y panel de administración.
