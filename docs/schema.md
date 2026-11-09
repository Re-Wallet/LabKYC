# LabKYC — Esquema de datos (Mermaid)

```mermaid
erDiagram
    USERS ||--|| COMPLIANCE_PROFILES : "1:1"
    USERS ||--o{ TAG_HISTORY : "historial"
    USERS ||--o{ KYC_VERIFICATIONS : "verificaciones"
    USERS ||--o{ WALLETS : "1:1 por chain"
    USERS ||--o{ TRANSFERS : "sender"
    USERS ||--o{ TRANSFERS : "recipient"
    USERS ||--o{ CLAIMS : "claimed_by"
    USERS ||--o{ LEDGER_ENTRIES : "asientos"

    TRANSFERS ||--|| CLAIMS : "claimable balance"
    TRANSFERS ||--o{ FEE_CHARGES : "fees"
    TRANSFERS ||--o{ LEDGER_ENTRIES : "asientos"

    CLAIMS ||--o{ LEDGER_ENTRIES : "asientos"

    FEE_CONFIGS ||--o{ FEE_CHARGES : "config"

    WEBHOOK_EVENTS }|--o{ KYC_VERIFICATIONS : "origen"

    USERS {
        uuid id PK
        citext tag UK
        smallint tag_change_count
        timestamptz tag_updated_at
        citext email UK
        text phone_number
        text full_name
        date date_of_birth
        text document_type
        text document_number
        date document_expiry
        text nationality
        kyc_status kyc_status
        timestamptz kyc_verified_at
        timestamptz kyc_expires_at
        account_status account_status
        timestamptz created_at
        timestamptz updated_at
    }

    TAG_HISTORY {
        uuid id PK
        uuid user_id FK
        citext tag
        tag_status status
        timestamptz quarantined_until
        timestamptz created_at
    }

    KYC_VERIFICATIONS {
        uuid id PK
        uuid user_id FK
        text didit_session_id UK
        text workflow_id
        text session_url
        didit_kyc_status status
        jsonb decision_payload
        text decline_reason
        timestamptz session_created_at
        timestamptz resolved_at
        timestamptz created_at
    }

    WEBHOOK_EVENTS {
        uuid id PK
        uuid kyc_verification_id FK
        text provider
        text event_id
        text event_type
        jsonb payload
        boolean signature_valid
        timestamptz received_at
        timestamptz processed_at
    }

    WALLETS {
        uuid id PK
        uuid user_id FK
        text chain
        text address
        custody_type custody_type
        text signing_provider
        text turnkey_sub_org_id
        text pollar_wallet_id
        wallet_status status
        timestamptz created_at
    }

    COMPLIANCE_PROFILES {
        uuid id PK
        uuid user_id FK UK
        risk_level risk_level
        boolean pep_status
        boolean sanctions_hit
        text source_of_funds
        kyc_tier kyc_tier
        numeric cumulative_volume_usd
        numeric monthly_volume_usd
        integer transaction_count
        timestamptz last_reviewed_at
        timestamptz created_at
        timestamptz updated_at
    }

    TRANSFERS {
        uuid id PK
        uuid sender_user_id FK
        uuid recipient_user_id FK
        text sender_tag
        text recipient_tag
        numeric amount
        text asset
        transfer_type type
        transfer_status status
        text idempotency_key UK
        text stellar_create_tx_hash
        text stellar_claim_tx_hash
        text failure_reason
        timestamptz created_at
        timestamptz completed_at
    }

    CLAIMS {
        uuid id PK
        uuid transfer_id FK UK
        text claim_token_hash UK
        text stellar_balance_id UK
        text sponsor_account
        text claimant_account
        claim_status status
        timestamptz claimable_until
        timestamptz expires_at
        uuid claimed_by_user_id FK
        timestamptz claimed_at
        timestamptz created_at
    }

    LEDGER_ENTRIES {
        uuid id PK
        uuid transaction_group_id
        uuid user_id FK
        uuid wallet_id FK
        ledger_account_type account_type
        ledger_direction direction
        numeric amount
        text asset
        numeric balance_after
        ledger_entry_type entry_type
        uuid reference_transfer_id FK
        uuid reference_claim_id FK
        text reference_external_id
        timestamptz created_at
    }

    FEE_CONFIGS {
        uuid id PK
        text name
        operation_type_enum operation_type
        text fiat_currency
        text crypto_asset
        text provider
        fee_payer_enum fee_payer
        fee_type_enum fee_type
        numeric percentage
        numeric flat_amount
        numeric min_fee
        numeric max_fee
        jsonb tiers
        text asset_charged_in
        boolean is_active
        timestamptz valid_from
        timestamptz valid_until
        timestamptz created_at
    }

    FEE_CHARGES {
        uuid id PK
        uuid fee_config_id FK
        uuid transfer_id FK
        uuid ledger_entry_id FK
        text provider
        fee_leg_type leg_type
        numeric gross_amount
        numeric fee_amount
        text fee_asset
        fee_payer_enum fee_payer
        fee_charge_status status
        jsonb provider_quote_fragment
        timestamptz created_at
    }
```