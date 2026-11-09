import type { StellarClient } from "../domain/claim";

export interface ClaimableBalanceRecord {
  claimant: string;
  sponsor: string;
  amount: number;
  asset: string;
  claimableUntil: Date;
  claimed: boolean;
  claimedBy?: string;
}

/**
 * Cliente Stellar simulado para el lab.
 *
 * Reemplaza al SDK real (@stellar/stellar-sdk) hasta que haya credenciales de
 * Testnet y un signer configurado. Mantiene la misma interfaz de puerto.
 */
export class StellarMockClient implements StellarClient {
  balances = new Map<string, ClaimableBalanceRecord>();
  transacciones = new Map<string, { successful: boolean }>();

  async crearClaimableBalanceSponsored(params: {
    claimant: string;
    sponsor: string;
    asset: string;
    amount: number;
    claimableUntil: Date;
  }): Promise<{ balanceId: string; txHash: string }> {
    const balanceId = `balance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const txHash = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.balances.set(balanceId, {
      claimant: params.claimant,
      sponsor: params.sponsor,
      amount: params.amount,
      asset: params.asset,
      claimableUntil: params.claimableUntil,
      claimed: false,
    });
    this.transacciones.set(txHash, { successful: true });
    return { balanceId, txHash };
  }

  async reclamarClaimableBalance(params: {
    balanceId: string;
    claimant: string;
    sponsor: string;
  }): Promise<{ txHash: string }> {
    const balance = this.balances.get(params.balanceId);
    if (!balance) throw new Error(`claimable balance ${params.balanceId} no encontrado`);
    if (balance.claimed) throw new Error(`claimable balance ${params.balanceId} ya fue reclamado`);
    balance.claimed = true;
    balance.claimedBy = params.claimant;
    const txHash = `tx_claim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.transacciones.set(txHash, { successful: true });
    return { txHash };
  }

  async obtenerEstadoTransaccion(txHash: string): Promise<{ successful: boolean }> {
    return this.transacciones.get(txHash) ?? { successful: false };
  }

  async existeClaimableBalance(balanceId: string): Promise<{ exists: boolean; lastModifiedTx?: string }> {
    const balance = this.balances.get(balanceId);
    if (!balance) return { exists: false };
    return { exists: true, lastModifiedTx: `tx_${balanceId}` };
  }
}
