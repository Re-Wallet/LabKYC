import { ExpiracionUseCases } from "../application/expiration";
import { ReconciliacionUseCases } from "../application/reconciliation";
import { PostgresClaimRepository } from "./claimRepo";
import { PostgresTransferRepository } from "./transferRepo";
import { PostgresWalletRepository } from "./walletRepo";
import { PostgresLedgerService } from "./ledgerRepo";
import { StellarMockClient } from "./stellarClient";

/**
 * Jobs programados del lab.
 *
 * - Expiración: cada hora, revierte claims vencidos al remitente.
 * - Reconciliación: cada 2 minutos, alinea on-chain ↔ ledger.
 *
 * En el lab se disparan manualmente vía POST /jobs/:job y también pueden
 * correr en background con `iniciarJobs()`.
 */
export function crearExpiracionUseCases(stellar = new StellarMockClient()): ExpiracionUseCases {
  return new ExpiracionUseCases(
    new PostgresClaimRepository(),
    new PostgresTransferRepository(),
    new PostgresWalletRepository(),
    new PostgresLedgerService(),
    stellar,
  );
}

export function crearReconciliacionUseCases(stellar = new StellarMockClient()): ReconciliacionUseCases {
  return new ReconciliacionUseCases(
    new PostgresTransferRepository(),
    new PostgresClaimRepository(),
    stellar,
  );
}

export interface JobHandle {
  stop(): void;
}

export function iniciarJobs(): JobHandle[] {
  const expiracionSegundos = Number(process.env.EXPIRATION_INTERVAL_SECONDS) || 3600;
  const reconciliacionSegundos = Number(process.env.RECONCILIATION_INTERVAL_SECONDS) || 120;

  const expiracionTimer = setInterval(() => {
    void crearExpiracionUseCases()
      .expirarClaimsVencidos()
      .then((r) => {
        if (r.expirados > 0 || r.fallidos > 0) {
          console.log(`[job:expiracion] expirados=${r.expirados} fallidos=${r.fallidos}`);
        }
      })
      .catch((e) => console.error("[job:expiracion] error", e));
  }, expiracionSegundos * 1000);

  const reconciliacionTimer = setInterval(() => {
    void crearReconciliacionUseCases()
      .reconciliar()
      .then((r) => {
        if (r.completadas > 0 || r.huerfanos > 0) {
          console.log(
            `[job:reconciliacion] completadas=${r.completadas} huerfanos=${r.huerfanos} fallidas=${r.fallidas}`,
          );
        }
      })
      .catch((e) => console.error("[job:reconciliacion] error", e));
  }, reconciliacionSegundos * 1000);

  return [
    { stop: () => clearInterval(expiracionTimer) },
    { stop: () => clearInterval(reconciliacionTimer) },
  ];
}
