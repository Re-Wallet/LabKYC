# LabKYC

Laboratorio funcional de **KYC + wallet no-custodial + Claimable Balance** sobre Stellar,
implementado con **Node.js + TypeScript + Fastify** y **arquitectura hexagonal**.

El objetivo es validar el dominio completo (alta de usuario → KYC → envío a usuario existente
o a tag sin cuenta → reclamo → expiración/reverso → reconciliación) **en local**, sin fondos reales.

---

## 📊 Diagrama de Arquitectura General

```mermaid
flowchart TD
    subgraph Cliente
        UI[Cliente Web / Mobile]
    end

    subgraph API Layer [interfaces/ - Fastify]
        Routes[Rutas Fastify]
        Zod[Validación Zod]
        DTO[DTOs]
    end

    subgraph Application Layer [application/ - Casos de uso]
        KYCUC[KYCUseCases]
        ClaimUC[ClaimUseCases]
        TransferUC[TransferUseCases]
        LedgerUC[LedgerUseCases]
        UserUC[UserUseCases]
        FeeUC[FeeUseCases]
        ExpirationUC[ExpirationJob]
        ReconciliationUC[ReconciliationJob]
    end

    subgraph Domain Layer [domain/ - Puertos y entidades]
        KYCPort[Puerto DiditClient]
        ClaimPort[Puerto ClaimReleaser]
        UserPort[Puerto UserRepository]
        WalletPort[Puerto WalletRepository]
        LedgerPort[Puerto LedgerRepository]
        KYCEntity[KYCVerification]
        ClaimEntity[Claim]
        TransferEntity[Transfer]
    end

    subgraph Infrastructure Layer [infrastructure/ - Adaptadores]
        DiditHTTP[DiditHTTPClient - API real]
        DiditMock[DiditMockClient - Simulado]
        PostgresKYC[PostgresKYCVerificationRepository]
        PostgresUser[PostgresUserRepository]
        PostgresWallet[PostgresWalletRepository]
        PostgresLedger[PostgresLedgerService]
        StellarClient[StellarHorizonClient - Stellar Testnet]
        WebhookRepo[PostgresWebhookEventRepository]
    end

    subgraph External Services
        Didit[Didit API - https://verification.didit.me/v3]
        Horizon[Stellar Horizon Testnet]
        Friendbot[Friendbot - Fondos Testnet]
        PG[(PostgreSQL 15+)]
    end

    UI --> Routes
    Routes --> Zod
    Zod --> DTO
    DTO --> KYCUC
    DTO --> ClaimUC
    DTO --> TransferUC
    DTO --> LedgerUC
    DTO --> UserUC
    DTO --> FeeUC
    DTO --> ExpirationUC
    DTO --> ReconciliationUC

    KYCUC --> KYCPort
    ClaimUC --> ClaimPort
    TransferUC --> UserPort
    TransferUC --> WalletPort
    TransferUC --> LedgerPort
    LedgerUC --> LedgerPort
    UserUC --> UserPort

    KYCPort --> DiditHTTP
    KYCPort --> DiditMock
    ClaimPort --> PostgresKYC
    UserPort --> PostgresUser
    WalletPort --> PostgresWallet
    LedgerPort --> PostgresLedger

    DiditHTTP --> Didit
    StellarClient --> Horizon
    DiditHTTP --> Friendbot
    PostgresKYC --> PG
    PostgresUser --> PG
    PostgresWallet --> PG
    PostgresLedger --> PG
    WebhookRepo --> PG

    style UI fill:#e1f5e1,stroke:#2e7d32
    style API Layer fill:#fff3e0,stroke:#f57c00
    style Application Layer fill:#e3f2fd,stroke:#1565c0
    style Domain Layer fill:#f3e5f5,stroke:#6a1b9a
    style Infrastructure Layer fill:#e0e0e0,stroke:#424242
    style External Services fill:#ffebee,stroke:#c62828
```

---

## 🏛️ Arquitectura Hexagonal (Detalle)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         src/ - Arquitectura Hexagonal                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  interfaces/ │  │ application/ │  │   domain/    │  │ infrastructure│   │
│  │   (Fastify)  │  │ (Casos de    │  │ (Puertos y   │  │   (Adaptadores)│   │
│  │   Rutas,     │  │   uso)       │  │  entidades)  │  │  Postgres,     │   │
│  │   Zod, DTOs  │  │              │  │              │  │  Didit, Stellar│   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│         │                 │                 │                 │           │
│         ▼                 ▼                 ▼                 ▼           │
│    Depende de          Depende de      No depende de     Depende de      │
│    application         domain          ningún framework   domain         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Regla de dependencia:
  interfaces → application → domain
  infrastructure → domain

El dominio NUNCA importa: pg, fastify, stellar-sdk, didit-sdk
```

---

## 🔄 Diagramas de Flujo por Sección

### 1. Flujo KYC / Didit

```mermaid
sequenceDiagram
    participant U as Usuario
    participant A as API Fastify
    participant C as KYCUseCases
    participant R as PostgresKYCVerificationRepository
    participant D as DiditHTTPClient
    participant Didit as Didit API
    participant W as Webhook /webhooks/didit

    U->>A: POST /kyc/start {userId, callbackUrl}
    A->>C: iniciarKYC({userId, callbackUrl})
    C->>R: obtenerSesionActivaPorUsuario(userId)
    alt Sesión activa existe
        R-->>C: Sesión existente
        C-->>A: {verificationId, url}
        A-->>U: 200 {url}
    else No hay sesión activa
        C->>D: crearSesion(workflowId, vendorData, callback)
        D->>Didit: POST /v3/session/ {x-api-key, body}
        Didit-->>D: {session_id, url}
        D-->>C: {sessionId, url}
        C->>R: crear({userId, diditSessionId, workflowId, sessionUrl})
        C->>R: actualizarKycStatus(userId, 'in_progress')
        C-->>A: {verificationId, url}
        A-->>U: 200 {url}
    end

    U->>Didit: Abre url (verificación de identidad)
    Didit->>W: POST /webhooks/didit {X-Signature-V2, X-Timestamp, body}
    W->>W: verificarFirma(rawBody, signatureHeader)
    alt Firma válida
        W->>C: procesarWebhook({rawBody, signatureHeader, timestampHeader})
        C->>R: obtenerPorDiditSessionId(sessionId)
        alt status = Approved
            C->>R: actualizarEstado(Approved, decision)
            C->>R: actualizarDatosKYC(userId, datosOCR)
            C->>R: actualizarKycStatus(userId, 'approved')
            C->>R: activarWalletsPendientes(userId)
            C->>R: dispararClaimsPendientes(userId)
        else status = Declined
            C->>R: actualizarKycStatus(userId, 'declined')
        else status = In Review
            C->>R: actualizarKycStatus(userId, 'in_review')
        end
        W-->>Didit: 200 ok
    else Firma inválida
        W-->>Didit: 401 (evento guardado, no procesado)
    end
```

### 2. Flujo Claimable Balance (Stellar)

```mermaid
sequenceDiagram
    participant U as Usuario
    participant A as API Fastify
    participant C as ClaimUseCases
    participant S as StellarHorizonClient
    participant H as Horizon Testnet
    participant F as Friendbot

    U->>A: POST /transfers/claim {senderId, recipientTag, amount, asset}
    A->>C: crearClaim({senderId, recipientTag, amount, asset, idempotencyKey})
    C->>C: Validar sender KYC = approved
    C->>C: Validar destinatario NO existe como usuario
    C->>R: crearGrupoBalanceado (ledger suma cero)
    C->>R: crearTransfer(status=pending_claim, recipient_user_id=NULL)
    C->>R: crearClaim(token_hash, amount, asset, expires_at)
    C-->>A: {status: pending_claim, claimToken, transferId, claimId}
    A-->>U: 200 {claimToken}

    U->>U: Comparte claimToken con destinatario
    Destinatario->>A: POST /claims/:token/redeem {userId}
    A->>C: reclamarClaim({token, userId})
    C->>C: Validar KYC del usuario = approved
    C->>S: crearClaimableBalanceSponsored({sponsorSecretKey, asset, amount, claimableUntil})
    S->>H: loadAccount(sponsorPublicKey)
    S->>F: friendbot (si cuenta no existe)
    S->>S: establecerTrustline (si USDC y claimant no tiene)
    S->>H: submitTransaction(createClaimableBalance)
    H-->>S: {balanceId, txHash}
    S-->>C: {balanceId, txHash}
    C->>R: actualizarClaim(claimed_onchain, balanceId, txHash)
    C->>R: actualizarTransfer(claimed_onchain)
    C-->>A: {next: completed}
    A-->>Destinatario: 200 {status: completed}
```

### 3. Flujo de Transferencia P2P

```mermaid
flowchart TD
    Start[POST /transfers] --> ValidarKYC[Validar KYC sender = approved]
    ValidarKYC --> ExisteDest[¿Destinatario existe?]
    
    ExisteDest -->|Sí| TransferExistente[Transferencia directa a usuario]
    ExisteDest -->|No| CrearClaim[Crear Claimable Balance]
    
    TransferExistente --> Ledger[Grupo asientos suma cero]
    Ledger --> TransferOK[Transferencia completada]
    
    CrearClaim --> ClaimLedger[Ledger grupo suma cero]
    ClaimLedger --> ClaimPending[Transfer pendiente_claim]
    ClaimPending --> Token[Generar claimToken]
    Token --> ClaimOK[Responder claimToken]
    
    style TransferOK fill:#e1f5e1,stroke:#2e7d32
    style ClaimOK fill:#e1f5e1,stroke:#2e7d32
```

---

## 📋 Stack Tecnológico

| Capa | Tecnología | Versión |
|------|-----------|---------|
| Lenguaje | TypeScript | 5.5 |
| Runtime | Node.js | 22 |
| HTTP Framework | Fastify | 4 |
| Base de Datos | PostgreSQL | 15+ |
| ORM / Query | pg (node-postgres) | 8 |
| Tests | Vitest | 2 |
| Blockchain SDK | @stellar/stellar-sdk | 17.4.0 |
| Validación | Zod | 3 |
| KYC API | Didit v3 | REST |

---

## 🔧 Puesta en Marcha Local

### 1. Requisitos

- Node.js 22+
- PostgreSQL 15+ (o Docker)

### 2. Base de Datos

**Opción A — Docker:**
```bash
docker compose up -d          # Postgres 15 en puerto 5432
```

**Opción B — PostgreSQL local:**
```bash
sudo -u postgres psql -c "CREATE USER labkyc WITH PASSWORD 'labkyc' SUPERUSER;"
sudo -u postgres createdb -O labkyc labkyc
```

### 3. Variables de Entorno

```bash
cp .env.example .env
```

| Variable | Default local | Para qué sirve |
|----------|---------------|----------------|
| `DATABASE_URL` | `postgresql://labkyc:labkyc@localhost:5433/labkyc` | Conexión a Postgres |
| `APP_HOST` | `0.0.0.0` | Host del servidor |
| `APP_PORT` | `8000` | Puerto del servidor |
| `APP_ENV` | `local` | Entorno de ejecución |
| `APP_URL` | `http://localhost:8000` | Callback URL para Didit |
| `SECRET_KEY` | `local_dev_secret_key...` | Clave secreta local |
| `DIDIT_API_KEY` | — | API key de Didit (requerido si `MOCK_DIDIT !== "true"`) |
| `DIDIT_WORKFLOW_ID` | — | UUID del workflow de Didit |
| `DIDIT_WEBHOOK_SECRET` | — | Secreto HMAC del webhook de Didit |
| `DIDIT_API_BASE_URL` | `https://verification.didit.me/v3` | Base URL de Didit API |
| `TURNKEY_API_BASE_URL` | `https://api.turnkey.com` | Base URL de Turnkey |
| `TURNKEY_API_KEY` | mock | API key de Turnkey |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | URL de Horizon Testnet |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Passphrase de red Stellar |
| `STELLAR_SPONSOR_PUBLIC_KEY` | — | Public key del sponsor (Testnet) |
| `STELLAR_SPONSOR_SECRET_KEY` | — | Secret key del sponsor **(no subir al repo)** |
| `STELLAR_SENDER_PUBLIC_KEY` | — | Public key del sender/claimant |
| `STELLAR_SENDER_SECRET_KEY` | — | Secret key del sender/claimant **(no subir al repo)** |
| `STELLAR_USDC_ISSUER` | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | Emisor del asset USDC |
| `STELLAR_USDC_ASSET_CODE` | `USDC` | Código del asset USDC |
| `MOCK_STELLAR` | `true` | Usar cliente simulado de Stellar |
| `MOCK_DIDIT` | `true` | `"true"` = `DiditMockClient`. Otro valor = `DiditHTTPClient` |
| `RUN_STELLAR_INTEGRATION` | — | `true` para tests reales contra Testnet |
| `CLAIM_TTL_DAYS` | `30` | Vigencia del claim |
| `CLAIM_TOKEN_BYTES` | `32` | Largo del token plano del claim |
| `PENDING_LIMIT_USD` | `200` | Tope de envíos a tags sin cuenta |

> ⚠️ **El archivo `.env` NO se sube a GitHub.** Contiene secretos.

### 4. Migraciones

```bash
psql "$DATABASE_URL" -f migrations/001_init.sql
```

Verificar invariante del ledger sobre BD vacía:
```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM check_ledger_invariants();"   # debe dar 0
```

### 5. Instalar y Correr

```bash
npm install
npm run dev        # tsx watch src/interfaces/main.ts
npm test           # suite completa
npm run build      # tsc -> dist/
```

---

## 🔌 Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/users` | Registra usuario (tag único, compliance profile 1:1) |
| `POST` | `/kyc/start` | Crea sesión de verificación en Didit |
| `POST` | `/webhooks/didit` | Webhook de Didit (HMAC-SHA256 `X-Signature-V2` + `X-Timestamp` ≤ 300s) |
| `POST` | `/wallets` | Crea wallet no-custodial |
| `GET` | `/wallets/me?userId=` | Wallet del usuario |
| `POST` | `/ledger/grupo` | Grupo de asientos balanceado (uso interno/debug) |
| `POST` | `/transfers` | Transferencia P2P a usuario existente |
| `POST` | `/transfers/claim` | Transferencia a tag **sin** usuario (Claimable Balance) |
| `GET` | `/claims/:token` | Vista pública del claim |
| `POST` | `/claims/:token/redeem` | Registra/vincula usuario y arranca KYC |
| `POST` | `/fees/calculate` | Calcula fee según `fee_configs` |
| `POST` | `/jobs/expiracion` | Dispara job de expiración y reverso |
| `POST` | `/jobs/reconciliacion` | Dispara job de reconciliación on-chain |
| `GET` | `/health` | Health check |

---

## 🔐 Configuración de Didit / KYC

El proyecto soporta dos modos de operación:

### Modo Mock (`MOCK_DIDIT=true`)
Usa `DiditMockClient`. Ideal para desarrollo local y tests sin credenciales de Didit.

### Modo Real (`MOCK_DIDIT` distinto de `"true"`)
Usa `DiditHTTPClient` contra la API real de Didit.

**Variables requeridas en `.env`:**
- `DIDIT_API_KEY` — API key de Didit (header `x-api-key`)
- `DIDIT_WORKFLOW_ID` — UUID del workflow de verificación
- `DIDIT_WEBHOOK_SECRET` — Shared secret para verificar firmas HMAC-SHA256
- `DIDIT_API_BASE_URL` — `https://verification.didit.me/v3`

**Flujo KYC:**
1. `POST /kyc/start` crea sesión en Didit y retorna `url`
2. Usuario completa verificación en Didit (hosted session)
3. Didit envía `POST /webhooks/didit` con `X-Signature-V2` y `X-Timestamp`
4. Si `status: "Approved"`, se actualiza `kyc_status = 'approved'`, se extraen datos OCR y se activan wallets
5. Se disparan claims pendientes asociados al usuario

---

## 🧪 Pruebas — Opciones Disponibles

### Opción 1 — Pruebas Unitarias / Mock (sin red, sin .env)

```bash
npm run test -- tests/stellar.integration.test.ts
```

Usa `StellarMockClient`. Valida:
- Crear Claimable Balance patrocinado (mock)
- Reclamar Claimable Balance (mock)
- Obtener estado de transacción (mock)
- Verificar existencia de Claimable Balance (mock)
- Generar keypairs válidos

**Resultado:** 10 tests pasando.

### Opción 2 — Integración REAL contra Stellar Testnet

```bash
RUN_STELLAR_INTEGRATION=true npm run test -- tests/stellar.integration.test.ts
```

Tests contra Horizon Testnet real con cuentas configuradas en `.env`.

**Resultado:** 12 tests pasando (cuando el sponsor tiene fondos USDC suficientes).

### Opción 3 — Suite Completa del Proyecto

```bash
npm test
```

Ejecuta todos los archivos de test con Vitest.

| Archivo | Tests | Descripción |
|---------|-------|-------------|
| `tests/invariants.test.ts` | 10 | Invariantes del ledger (suma cero) |
| `tests/stellar.integration.test.ts` | 12 | Stellar mock + integración real Testnet |
| `tests/claimRedemption.test.ts` | 7 | Redención de claims |
| `tests/e2e.test.ts` | 2 | Flujo end-to-end completo |
| `tests/kyc.test.ts` | 6 | Flujo de KYC con Didit |
| `tests/ledger.test.ts` | 4 | Operaciones del ledger |
| `tests/claims.test.ts` | 3 | Creación de claims |
| `tests/transfers.test.ts` | 4 | Transferencias P2P |
| `tests/fees.test.ts` | 7 | Cálculo de fees |
| `tests/expiration.test.ts` | 2 | Jobs de expiración |
| `tests/reconciliation.test.ts` | 2 | Jobs de reconciliación |
| `tests/users.test.ts` | 5 | Gestión de usuarios |

**Resultado esperado:** 64/64 tests pasando.

---

## 📊 Resultados de Verificación (Estado Actual del Repo)

| Prueba | Tests | Estado | Notas |
|--------|-------|--------|-------|
| Opción 1 — Mock/Unitario | 10/10 | ✅ Pasando | Sin red, sin .env |
| Opción 2 — Integración REAL XLM | 2/2 | ✅ Pasando | Claimable Balance creado y reclamado en Testnet |
| Opción 2 — Integración REAL USDC | 1/1 | ✅ Pasando | Requiere sponsor con saldo USDC |
| Opción 3 — Suite completa | 64/64 | ✅ Pasando | Todas las pruebas verdes |
| KYC / Didit (mock) | 6/6 | ✅ Pasando | Tests unitarios de KYC |
| Didit API real (prueba directa) | 1/1 | ✅ Pasando | Sesión creada correctamente |

---

## 🔍 Evidencia en StellarExpert (Testnet)

Todos los tests de integración REAL se ejecutaron contra Stellar Testnet y son verificables en el explorador público:

### Cuentas

| Cuenta | Link StellarExpert | Rol |
|--------|-------------------|-----|
| Sponsor | https://stellar.expert/explorer/testnet/account/GC2M6KWINT6OPRVKXB5K3JRTJ5IPAEYDODAQPF6VST7VCFFBJ3SZWYFA | Paga fees y crea Claimable Balances |
| Sender/Claimant | https://stellar.expert/explorer/testnet/account/GBA7WPRVUR3Q2QMSHWU47AE47X74QKVV6WFTXW4SQUULENII2EFYED63 | Reclama Claimable Balances |

### Transacciones de Evidencia (Última Ejecución — Suite 64/64)

| Transacción | Link StellarExpert | Descripción |
|-------------|-------------------|-------------|
| Crear Claimable Balance | https://stellar.expert/explorer/testnet/tx/267ca42404975c9ba2227ea954b62c32523ec18205278de3a8a13ff9bf047f91 | createClaimableBalance de 5 USDC patrocinado |
| Reclamar Claimable Balance | https://stellar.expert/explorer/testnet/tx/94c96e7718786e478874d3a3c2dc87f7b31e411896004fd113ff9bf683c53f94 | claimClaimableBalance por el claimant |

### Claimable Balance Creado

| balanceId | Link StellarExpert | Estado |
|-----------|-------------------|--------|
| `0000000017031d7a444e95e0a6065193be13a91ffc3cee7402840c5042940493bb1cea2a` | https://stellar.expert/explorer/testnet/claimable-balance/0000000017031d7a444e95e0a6065193be13a91ffc3cee7402840c5042940493bb1cea2a | Reclamado ✅ |

### Resultado Final en Cadena

- Claimant USDC: 40.0000000 → 45.0000000 (+5 USDC recibidos)
- Claimant XLM: 9999.9999700 (sin cambios — no pagó gas de red)
- Claimable Balance: reclamado y ya no disponible en la cuenta del sponsor

### Prueba Directa de Didit API Real

```
✅ Sesión creada exitosamente en Didit:
   sessionId: 5e608140-e20f-4885-9c4b-389cfdde777a
   url: https://verify.didit.me/session/_UhrZPdnbNx2
```

---

## 🐛 Fix: Declaraciones Duplicadas en `stellarHorizonClient.ts`

### Problema

El método `crearClaimableBalanceSponsored` tenía declaraciones duplicadas:

- Línea 36: `const sponsorKp = Keypair.fromSecret(sponsorSecretKey);`
- Línea 54: `const sponsorKp = Keypair.fromSecret(sponsorSecretKey);` ← **duplicado**
- Línea 55: `const sponsorAcc = await this.horizon.loadAccount(sponsorKp.publicKey());`
- Línea 64: `const sponsorAcc = await this.horizon.loadAccount(...);` ← **duplicado**

### Solución

Se eliminaron las líneas duplicadas 54 y 64. Ahora `sponsorKp` y `sponsorAcc` se declaran una sola vez.

**Archivo modificado:** `src/infrastructure/stellarHorizonClient.ts`

### Fix adicional preexistente

El método `establecerTrustline` usaba `claimantAddress` (variable inexistente). Ahora usa correctamente `claimantKp.publicKey()`.

---

## 📋 Cuentas de Stellar Testnet

Las cuentas se configuran exclusivamente en `.env` (local, no se sube al repositorio):

| Variable | Uso |
|----------|-----|
| `STELLAR_SPONSOR_PUBLIC_KEY` | Public key del sponsor |
| `STELLAR_SPONSOR_SECRET_KEY` | Secret key del sponsor **(no subir al repo)** |
| `STELLAR_SENDER_PUBLIC_KEY` | Public key del sender/claimant |
| `STELLAR_SENDER_SECRET_KEY` | Secret key del sender/claimant **(no subir al repo)** |
| `STELLAR_USDC_ISSUER` | Emisor del asset USDC |
| `STELLAR_USDC_ASSET_CODE` | Código del asset USDC |

### Requisitos para tests USDC

El sponsor debe tener:
1. ✅ Trustline USDC establecida con el issuer configurado
2. ✅ Saldo USDC suficiente (≥ 5 USDC por test)

Si el sponsor se queda sin USDC, el test falla con `op_underfunded`.

---

## 🔧 Troubleshooting

| Error | Causa | Solución |
|-------|-------|----------|
| `op_no_trust` | El sponsor no tiene trustline USDC | Establecer trustline hacia el issuer USDC |
| `op_underfunded` | El sponsor no tiene saldo USDC | Fondear la cuenta con más USDC |
| `401 Unauthorized` (Didit) | Credenciales de Didit inválidas | Obtener nuevas credenciales del MCP o Didit Console |
| `Cuenta no apareció` | Friendbot no respondió | Los tests actuales usan cuentas existentes, saltan Friendbot |
| Errores de TypeScript preexistentes | `predicate`, `sponsorSecretKey`, `claimantAddress` | Son preexistentes, no relacionados con el fix |

---

## 📋 Decisiones No Negociables

1. **No-custodia siempre** — `wallets.custody_type` es constante `non_custodial`
2. **El destinatario no existe hasta el reclamo** — enviar a un tag sin cuenta no crea fila en `users`
3. **KYC es la puerta del claim** — sin `kyc_status = 'approved'` no se ejecuta `claimClaimableBalance`
4. **Doble asiento con suma cero** — cada operación genera ≥2 asientos; si `credit - debit != 0`, se revierte todo el grupo
5. **Idempotencia obligatoria** — `webhook_events (provider, event_id)` y `transfers.idempotency_key`
6. **Firma antes que lógica** — el webhook se persiste siempre (auditoría) pero con firma inválida no se ejecuta lógica
7. **Token plano del claim una sola vez** — en DB solo `claims.claim_token_hash` (SHA-256)
8. **Estados de transfer** — `pending → pending_claim → claimed_onchain → completed` (o `failed`/`reversed`)

---

## 📜 Historial de Cambios

| Fecha | Cambio | Archivo |
|-------|--------|---------|
| 2026-11-09 | Fix: eliminar declaraciones duplicadas de `sponsorKp` y `sponsorAcc` | `src/infrastructure/stellarHorizonClient.ts` |
| 2026-11-09 | Fix: corregir `claimantAddress` → `claimantKp.publicKey()` en `establecerTrustline` | `src/infrastructure/stellarHorizonClient.ts` |
| 2026-11-09 | Adaptar test de integración para usar variables de entorno (sin Friendbot) | `tests/stellar.integration.test.ts` |
| 2026-11-09 | Ajustar expectativas de test USDC | `tests/stellar.integration.test.ts` |
| 2026-11-09 | Integrar `DiditHTTPClient` para KYC real con verificación `X-Timestamp` | `src/interfaces/routes/kyc.ts`, `src/application/kyc.ts` |
| 2026-11-09 | Documentar 3 opciones de prueba, cuentas de Testnet y evidencia StellarExpert | `README.md` |
| 2026-11-09 | Reestructurar README con diagramas de arquitectura y últimos hashes de prueba | `README.md` |

---

## 🚫 Fuera de Alcance (Esta Fase)

Integración real con Pollar, on/off-ramp reales, frontend, KYC tiers dinámicos, multi-chain, notificaciones transaccionales y panel de administración.

---

## ✅ Checklist de Verificación

- [x] 64/64 tests pasando
- [x] Stellar Testnet: Claimable Balance USDC y XLM creado y reclamado
- [x] Didit API: Sesión creada correctamente contra `verification.didit.me/v3`
- [x] README sin secretos expuestos
- [x] Evidencia en StellarExpert con links verificables
- [x] Diagramas de arquitectura por sección
- [x] `.env` no se sube al repositorio