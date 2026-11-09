import type { ClaimRepository, StellarClient, TransferRepository } from "../domain/";

export interface ReconciliacionResultado {
  completadas: number;
  huerfanos: number;
  fallidas: number;
}

/**
 * Módulo 10 — Reconciliación on-chain ↔ ledger.
 *
 * 1. Transfers en `claimed_onchain` que no llegaron a `completed`:
 *    consulta Horizon y actualiza a completed si la tx fue exitosa.
 * 2. Claims con `stellar_balance_id` pero transfer aún `pending` (huérfanos por
 *    fallo de persistencia): reconcilia el estado on-chain.
 */
export class ReconciliacionUseCases {
  constructor(
    private transferRepo: TransferRepository,
    private claimRepo: ClaimRepository,
    private stellar: StellarClient,
  ) {}

  async reconciliar(): Promise<ReconciliacionResultado> {
    let completadas = 0;
    let huerfanos = 0;
    let fallidas = 0;

    // 1. claimed_onchain -> completed
    const pendientes = await this.transferRepo.listarPorEstado("claimed_onchain");
    for (const transfer of pendientes) {
      if (!transfer.stellarClaimTxHash) continue;
      try {
        const tx = await this.stellar.obtenerEstadoTransaccion(transfer.stellarClaimTxHash);
        if (tx.successful) {
          await this.transferRepo.actualizarEstado(transfer.id, "completed", {
            completedAt: new Date(),
          });
          completadas++;
        }
      } catch {
        fallidas++;
      }
    }

    // 2. Huérfanos: claim con balance_id pero transfer en pending
    const orphans = await this.claimRepo.listarHuerfanos();
    for (const claim of orphans) {
      try {
        const balance = await this.stellar.existeClaimableBalance(claim.stellarBalanceId ?? "");
        if (balance.exists) {
          await this.transferRepo.actualizarEstado(claim.transferId, "pending_claim", {
            stellarCreateTxHash: balance.lastModifiedTx ?? null,
          });
          huerfanos++;
        }
      } catch {
        fallidas++;
      }
    }

    return { completadas, huerfanos, fallidas };
  }
}
