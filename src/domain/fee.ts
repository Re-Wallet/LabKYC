export type OperationType = "on_ramp" | "off_ramp" | "p2p_transfer" | "withdrawal";
export type FeePayer = "user" | "platform" | "absorbed";
export type FeeType = "percentage" | "flat" | "tiered";

export interface FeeTier {
  min: number;
  max?: number | null;
  percentage: number;
  flat?: number | null;
}

export interface FeeConfig {
  id: string;
  name: string;
  operationType: OperationType;
  fiatCurrency?: string | null;
  cryptoAsset?: string | null;
  provider?: string | null;
  feePayer: FeePayer;
  feeType: FeeType;
  percentage?: number | null;
  flatAmount?: number | null;
  minFee?: number | null;
  maxFee?: number | null;
  tiers?: FeeTier[] | null;
  assetChargedIn: string;
  isActive: boolean;
}

export interface FeeCharge {
  id: string;
  feeConfigId?: string | null;
  transferId: string;
  ledgerEntryId?: string | null;
  provider: string;
  legType: string;
  grossAmount: number;
  feeAmount: number;
  feeAsset: string;
  feePayer: FeePayer;
  status: string;
}

export interface FeeRepository {
  obtenerConfigActivo(params: {
    operationType: OperationType;
    fiatCurrency?: string | null;
    cryptoAsset?: string | null;
    provider?: string | null;
  }): Promise<FeeConfig | null>;
  crearCharge(data: {
    feeConfigId?: string | null;
    transferId: string;
    ledgerEntryId?: string | null;
    provider: string;
    legType: string;
    grossAmount: number;
    feeAmount: number;
    feeAsset: string;
    feePayer: FeePayer;
    status: string;
  }): Promise<FeeCharge>;
}

export interface FeeCalculoResultado {
  fee: number;
  config: FeeConfig | null;
}
