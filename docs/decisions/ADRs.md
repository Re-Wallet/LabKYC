# ADR 001 — Non-custodial wallet siempre

**Estado**: Aceptado

**Contexto**: El lab implementa una wallet de pagos consumer. La custodia de las claves privadas es el riesgo central.

**Decisión**: `wallets.custody_type` es una constante `non_custodial` (CHECK constraint en DB). Ningún secreto (private key, seed, mnemonic) se persiste en la base de datos. El firmante es un servicio externo (Turnkey, Pollar, etc.) referenciado solo por `turnkey_sub_org_id` / `pollar_wallet_id`, que son IDs, no claves.

**Consecuencias**:
- La tabla `wallets` nunca tendrá columnas `private_key`, `secret`, `seed`, `mnemonic`, etc.
- La pérdida del signer externo implica pérdida de acceso a los fondos (trade-off aceptado).
- Auditoría simplificada: no hay secretos que rotar en la DB.

---

# ADR 002 — El destinatario no existe hasta el reclamo

**Estado**: Aceptado

**Contexto**: Al enviar a un tag sin usuario registrado, no se debe crear una "cuenta fantasma".

**Decisión**: `POST /transfers/claim` **nunca** inserta en `users`. El destinatario solo se crea cuando hace clic en el link del claim y llama a `POST /claims/:token/redeem`.

**Consecuencias**:
- `transfers.recipient_user_id` es `NULL` mientras el claim está en `pending_claim`.
- El índice único `claims.claim_token_hash` y la derivación determinística de la address desde el tag garantizan que el mismo tag siempre mapee a la misma address.
- Simplifica GDPR: no hay datos personales hasta que la persona interactúa.

---

# ADR 003 — KYC es la puerta del claim (KYC gate)

**Estado**: Aceptado

**Contexto**: El Claimable Balance en Stellar permite que cualquiera con la address lo reclame. Debemos evitar que un tercero lo intercepte.

**Decisión**: Sin `users.kyc_status = 'approved'` no se ejecuta `claimClaimableBalance` ni se mueve saldo en el ledger. El webhook `Approved` dispara `dispararClaimsPendientes(userId)` que libera los claims vinculados.

**Consecuencias**:
- Un claim con KYC `declined` o `in_review` permanece en `pending` indefinidamente (o hasta expirar).
- El flujo de reclamación (`redimirClaim`) si el usuario no tiene KYC aprobado, devuelve `{ next: "kyc", url }` y NO libera el claim.
- Test canónico: `test_kyc_gate_claim` + E2E.

---

# ADR 004 — Doble asiento con suma cero (ledger invariante)

**Estado**: Aceptado

**Contexto**: El ledger interno es la única fuente de verdad de saldos. Un bug de contabilidad contamina todo el sistema.

**Decisión**: Cada operación genera ≥2 asientos en `ledger_entries` con el mismo `transaction_group_id`. La suma `credit - debit` por `(transaction_group_id, asset)` debe ser exactamente 0. Si no, se revierte la transacción completa (rollback atómico).

**Implementación**:
- `PostgresLedgerService.crearGrupoBalanceado()` valida el balanceo **antes** de insertar y verifica el invariante **después** dentro de la misma transacción.
- `pg_advisory_xact_lock` por `(account_type, user_id, wallet_id, asset)` serializa el cálculo de `balance_after`.
- Función SQL `check_ledger_invariants()` usada en CI y monitoreo.

**Consecuencias**:
- Cualquier operación descuadrada falla rápido y limpio.
- Los 10 tests CI-bloqueantes (`tests/invariants.test.ts`) cubren este invariante.