import type {
  FeeRepository,
  FeeCalculoResultado,
  OperationType,
  FeeConfig,
  FeeTier,
} from "../domain/fee";

export interface CalcularFeeInput {
  operationType: OperationType;
  fiatCurrency?: string | null;
  cryptoAsset?: string | null;
  provider?: string | null;
  gross: number;
}

/**
 * Módulo 11 — Cálculo de fees.
 *
 * Soporta percentage, flat y tiered, con piso (min_fee) y techo (max_fee).
 */
export class FeeUseCases {
  constructor(private feeRepo: FeeRepository) {}

  async calcularFee(input: CalcularFeeInput): Promise<FeeCalculoResultado> {
    const config = await this.feeRepo.obtenerConfigActivo({
      operationType: input.operationType,
      fiatCurrency: input.fiatCurrency ?? null,
      cryptoAsset: input.cryptoAsset ?? null,
      provider: input.provider ?? null,
    });

    if (!config) return { fee: 0, config: null };

    let fee = 0;

    if (config.feeType === "percentage") {
      fee = input.gross * Number(config.percentage ?? 0);
    } else if (config.feeType === "flat") {
      fee = Number(config.flatAmount ?? 0);
    } else if (config.feeType === "tiered") {
      fee = this.calcularTiered(config, input.gross);
    }

    // Aplicar piso y techo
    if (config.minFee !== null && config.minFee !== undefined) {
      fee = Math.max(fee, Number(config.minFee));
    }
    if (config.maxFee !== null && config.maxFee !== undefined) {
      fee = Math.min(fee, Number(config.maxFee));
    }

    return { fee: round8(fee), config };
  }

  private calcularTiered(config: FeeConfig, gross: number): number {
    const tiers: FeeTier[] = config.tiers ?? [];
    const tier = tiers.find((t) => {
      const enRangoMin = gross >= Number(t.min);
      const enRangoMax = t.max === null || t.max === undefined || gross <= Number(t.max);
      return enRangoMin && enRangoMax;
    });
    if (!tier) return 0;
    return gross * Number(tier.percentage) + Number(tier.flat ?? 0);
  }
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
