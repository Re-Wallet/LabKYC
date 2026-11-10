-- ============================================================
-- LabKYC — Migración inicial completa
-- Base de datos: PostgreSQL 15+ (Neon compatible)
-- ============================================================

-- ============================================================
-- Extensiones
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- tags y emails case-insensitive

-- ============================================================
-- Tipos enumerados
-- ============================================================
CREATE TYPE kyc_status           AS ENUM ('not_started','in_progress','approved','declined','in_review');
CREATE TYPE account_status       AS ENUM ('active','suspended','blocked');
CREATE TYPE didit_kyc_status     AS ENUM ('In Progress','Approved','Declined','In Review');
CREATE TYPE custody_type         AS ENUM ('non_custodial');
CREATE TYPE wallet_status        AS ENUM ('pending_kyc','active','frozen');
CREATE TYPE tag_status           AS ENUM ('active','released','quarantined');
CREATE TYPE risk_level           AS ENUM ('low','medium','high');
CREATE TYPE kyc_tier             AS ENUM ('light','full','enhanced');
CREATE TYPE transfer_type        AS ENUM ('internal_p2p','onchain');
CREATE TYPE transfer_status      AS ENUM ('pending','pending_claim','claimed_onchain','completed','failed','reversed');
CREATE TYPE claim_status         AS ENUM ('pending','claimed','expired','cancelled');
CREATE TYPE ledger_account_type  AS ENUM ('user_wallet','external','fee_collected','pending_claim');
CREATE TYPE ledger_direction     AS ENUM ('debit','credit');
CREATE TYPE ledger_entry_type    AS ENUM ('transfer_in','transfer_out','ramp_in','ramp_out','fee','reversal','claim_release');
CREATE TYPE operation_type_enum  AS ENUM ('on_ramp','off_ramp','p2p_transfer','withdrawal');
CREATE TYPE fee_payer_enum       AS ENUM ('user','platform','absorbed');
CREATE TYPE fee_type_enum        AS ENUM ('percentage','flat','tiered');
CREATE TYPE fee_charge_status    AS ENUM ('quoted','applied','reversed');
CREATE TYPE fee_leg_type         AS ENUM ('PROVIDER_ONRAMP','SWAP','BRIDGE','PLATFORM');

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tag               CITEXT NOT NULL,
    tag_change_count  SMALLINT NOT NULL DEFAULT 0,
    tag_updated_at    TIMESTAMPTZ,
    email             CITEXT NOT NULL,
    phone_number      TEXT,
    full_name         TEXT,
    date_of_birth     DATE,
    document_type     TEXT,
    document_number   TEXT,
    document_expiry   DATE,
    nationality       TEXT,
    kyc_status        kyc_status NOT NULL DEFAULT 'not_started',
    kyc_verified_at   TIMESTAMPTZ,
    kyc_expires_at    TIMESTAMPTZ,
    account_status    account_status NOT NULL DEFAULT 'active',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_tag_format CHECK (tag ~ '^[a-z0-9._]{3,20}$'),
    CONSTRAINT users_tag_change_max CHECK (tag_change_count BETWEEN 0 AND 2)
);

CREATE UNIQUE INDEX users_tag_lower_uq   ON users (lower(tag));
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- ============================================================
-- TAG_HISTORY
-- ============================================================
CREATE TABLE tag_history (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag                CITEXT NOT NULL,
    status             tag_status NOT NULL DEFAULT 'active',
    quarantined_until  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tag_history_format CHECK (tag ~ '^[a-z0-9._]{3,20}$')
);

CREATE INDEX tag_history_user_idx ON tag_history(user_id);
CREATE INDEX tag_history_tag_idx  ON tag_history(lower(tag));

-- ============================================================
-- KYC_VERIFICATIONS
-- ============================================================
CREATE TABLE kyc_verifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    didit_session_id    TEXT NOT NULL,
    workflow_id         TEXT NOT NULL,
    session_url         TEXT,
    status              didit_kyc_status NOT NULL DEFAULT 'In Progress',
    decision_payload    JSONB,
    decline_reason      TEXT,
    session_created_at  TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX kyc_didit_session_uq ON kyc_verifications(didit_session_id);
CREATE INDEX kyc_user_idx ON kyc_verifications(user_id, created_at DESC);

-- ============================================================
-- WEBHOOK_EVENTS
-- ============================================================
CREATE TABLE webhook_events (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_verification_id   UUID REFERENCES kyc_verifications(id) ON DELETE SET NULL,
    provider              TEXT NOT NULL DEFAULT 'didit',
    event_id              TEXT NOT NULL,
    event_type            TEXT NOT NULL,
    payload               JSONB NOT NULL,
    signature_valid       BOOLEAN NOT NULL DEFAULT false,
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX webhook_event_provider_uq ON webhook_events(provider, event_id);
CREATE INDEX webhook_kyc_idx ON webhook_events(kyc_verification_id);

-- ============================================================
-- WALLETS
-- ============================================================
CREATE TABLE wallets (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    chain                 TEXT NOT NULL DEFAULT 'stellar',
    address               TEXT NOT NULL,
    custody_type          custody_type NOT NULL DEFAULT 'non_custodial',
    signing_provider      TEXT NOT NULL,
    turnkey_sub_org_id    TEXT,
    pollar_wallet_id      TEXT,
    status                wallet_status NOT NULL DEFAULT 'pending_kyc',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT wallets_custody_non_custodial CHECK (custody_type = 'non_custodial')
);

CREATE UNIQUE INDEX wallets_address_uq    ON wallets(chain, address);
CREATE UNIQUE INDEX wallets_user_chain_uq ON wallets(user_id, chain);

-- ============================================================
-- COMPLIANCE_PROFILES
-- ============================================================
CREATE TABLE compliance_profiles (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    risk_level            risk_level NOT NULL DEFAULT 'low',
    pep_status            BOOLEAN NOT NULL DEFAULT false,
    sanctions_hit         BOOLEAN NOT NULL DEFAULT false,
    source_of_funds       TEXT,
    kyc_tier              kyc_tier NOT NULL DEFAULT 'light',
    cumulative_volume_usd NUMERIC(20,2) NOT NULL DEFAULT 0,
    monthly_volume_usd    NUMERIC(20,2) NOT NULL DEFAULT 0,
    transaction_count     INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at      TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TRANSFERS
-- ============================================================
CREATE TABLE transfers (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recipient_user_id       UUID REFERENCES users(id) ON DELETE RESTRICT,
    sender_tag              TEXT NOT NULL,
    recipient_tag           TEXT NOT NULL,
    amount                  NUMERIC(20,8) NOT NULL,
    asset                   TEXT NOT NULL,
    type                    transfer_type NOT NULL,
    status                  transfer_status NOT NULL DEFAULT 'pending',
    idempotency_key         TEXT NOT NULL,
    stellar_create_tx_hash  TEXT,
    stellar_claim_tx_hash   TEXT,
    failure_reason          TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ,
    CONSTRAINT transfers_amount_positive CHECK (amount > 0),
    CONSTRAINT transfers_pending_claim_no_user CHECK (
        status <> 'pending_claim' OR recipient_user_id IS NULL
    )
);

CREATE UNIQUE INDEX transfers_idempotency_uq  ON transfers(idempotency_key);
CREATE INDEX transfers_sender_idx    ON transfers(sender_user_id, created_at DESC);
CREATE INDEX transfers_recipient_idx ON transfers(recipient_user_id, created_at DESC);
CREATE INDEX transfers_status_idx    ON transfers(status);

-- ============================================================
-- CLAIMS (Claimable Balances)
-- ============================================================
CREATE TABLE claims (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID REFERENCES users(id) ON DELETE RESTRICT,
    claim_token_hash        TEXT NOT NULL,
    claim_token_plain       TEXT, -- solo en memoria, NO persistir en producción
    amount                  NUMERIC(20,8) NOT NULL,
    asset                   TEXT NOT NULL,
    status                  claim_status NOT NULL DEFAULT 'pending',
    stellar_balance_id      TEXT,
    stellar_create_tx_hash  TEXT,
    stellar_claim_tx_hash   TEXT,
    expires_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX claims_token_hash_uq ON claims(claim_token_hash);
CREATE INDEX claims_user_idx   ON claims(user_id, created_at DESC);
CREATE INDEX claims_status_idx ON claims(status);

-- ============================================================
-- LEDGER_ENTRIES (doble entrada contable, suma cero por grupo)
-- ============================================================
CREATE TABLE ledger_entries (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_group_id    UUID NOT NULL,
    cuenta_user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
    cuenta_wallet_id        UUID REFERENCES wallets(id) ON DELETE SET NULL,
    cuenta_account_type     ledger_account_type NOT NULL,
    direction               ledger_direction NOT NULL,
    amount                  NUMERIC(20,8) NOT NULL,
    asset                   TEXT NOT NULL,
    entry_type              ledger_entry_type NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_group_idx ON ledger_entries(transaction_group_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(cuenta_user_id, cuenta_wallet_id);
CREATE INDEX ledger_entries_asset_idx ON ledger_entries(asset);

-- ============================================================
-- FEE_CHARGES (comisiones cobradas)
-- ============================================================
CREATE TABLE fee_charges (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id UUID REFERENCES transfers(id) ON DELETE SET NULL,
    amount      NUMERIC(20,8) NOT NULL,
    asset       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fee_charges_transfer_idx ON fee_charges(transfer_id);

-- ============================================================
-- FEE_CONFIGS (configuración de fees por asset)
-- ============================================================
CREATE TABLE fee_configs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset        TEXT NOT NULL,
    fee_type     fee_type_enum NOT NULL,
    fee_value    NUMERIC(20,8) NOT NULL,
    min_amount   NUMERIC(20,8),
    max_amount   NUMERIC(20,8),
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX fee_configs_asset_uq ON fee_configs(asset);

-- ============================================================
-- Función de verificación de invariante del ledger (suma cero por grupo)
-- ============================================================
CREATE OR REPLACE FUNCTION check_ledger_invariants() RETURNS INTEGER AS $$
DECLARE
    rec RECORD;
    imbalance_count INTEGER := 0;
BEGIN
    FOR rec IN
        SELECT transaction_group_id, asset,
               SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount END) AS net
        FROM ledger_entries
        GROUP BY transaction_group_id, asset
        HAVING ABS(net) > 0.00000001
    LOOP
        imbalance_count := imbalance_count + 1;
    END LOOP;
    RETURN imbalance_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Fin de la migración
-- ============================================================
COMMENT ON TABLE users IS 'Usuarios del sistema con KYC y compliance';
COMMENT ON TABLE claims IS 'Claimable Balances creados para destinatarios sin cuenta';
COMMENT ON TABLE ledger_entries IS 'Asientos contables de doble entrada (suma cero por grupo)';
COMMENT ON TABLE fee_charges IS 'Comisiones cobradas en transferencias';
COMMENT ON TABLE fee_configs IS 'Configuración de fees por asset';