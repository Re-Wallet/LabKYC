import { queryOne } from "./db";
import type { FeeRepository, FeeConfig, FeeCharge, FeeTier } from "../domain/fee";

export class PostgresFeeRepository implements FeeRepository {
  async obtenerConfigActivo(params: {
    operationType: string;
    fiatCurrency?: string | null;
    cryptoAsset?: string | null;
    provider?: string | null;
  }): Promise<FeeConfig | null> {
    const row = await queryOne(
      `SELECT * FROM fee_configs
       WHERE is_active = true
         AND operation_type = $1
         AND ($2::text IS NULL OR fiat_currency = $2)
         AND ($3::text IS NULL OR crypto_asset = $3)
         AND ($4::text IS NULL OR provider = $4)
         AND valid_from <= now()
         AND (valid_until IS NULL OR valid_until > now())
       ORDER BY created_at DESC LIMIT 1`,
      [params.operationType, params.fiatCurrency ?? null, params.cryptoAsset ?? null, params.provider ?? null],
    );
    return row ? mapConfig(row) : null;
  }

  async crearCharge(data: {
    feeConfigId?: string | null;
    transferId: string;
    ledgerEntryId?: string | null;
    provider: string;
    legType: string;
    grossAmount: number;
    feeAmount: number;
    feeAsset: string;
    feePayer: string;
    status: string;
  }): Promise<FeeCharge> {
    const row = await queryOne(
      `INSERT INTO fee_charges (fee_config_id, transfer_id, ledger_entry_id, provider, leg_type,
                                gross_amount, fee_amount, fee_asset, fee_payer, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        data.feeConfigId ?? null,
        data.transferId,
        data.ledgerEntryId ?? null,
        data.provider,
        data.legType,
        data.grossAmount,
        data.feeAmount,
        data.feeAsset,
        data.feePayer,
        data.status,
      ],
    );
    return mapCharge(row);
  }
}

function mapConfig(row: any): FeeConfig {
  return {
    id: row.id,
    name: row.name,
    operationType: row.operation_type,
    fiatCurrency: row.fiat_currency,
    cryptoAsset: row.crypto_asset,
    provider: row.provider,
    feePayer: row.fee_payer,
    feeType: row.fee_type,
    percentage: row.percentage !== null ? Number(row.percentage) : null,
    flatAmount: row.flat_amount !== null ? Number(row.flat_amount) : null,
    minFee: row.min_fee !== null ? Number(row.min_fee) : null,
    maxFee: row.max_fee !== null ? Number(row.max_fee) : null,
    tiers: row.tiers as FeeTier[] | null,
    assetChargedIn: row.asset_charged_in,
    isActive: row.is_active,
  };
}

function mapCharge(row: any): FeeCharge {
  return {
    id: row.id,
    feeConfigId: row.fee_config_id,
    transferId: row.transfer_id,
    ledgerEntryId: row.ledger_entry_id,
    provider: row.provider,
    legType: row.leg_type,
    grossAmount: Number(row.gross_amount),
    feeAmount: Number(row.fee_amount),
    feeAsset: row.fee_asset,
    feePayer: row.fee_payer,
    status: row.status,
  };
}
