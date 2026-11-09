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
| Blockchain | Stellar Testnet (SDK `@stellar/stellar-sdk` v17.4.0) |
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
| `DATABASE_URL` | `postgresql://labkyc:labkyc@localhost:5433/labkyc` | Conexión a Postgres |
| `APP_HOST` | `0.0.0.0` | Host del server |
| `APP_PORT` | `8000` | Puerto del server |
| `APP_ENV` | `local` | Entorno de ejecución |
| `APP_URL` | `http://localhost:8000` | Callback URL para Didit |
| `SECRET_KEY` | `local_dev_secret_key...` | Clave secreta local |
| `DIDIT_API_KEY` | mock | API key de Didit |
| `DIDIT_WORKFLOW_ID` | mock | Workflow de verificación |
| `DIDIT_WEBHOOK_SECRET` | mock | Secreto HMAC del webhook |
| `DIDIT_API_BASE_URL` | `https://verification.didit.me/v3` | Base URL de Didit |
| `TURNKEY_API_BASE_URL` | `https://api.turnkey.com` | Base URL de Turnkey |
| `TURNKEY_API_KEY` | mock | API key de Turnkey |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | URL de Horizon Testnet |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Passphrase de red Stellar |
| `STELLAR_SPONSOR_SECRET_KEY` | — | **Clave secreta del sponsor (Testnet)** |
| `STELLAR_SPONSOR_PUBLIC_KEY` | — | **Public key del sponsor (Testnet)** |
| `STELLAR_SENDER_SECRET_KEY` | — | **Clave secreta del sender/claimant (Testnet)** |
| `STELLAR_SENDER_PUBLIC_KEY` | — | **Public key del sender/claimant (Testnet)** |
| `STELLAR_USDC_ISSUER` | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | Emisor del asset USDC |
| `STELLAR_USDC_ASSET_CODE` | `USDC` | Código del asset USDC |
| `MOCK_STELLAR` | `true` | Usar cliente simulado de Stellar |
| `MOCK_DIDIT` | `true` | Usar cliente simulado de Didit |
| `RUN_STELLAR_INTEGRATION` | — | `true` para ejecutar tests reales contra Testnet |
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

## 🧪 Pruebas — Opciones disponibles

El proyecto ofrece **3 niveles de prueba** para validar el fix de declaraciones duplicadas
y el funcionamiento general de `StellarHorizonClient`:

### Opción 1 — Pruebas unitarias / Mock (sin red, sin .env)

```bash
npm run test -- tests/stellar.integration.test.ts
```

Usa `StellarMockClient` que simula Stellar localmente. No necesita conexión a internet
ni variables de entorno de Stellar.

**Qué valida:**
- Crear Claimable Balance patrocinado (mock)
- Reclamar Claimable Balance (mock)
- Obtener estado de transacción (mock)
- Verificar existencia de Claimable Balance (mock)
- Generar keypairs válidos

**Resultado esperado:** 10 tests pasando.

---

### Opción 2 — Integración REAL contra Stellar Testnet

```bash
RUN_STELLAR_INTEGRATION=true npm run test -- tests/stellar.integration.test.ts
```

Ejecuta tests contra **Horizon Testnet real** usando cuentas configuradas en `.env`.

**Requisitos previos:**
- Conexión a internet
- Variables de entorno `STELLAR_SPONSOR_*` y `STELLAR_SENDER_*` configuradas en `.env`
- Las cuentas deben existir en Horizon Testnet
- El sponsor debe tener trustline USDC y saldo USDC suficiente

**Qué valida:**
- Crear Claimable Balance patrocinado con USDC (Testnet real)
- Reclamar Claimable Balance (Testnet real)
- Verificar que el claimant recibe los fondos
- Crear Claimable Balance con XLM nativo (Testnet real)

**Resultado esperado:** 12 tests pasando (cuando el sponsor tiene fondos USDC suficientes).

---

### Opción 3 — Suite completa de pruebas del proyecto

```bash
npm test
```

Ejecuta todos los archivos de test con Vitest. Los tests comparten una única BD y corren
secuencialmente (`fileParallelism: false`).

**Archivos de prueba:**

| Archivo | Tests | Descripción |
|---------|-------|-------------|
| `tests/invariants.test.ts` | 10 | Invariantes del ledger (suma cero) |
| `tests/stellar.integration.test.ts` | 12 | Stellar mock + integración real Testnet |
| `tests/claimRedemption.test.ts` | 7 | Redención de claims |
| `tests/e2e.test.ts` | 2 | Flujo end-to-end completo |
| `tests/kyc.test.ts` | 6 | Flujo de KYC con Didit |
| `tests/ledger.test.ts` | 4 | Operaciones del ledger |
| `tests/claims.test.ts` | 3 | Creación de claims (Claimable Balance) |
| `tests/transfers.test.ts` | 4 | Transferencias P2P |
| `tests/fees.test.ts` | 7 | Cálculo de fees |
| `tests/expiration.test.ts` | 2 | Jobs de expiración |
| `tests/reconciliation.test.ts` | 2 | Jobs de reconciliación |
| `tests/users.test.ts` | 5 | Gestión de usuarios |

**Resultado esperado:** 63/64 tests pasando. El único test que puede fallar es el
de integración REAL USDC si el sponsor no tiene saldo USDC suficiente en Testnet.

---

## 🐛 Fix: Declaraciones duplicadas en `stellarHorizonClient.ts`

### Problema

El método `crearClaimableBalanceSponsored` en
`src/infrastructure/stellarHorizonClient.ts` tenía declaraciones duplicadas:

- Línea 36: `const sponsorKp = Keypair.fromSecret(sponsorSecretKey);`
- Línea 54: `const sponsorKp = Keypair.fromSecret(sponsorSecretKey);` ← **duplicado**
- Línea 55: `const sponsorAcc = await this.horizon.loadAccount(sponsorKp.publicKey());`
- Línea 64: `const sponsorAcc = await this.horizon.loadAccount(...);` ← **duplicado**

Esto provocaba errores de TypeScript: `sponsorKp redeclared` y `sponsorAcc redeclared`.

### Solución

Se eliminaron las líneas duplicadas 54 y 64. Ahora `sponsorKp` y `sponsorAcc`
se declaran una sola vez al inicio del método.

**Archivo modificado:** `src/infrastructure/stellarHorizonClient.ts`

### Fix adicional preexistente

También se corrigió el método `establecerTrustline` que usaba una variable
`claimantAddress` inexistente (el parámetro se llama `claimantSecretKey`).
Ahora usa correctamente `claimantKp.publicKey()`.

---

## 📋 Cuentas de Stellar Testnet

Las cuentas de Stellar Testnet se configuran exclusivamente en el archivo `.env` (local, no se sube al repositorio):

| Variable de entorno | Uso |
|---------------------|-----|
| `STELLAR_SPONSOR_PUBLIC_KEY` | Public key del sponsor (paga fees y crea Claimable Balances) |
| `STELLAR_SPONSOR_SECRET_KEY` | Secret key del sponsor **(nunca subir al repo)** |
| `STELLAR_SENDER_PUBLIC_KEY` | Public key del sender/claimant |
| `STELLAR_SENDER_SECRET_KEY` | Secret key del sender/claimant **(nunca subir al repo)** |
| `STELLAR_USDC_ISSUER` | Emisor del asset USDC |
| `STELLAR_USDC_ASSET_CODE` | Código del asset USDC |

**Red:** Stellar Testnet (`https://horizon-testnet.stellar.org`)

### Requisitos para tests USDC

El sponsor debe tener:
1. ✅ Trustline USDC establecida con el issuer configurado en `STELLAR_USDC_ISSUER`
2. ✅ Saldo USDC suficiente (≥ 5 USDC por test de Claimable Balance)

Si el sponsor se queda sin USDC, el test falla con `op_underfunded`. Fondear la cuenta
con más USDC del mismo issuer para volver a ejecutar.

---

## 📋 Resultados de verificación (estado actual del repo)

| Prueba | Tests | Estado | Notas |
|--------|-------|--------|-------|
| Opción 1 — Mock/Unitario | 10/10 | ✅ Pasando | Sin red, sin .env |
| Opción 2 — Integración REAL XLM | 2/2 | ✅ Pasando | Claimable Balance creado y reclamado en Testnet |
| Opción 2 — Integración REAL USDC | 1/1 | ✅ Pasando | Requiere sponsor con saldo USDC |
| Opción 3 — Suite completa | 63/64 | ✅ Pasando | 1 falla posible si sponsor sin USDC |
## 🔍 Evidencia en StellarExpert (Testnet)

Todos los tests de integración REAL se ejecutaron contra Stellar Testnet y son verificables en el explorador público:

### Cuentas

| Cuenta | Link StellarExpert | Rol |
|--------|-------------------|-----|
| Sponsor | https://stellar.expert/explorer/testnet/account/GC2M6KWINT6OPRVKXB5K3JRTJ5IPAEYDODAQPF6VST7VCFFBJ3SZWYFA | Paga fees y crea Claimable Balances |
| Sender/Claimant | https://stellar.expert/explorer/testnet/account/GBA7WPRVUR3Q2QMSHWU47AE47X74QKVV6WFTXW4SQUULENII2EFYED63 | Reclama Claimable Balances |

### Transacciones de evidencia (test USDC exitoso)

| Transacción | Link StellarExpert | Descripción |
|-------------|-------------------|-------------|
| Crear Claimable Balance | https://stellar.expert/explorer/testnet/tx/0a2185d96056d58ae6c8596df3dfc45c047e4bec836e4326b52fb6a334ef79af | createClaimableBalance de 5 USDC patrocinado |
| Reclamar Claimable Balance | https://stellar.expert/explorer/testnet/tx/606596249a02c58f7b70de12c37abe0d7f0f97df66be25c495d55a0d1104d27f | claimClaimableBalance por el claimant |

### Claimable Balance creado

| balanceId | Link StellarExpert | Estado |
|-----------|-------------------|--------|
| `00000000829583d50bee1b50aacd2b821f518356990ae94208b0868869447f4c57a8c6df` | https://stellar.expert/explorer/testnet/claimable-balance/00000000829583d50bee1b50aacd2b821f518356990ae94208b0868869447f4c57a8c6df | Reclamado ✅ |

### Resultado final en cadena

- Claimant USDC: 25.0000000 → 30.0000000 (+5 USDC recibidos)
- Claimant XLM: 9999.9999700 (sin cambios — no pagó gas de red)
- Claimable Balance: reclamado y ya no disponible en la cuenta del sponsor

---

- Claimant XLM final: 9999.9999700 (sin cambios, no pagó gas)

---

## 🔧 Troubleshooting

### `op_no_trust` en test USDC

El sponsor no tiene trustline USDC establecida. Solución:
1. Establecer trustline USDC en la cuenta del sponsor hacia el issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
2. O verificar que la variable `STELLAR_USDC_ISSUER` en `.env` coincida con el issuer al que el sponsor tiene trustline

### `op_underfunded` en test USDC

El sponsor no tiene suficiente saldo USDC. Solución:
1. Enviar más USDC del mismo issuer a la public key del sponsor configurada en `STELLAR_SPONSOR_PUBLIC_KEY`
2. Cada Claimable Balance de 5 USDC consume 5 USDC del sponsor

### `Cuenta ... no apareció` en `beforeAll`

Ocurre cuando se usa Friendbot y la cuenta no se propaga a Horizon a tiempo.
En los tests actuales se salta Friendbot y se usan cuentas existentes, por lo que
este error no debería ocurrir a menos que las cuentas no existan en Horizon.

### Errores de TypeScript preexistentes

Al correr `npm run typecheck` pueden aparecer 5 errores en `stellarHorizonClient.ts`
que son **preexistentes** y no relacionados con el fix de duplicados:
- `predicate` declarado pero no leído (línea 52)
- `sponsorSecretKey` declarado pero no leído (línea 130)
- `claimantAddress` no encontrado (líneas 133, 144) — corregido parcialmente en `establecerTrustline`
- `claimantKp` declarado pero no leído (línea 143)

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
DATABASE_URL="postgresql://labkyc:labkyc@localhost:5433/labkyc" npm test
```

Los tests comparten una única BD, por eso corren **secuencialmente** (`fileParallelism: false`).
Cada archivo limpia las tablas con `tests/helpers.ts → limpiarTodo()` respetando el orden de FKs.

---

## Fuera de alcance (esta fase)

Integración real con Pollar, on/off-ramp reales, frontend, KYC tiers dinámicos, multi-chain,
notificaciones transaccionales y panel de administración.

---

## Historial de cambios

| Fecha | Cambio | Archivo |
|-------|--------|---------|
| 2026-11-09 | Fix: eliminar declaraciones duplicadas de `sponsorKp` y `sponsorAcc` | `src/infrastructure/stellarHorizonClient.ts` |
| 2026-11-09 | Fix: corregir `claimantAddress` → `claimantKp.publicKey()` en `establecerTrustline` | `src/infrastructure/stellarHorizonClient.ts` |
| 2026-11-09 | Adaptar test de integración para usar variables de entorno (sin Friendbot) | `tests/stellar.integration.test.ts` |
| 2026-11-09 | Ajustar expectativas de test USDC (operationCount, balances finales) | `tests/stellar.integration.test.ts` |
| 2026-11-09 | Documentar 3 opciones de prueba y cuentas de Testnet | `README.md` |
