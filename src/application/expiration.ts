import { ClaimError } from "../domain/claim";
import type {
  ClaimRepository,
  StellarClient,
  WalletRepository,
  LedgerService,
  TransferRepository,
} from "../domain/";

export interface ExpiracionResultado {
  expirados: number;
  fallidos: number;
}

/**
 * Módulo 9 — Expiración y reverso.
 *
 * El sponsor reclama el Claimable Balance como claimant de reverso y el saldo
 * vuelve al remitente mediante asientos de tipo `reversal`.
 */
export class ExpiracionUseCases {
  constructor(
    private claimRepo: ClaimRepository,
    private transferRepo: TransferRepository,
    private walletRepo: WalletRepository,
    private ledger: LedgerService,
    private stellar: StellarClient,
  ) {}

  async expirarClaimsVencidos(ahora: Date = new Date()): Promise<ExpiracionResultado> {
    const vencidos = await this.claimRepo.listarVencidos(ahora);
    let expirados = 0;
    let fallidos = 0;

    for (const claim of vencidos) {
      try {
        await this.revertirClaim(claim.id);
        expirados++;
      } catch {
        // El claim sigue pending: se reintenta en el próximo ciclo.
        fallidos++;
      }
    }

    return { expirados, fallidos };
  }

  /** El sponsor reclama el balance y el saldo vuelve al remitente. */
  async revertirClaim(claimId: string): Promise<void> {
    const claim = await this.claimRepo.obtenerPorId(claimId);
    if (!claim) throw new ClaimError("claim no encontrado");
    if (claim.status !== "pending") throw new ClaimError("claim no reversible");

    const transfer = await this.transferRepo.obtenerPorId(claim.transferId);
    if (!transfer) throw new ClaimError("transfer no encontrado");

    // 1. El sponsor reclama el balance (claimant de reverso)
    const result = await this.stellar.reclamarClaimableBalance({
      balanceId: claim.stellarBalanceId ?? "",
      claimant: claim.sponsorAccount,
      sponsor: claim.sponsorAccount,
    });

    // 2. Asientos: pending_claim -> wallet del remitente
    const senderWallet = await this.walletRepo.obtenerPorUsuario(transfer.senderUserId);
    if (!senderWallet) throw new ClaimError("wallet del remitente no encontrada");

    await this.ledger.crearGrupoBalanceado([
      {
        cuenta: { userId: null, walletId: null, accountType: "pending_claim" },
        direction: "debit",
        amount: transfer.amount,
        asset: transfer.asset,
        entryType: "reversal",
        referenceTransferId: transfer.id,
        referenceClaimId: claim.id,
      },
      {
        cuenta: {
          userId: transfer.senderUserId,
          walletId: senderWallet.id,
          accountType: "user_wallet",
        },
        direction: "credit",
        amount: transfer.amount,
        asset: transfer.asset,
        entryType: "reversal",
        referenceTransferId: transfer.id,
        referenceClaimId: claim.id,
      },
    ]);

    // 3. Estados finales
    await this.transferRepo.actualizarEstado(transfer.id, "reversed", {
      failureReason: "claim_expired",
      stellarClaimTxHash: result.txHash,
    });
    await this.claimRepo.actualizarEstado(claim.id, "expired");
  }
}
