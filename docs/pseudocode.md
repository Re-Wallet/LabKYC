# Pseudocódigo completo — LabKYC (Módulos 0–11)

Fuente: brief original del lab. Es agnóstico al lenguaje, para transcribir a TypeScript/Node.

---

## Módulo 0: Constantes y configuración

```
CONSTANTES:
    MAX_TAG_CHANGES = 2
    TAG_REGEX = /^[a-z0-9._]{3,20}$/
    TAG_RESERVED = ['admin','support','wallet','pay','didit','pollar','stellar','oficial','system']
    CLAIM_TTL_DAYS = 30
    CLAIM_TOKEN_BYTES = 32
    PENDING_LIMIT_USD = 200
    KYC_TIER_LIMITS = {
        light:     { monthly_usd: 1000,  requires: ['document','liveness','face_match'] },
        full:      { monthly_usd: 10000, requires: [...] },
        enhanced:  { monthly_usd: None,  requires: [... + source_of_funds] }
    }

CONFIG:
    DIDIT_API_KEY
    DIDIT_WORKFLOW_ID
    DIDIT_WEBHOOK_SECRET
    STELLAR_SPONSOR_KEYPAIR
    STELLAR_USDC_ISSUER
    STELLAR_HORIZON_URL
    POLLAR_API_KEY
    DB_POOL
```

---

## Módulo 1: Registro de usuario y tag

```
FUNCIÓN registrar_usuario(email, phone, tag_deseado):
    AFIRMAR(tag_deseado MATCHEA TAG_REGEX, "formato inválido")
    AFIRMAR(tag_deseado NOT IN TAG_RESERVED, "tag reservado")
    
    existente = SELECT 1 FROM users WHERE lower(tag) = lower(tag_deseado)
    AFIRMAR(existente IS NULL, "tag no disponible")
    
    BEGIN TX
        user = INSERT INTO users (id=gen_random_uuid(), tag=tag_deseado, email, phone, kyc_status='not_started', account_status='active')
        INSERT INTO tag_history (user_id, tag, status, created_at) VALUES (user.id, tag_deseado, 'active', now())
        INSERT INTO compliance_profiles (user_id) VALUES (user.id)
    COMMIT
    
    RETORNAR user
```

---

## Módulo 2: KYC con Didit

```
FUNCIÓN iniciar_kyc(user_id):
    user = SELECT * FROM users WHERE id = user_id
    
    activa = SELECT * FROM kyc_verifications WHERE user_id = user_id AND status = 'In Progress' ORDER BY created_at DESC LIMIT 1
    SI activa: RETORNAR { url: activa.session_url }
    
    respuesta = HTTP POST 'https://verification.didit.me/v3/session/' CON:
        headers: { 'x-api-key': DIDIT_API_KEY }
        body: { workflow_id: DIDIT_WORKFLOW_ID, vendor_data: user.id, callback: APP_URL + '/kyc/return' }
    
    AFIRMAR(respuesta.status IN [200,201], "error Didit")
    
    verification = INSERT INTO kyc_verifications (user_id, didit_session_id, workflow_id, session_url, status='In Progress', session_created_at=now())
    UPDATE users SET kyc_status = 'in_progress', updated_at = now() WHERE id = user_id
    
    RETORNAR { url: respuesta.url, verification_id: verification.id }

FUNCIÓN procesar_webhook_didit(raw_body, signature_header):
    firma_ok = verificar_hmac_sha256(secret=DIDIT_WEBHOOK_SECRET, body=raw_body, header=signature_header, header_name='X-Signature-V2')
    
    payload = JSON.parse(raw_body)
    evento = INSERT INTO webhook_events (provider='didit', event_id, event_type, payload, signature_valid=firma_ok, received_at=now())
        ON CONFLICT (provider, event_id) DO NOTHING RETURNING *
    
    SI evento IS NULL: RETORNAR 200  # duplicado
    SI NOT firma_ok: RETORNAR 401    # solo auditoría
    
    SI payload.event_type == 'status.updated':
        procesar_cambio_estado(payload)
    
    UPDATE webhook_events SET processed_at = now() WHERE id = evento.id
    RETORNAR 200

FUNCIÓN procesar_cambio_estado(payload):
    session_id = payload.session_id
    nuevo_status = payload.status
    
    verification = SELECT * FROM kyc_verifications WHERE didit_session_id = session_id
    SI verification IS NULL: RETORNAR
    
    UPDATE kyc_verifications SET status = nuevo_status, decision_payload = payload.decision, resolved_at = now() WHERE id = verification.id
    
    SI nuevo_status == 'Approved':
        extraer_y_actualizar_datos_kyc(verification.user_id, payload.decision)
        UPDATE users SET kyc_status = 'approved', kyc_verified_at = now(), kyc_expires_at = now() + interval '1 year' WHERE id = verification.user_id
        UPDATE wallets SET status = 'active' WHERE user_id = verification.user_id AND status = 'pending_kyc'
        disparar_claims_pendientes(verification.user_id)
    SI nuevo_status == 'Declined':
        UPDATE users SET kyc_status = 'declined' WHERE id = verification.user_id
    SI nuevo_status == 'In Review':
        UPDATE users SET kyc_status = 'in_review' WHERE id = verification.user_id
```

---

## Módulo 3: Wallet no-custodial

```
FUNCIÓN crear_wallet(user_id, chain='stellar'):
    user = SELECT * FROM users WHERE id = user_id
    existente = SELECT 1 FROM wallets WHERE user_id = user_id AND chain = chain
    SI existente: RETORNAR "wallet ya existe"
    
    turnkey = HTTP POST TURNKEY_API + '/suborg' CON body: { user_id: user.id, email: user.email }
    address = derivar_address_stellar(turnkey.public_key)
    
    wallet = INSERT INTO wallets (
        user_id, chain, address, custody_type='non_custodial',
        signing_provider='turnkey', turnkey_sub_org_id=turnkey.suborg_id,
        status = CASE WHEN user.kyc_status = 'approved' THEN 'active' ELSE 'pending_kyc' END
    )
    
    RETORNAR wallet
```

---

## Módulo 4: Servicio de Ledger (CRÍTICO)

```
FUNCIÓN crear_asiento(group_id, cuenta, direction, amount, asset, entry_type, refs...):
    AFIRMAR(amount > 0, "amount debe ser positivo")
    LOCK ADVISORY (hash(cuenta, asset))
    
    saldo_actual = SELECT COALESCE(balance_after, 0) FROM ledger_entries
        WHERE (user_id, wallet_id, account_type) = cuenta AND asset = asset
        ORDER BY created_at DESC LIMIT 1
    
    nuevo_saldo = saldo_actual + (amount SI direction='credit' SINO -amount)
    
    INSERT INTO ledger_entries (group_id, cuenta, direction, amount, asset, balance_after=nuevo_saldo, entry_type, refs...)

FUNCIÓN crear_grupo_balanceado(asientos):
    group_id = gen_random_uuid()
    
    BEGIN TX
        PARA CADA asiento EN asientos:
            crear_asiento(group_id, **asiento)
        
        descuadres = SELECT asset, SUM(CASE direction WHEN 'credit' THEN amount WHEN 'debit' THEN -amount END) AS neto
            FROM ledger_entries WHERE group_id = group_id GROUP BY asset HAVING neto <> 0
        
        SI descuadres NO VACÍO: ROLLBACK; RAISE "grupo descuadrado"
    COMMIT
    
    RETORNAR group_id
```

---

## Módulo 5: Cálculo de fees

```
FUNCIÓN calcular_fee(operation_type, fiat_currency, crypto_asset, provider, gross):
    config = SELECT * FROM fee_configs WHERE operation_type = operation_type
        AND (fiat_currency IS NULL OR fiat_currency = fiat_currency)
        AND (crypto_asset IS NULL OR crypto_asset = crypto_asset)
        AND (provider IS NULL OR provider = provider)
        AND is_active = true AND valid_from <= now()
        AND (valid_until IS NULL OR valid_until > now())
        ORDER BY created_at DESC LIMIT 1
    
    SI config IS NULL: RETORNAR { fee: 0, config: NULL }
    
    SI config.fee_type == 'percentage': fee = gross * config.percentage
    SI config.fee_type == 'flat': fee = config.flat_amount
    SI config.fee_type == 'tiered':
        tier = primer tier DONDE gross BETWEEN tier.min AND tier.max
        fee = (gross * tier.percentage) + (tier.flat OR 0)
    
    SI config.min_fee: fee = MAX(fee, config.min_fee)
    SI config.max_fee: fee = MIN(fee, config.max_fee)
    
    RETORNAR { fee: fee, config: config }
```

---

## Módulo 6: Transfer P2P a usuario existente

```
FUNCIÓN transferir_a_usuario(sender_id, recipient_tag, amount, asset, idempotency_key):
    existente = SELECT * FROM transfers WHERE idempotency_key = idempotency_key
    SI existente: RETORNAR existente
    
    recipient = SELECT * FROM users WHERE lower(tag) = lower(recipient_tag)
    AFIRMAR(recipient IS NOT NULL, "usuario no encontrado")
    AFIRMAR(recipient.id != sender_id, "no puedes enviarte a ti mismo")
    
    sender = SELECT * FROM users WHERE id = sender_id
    AFIRMAR(sender.kyc_status == 'approved', "remitente sin KYC")
    AFIRMAR(recipient.kyc_status == 'approved', "destinatario sin KYC")
    AFIRMAR(sender.account_status == 'active', "cuenta suspendida")
    AFIRMAR(recipient.account_status == 'active', "destinatario suspendido")
    
    saldo = saldo_disponible(sender_id, asset)
    AFIRMAR(saldo >= amount, "saldo insuficiente")
    validar_limites_compliance(sender_id, amount, asset)
    
    BEGIN TX
        transfer = INSERT INTO transfers (sender_id, recipient_id=recipient.id, sender_tag=sender.tag, recipient_tag=recipient.tag, amount, asset, type='internal_p2p', status='completed', idempotency_key, completed_at=now())
        
        sender_wallet = SELECT * FROM wallets WHERE user_id = sender_id
        recipient_wallet = SELECT * FROM wallets WHERE user_id = recipient.id
        
        crear_grupo_balanceado([
            { cuenta: {account_type:'user_wallet', user_id:sender_id, wallet_id:sender_wallet.id}, direction:'debit', amount, asset, entry_type:'transfer_out', refs:{transfer_id: transfer.id} },
            { cuenta: {account_type:'user_wallet', user_id:recipient.id, wallet_id:recipient_wallet.id}, direction:'credit', amount, asset, entry_type:'transfer_in', refs:{transfer_id: transfer.id} }
        ])
    COMMIT
    
    actualizar_volumen(sender_id, amount, asset)
    actualizar_volumen(recipient.id, amount, asset)
    
    RETORNAR transfer
```

---

## Módulo 7: Transfer a tag sin usuario (Claimable Balance)

```
FUNCIÓN transferir_a_tag_sin_usuario(sender_id, recipient_tag, amount, asset, idempotency_key, recipient_email):
    existente = SELECT * FROM transfers WHERE idempotency_key = idempotency_key
    SI existente: RETORNAR existente
    
    existente_user = SELECT 1 FROM users WHERE lower(tag) = lower(recipient_tag)
    AFIRMAR(existente_user IS NULL, "usa transferir_a_usuario")
    
    sender = SELECT * FROM users WHERE id = sender_id
    AFIRMAR(sender.kyc_status == 'approved', "remitente sin KYC")
    AFIRMAR(amount <= PENDING_LIMIT_USD, "monto excede límite para no registrados")
    AFIRMAR(saldo_disponible(sender_id, asset) >= amount, "saldo insuficiente")
    
    claimant_address = derivar_address_desde_tag(recipient_tag)
    claim_token = random_bytes(CLAIM_TOKEN_BYTES).hex()
    
    claim = INSERT INTO claims (claim_token_hash=hash(claim_token), claimant_account=claimant_address, sponsor_account=STELLAR_SPONSOR_KEYPAIR.public, status='pending', claimable_until=now()+CLAIM_TTL_DAYS, expires_at=now()+CLAIM_TTL_DAYS)
    
    transfer = INSERT INTO transfers (sender_id, recipient_user_id=NULL, sender_tag=sender.tag, recipient_tag, amount, asset, type='internal_p2p', status='pending', idempotency_key)
    UPDATE claims SET transfer_id = transfer.id WHERE id = claim.id
    
    # On-chain: crear Claimable Balance patrocinado (sandwich)
    result = crear_claimable_balance_sponsored(
        sender_keypair = obtener_signer(sender_id),
        claimant = claimant_address,
        sender_backup = STELLAR_SPONSOR_KEYPAIR.public,
        asset = Asset(asset, STELLAR_USDC_ISSUER),
        amount = amount,
        claimable_until = claim.claimable_until,
        sponsor = STELLAR_SPONSOR_KEYPAIR
    )
    
    UPDATE claims SET stellar_balance_id = result.balance_id WHERE id = claim.id
    UPDATE transfers SET status = 'pending_claim', stellar_create_tx_hash = result.tx_hash WHERE id = transfer.id
    
    crear_grupo_balanceado([
        { cuenta: {account_type:'user_wallet', user_id:sender_id, wallet_id:sender_wallet.id}, direction:'debit', amount, asset, entry_type:'transfer_out', refs:{transfer_id: transfer.id, claim_id: claim.id} },
        { cuenta: {account_type:'pending_claim', user_id:NULL, wallet_id:NULL}, direction:'credit', amount, asset, entry_type:'transfer_in', refs:{transfer_id: transfer.id, claim_id: claim.id} }
    ])
    
    SI recipient_email: enviar_email_reclamo(recipient_email, claim_token, amount, sender.tag)
    
    RETORNAR { transfer, claim_token }  # token plano SOLO aquí
```

---

## Módulo 8: Reclamo del Claim (con KYC)

```
FUNCIÓN iniciar_reclamo(claim_token_plano, email, phone):
    claim_hash = hash(claim_token_plano)
    claim = SELECT * FROM claims WHERE claim_token = claim_hash
    AFIRMAR(claim IS NOT NULL, "link inválido")
    AFIRMAR(claim.status == 'pending', "claim ya usado o expirado")
    AFIRMAR(claim.expires_at > now(), "claim expirado")
    
    transfer = SELECT * FROM transfers WHERE id = claim.transfer_id
    
    user_existente = SELECT * FROM users WHERE lower(email) = lower(email)
    SI user_existente:
        user = user_existente
        AFIRMAR(user.kyc_status != 'approved', "ya tienes cuenta verificada")
    SINO:
        tag = generar_tag_disponible(desde: email)
        user = registrar_usuario(email, phone, tag)
    
    UPDATE claims SET claimed_by_user_id = user.id WHERE id = claim.id
    
    wallet = crear_wallet(user.id) SI NOT EXISTS
    
    SI user.kyc_status != 'approved':
        kyc = iniciar_kyc(user.id)
        RETORNAR { next: 'kyc', url: kyc.url, claim_id: claim.id }
    
    liberar_claim(claim.id)
    RETORNAR { next: 'completed' }

FUNCIÓN disparar_claims_pendientes(user_id):
    claims = SELECT * FROM claims WHERE claimed_by_user_id = user_id AND status = 'pending' AND expires_at > now()
    PARA CADA claim EN claims:
        liberar_claim(claim.id)

FUNCIÓN liberar_claim(claim_id):
    claim = SELECT * FROM claims WHERE id = claim_id
    AFIRMAR(claim.status == 'pending', "claim no liberable")
    
    transfer = SELECT * FROM transfers WHERE id = claim.transfer_id
    user = SELECT * FROM users WHERE id = claim.claimed_by_user_id
    AFIRMAR(user.kyc_status == 'approved', "KYC no aprobado")
    
    wallet = SELECT * FROM wallets WHERE user_id = user.id
    AFIRMAR(wallet.status == 'active', "wallet no activa")
    
    # On-chain: claimClaimableBalance con fee-bump del sponsor
    result = reclamar_claimable_balance(
        balance_id = claim.stellar_balance_id,
        claimant = wallet.address,
        sponsor = STELLAR_SPONSOR_KEYPAIR
    )
    
    UPDATE transfers SET status = 'claimed_onchain', stellar_claim_tx_hash = result.tx_hash, recipient_user_id = user.id WHERE id = transfer.id
    
    crear_grupo_balanceado([
        { cuenta: {account_type:'pending_claim', user_id:NULL, wallet_id:NULL}, direction:'debit', amount: transfer.amount, asset: transfer.asset, entry_type:'claim_release', refs:{transfer_id: transfer.id, claim_id: claim.id} },
        { cuenta: {account_type:'user_wallet', user_id:user.id, wallet_id:wallet.id}, direction:'credit', amount: transfer.amount, asset: transfer.asset, entry_type:'claim_release', refs:{transfer_id: transfer.id, claim_id: claim.id} }
    ])
    
    UPDATE transfers SET status = 'completed', completed_at = now() WHERE id = transfer.id
    UPDATE claims SET status = 'claimed', claimed_at = now() WHERE id = claim_id
```

---

## Módulo 9: Expiración y reverso

```
FUNCIÓN expirar_claims_vencidos():
    vencidos = SELECT * FROM claims WHERE status = 'pending' AND expires_at <= now()
    
    PARA CADA claim EN vencidos:
        INTENTAR:
            transfer = SELECT * FROM transfers WHERE id = claim.transfer_id
            
            result = reclamar_claimable_balance(
                balance_id = claim.stellar_balance_id,
                claimant = STELLAR_SPONSOR_KEYPAIR.public,  # sender_backup
                sponsor = STELLAR_SPONSOR_KEYPAIR
            )
            
            sender_wallet = SELECT * FROM wallets WHERE user_id = transfer.sender_user_id
            
            crear_grupo_balanceado([
                { cuenta: {account_type:'pending_claim', user_id:NULL, wallet_id:NULL}, direction:'debit', amount: transfer.amount, asset: transfer.asset, entry_type:'reversal', refs:{transfer_id: transfer.id, claim_id: claim.id} },
                { cuenta: {account_type:'user_wallet', user_id:transfer.sender_user_id, wallet_id:sender_wallet.id}, direction:'credit', amount: transfer.amount, asset: transfer.asset, entry_type:'reversal', refs:{transfer_id: transfer.id, claim_id: claim.id} }
            ])
            
            UPDATE transfers SET status = 'reversed', failure_reason = 'claim_expired'
            UPDATE claims SET status = 'expired'
            
        CATCH error:
            LOG "reverso falló para claim " + claim.id + ": " + error.message
```

---

## Módulo 10: Job de reconciliación

```
FUNCIÓN reconciliar_transacciones_onchain():
    # 1. Transfers en 'claimed_onchain' sin confirmar
    pendientes = SELECT * FROM transfers WHERE status = 'claimed_onchain'
    PARA CADA t EN pendientes:
        tx = GET STELLAR_HORIZON_URL + '/transactions/' + t.stellar_claim_tx_hash
        SI tx.successful:
            UPDATE transfers SET status = 'completed', completed_at = now() WHERE id = t.id
        SI NOT tx.successful:
            LOG "tx falló: " + t.id
    
    # 2. Claims huérfanos con balance_id pero transfer pending
    huerfanos = SELECT c.* FROM claims c JOIN transfers t ON t.id = c.transfer_id WHERE c.stellar_balance_id IS NOT NULL AND t.status = 'pending'
    PARA CADA c EN huerfanos:
        balance = GET STELLAR_HORIZON_URL + '/claimable_balances/' + c.stellar_balance_id
        SI balance EXISTS:
            UPDATE transfers SET status = 'pending_claim', stellar_create_tx_hash = balance.last_modified_tx WHERE id = c.transfer_id
```

---

## Módulo 11: Fees

```
FUNCIÓN calcular_fee(operation_type, fiat_currency, crypto_asset, provider, gross):
    config = SELECT * FROM fee_configs
        WHERE operation_type = operation_type
          AND (fiat_currency IS NULL OR fiat_currency = fiat_currency)
          AND (crypto_asset IS NULL OR crypto_asset = crypto_asset)
          AND (provider IS NULL OR provider = provider)
          AND is_active = true
          AND valid_from <= now()
          AND (valid_until IS NULL OR valid_until > now())
        ORDER BY created_at DESC LIMIT 1
    
    SI config IS NULL: RETORNAR { fee: 0, config: NULL }
    
    SI config.fee_type == 'percentage': fee = gross * config.percentage
    SI config.fee_type == 'flat': fee = config.flat_amount
    SI config.fee_type == 'tiered':
        tier = primer tier DONDE gross BETWEEN tier.min AND tier.max
        fee = (gross * tier.percentage) + (tier.flat OR 0)
    
    SI config.min_fee: fee = MAX(fee, config.min_fee)
    SI config.max_fee: fee = MIN(fee, config.max_fee)
    
    RETORNAR { fee: fee, config: config }
```

---

## Tests de invariantes (CI bloqueante)

1. `test_suma_cero_todos_los_grupos` — `check_ledger_invariants()` vacío
2. `test_balance_after_consistente` — suma corrida == balance_after
3. `test_idempotencia_transfers` — mismo key → misma transfer
4. `test_idempotencia_webhook` — mismo event_id → 1 fila
5. `test_kyc_gate_claim` — declined → claim no libera
6. `test_pending_claim_no_crea_usuario` — users vacío hasta redeem
7. `test_expiracion_revierte` — expiración → saldo vuelve al sender
8. `test_firma_webhook_invalida` — no procesa lógica si firma falla
9. `test_grupo_descuadrado_hace_rollback` — transacción completa se revierte
10. `test_wallet_sin_secret_en_db` — ninguna columna permite reconstruir clave
```