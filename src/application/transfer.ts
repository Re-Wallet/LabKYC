import { TransferError } from "../domain/transfer";
import type { TransferRepository } from "../domain/transfer";
import type { UserRepository } from "../domain/ports";
import type { WalletRepository } from "../domain/wallet";
import type { LedgerService } from "../domain/ledger";
import type { ComplianceLimits } from "../domain/transfer";

export interface TransferirInput {
  senderId: string;
  recipientTag: string;
  amount: number;
  asset: string;
  idempotencyKey: string;
}

export interface TransferirOutput {
  transferId: string;
  status: string;
}

export class TransferUseCases {
  constructor(
    private transferRepo: TransferRepository,
    private userRepo: UserRepository,
    private walletRepo: WalletRepository,
    private ledger: LedgerService,
    private compliance: ComplianceLimits,
  ) {}

  async transferir(input: TransferirInput): Promise<TransferirOutput> {
    // 1. Idempotencia
    const existente = await this.transferRepo.obtenerPorIdempotencyKey(input.idempotencyKey);
    if (existente) {
      return { transferId: existente.id, status: existente.status };
    }

    // 2. Resolver destinatario por tag (case-insensitive)
    const recipient = await this.userRepo.obtenerPorTag(input.recipientTag.toLowerCase());
    if (!recipient) throw new TransferError("usuario no encontrado");
    if (recipient.id === input.senderId) throw new TransferError("no puedes enviarte a ti mismo");

    // 3. Validar KYC y estado de cuenta de ambos
    const sender = await this.userRepo.obtenerPorId(input.senderId);
    if (!sender) throw new TransferError("remitente no encontrado");
    if (sender.kyc_status !== "approved") throw new TransferError("remitente sin KYC");
    if (recipient.kyc_status !== "approved") throw new TransferError("destinatario sin KYC");
    if (sender.account_status !== "active") throw new TransferError("cuenta suspendida");
    if (recipient.account_status !== "active") throw new TransferError("destinatario suspendido");

    // 4. Saldo suficiente
    const saldo = await this.ledger.obtenerSaldo(input.senderId, input.asset);
    if (saldo < input.amount) throw new TransferError("saldo insuficiente");

    // 5. Límites de compliance
    await this.compliance.validarLimites(input.senderId, input.amount, input.asset);

    // 6. Wallets
    const senderWallet = await this.walletRepo.obtenerPorUsuario(input.senderId);
    const recipientWallet = await this.walletRepo.obtenerPorUsuario(recipient.id);
    if (!senderWallet || !recipientWallet) throw new TransferError("wallet no encontrada");

    // 7. Transfer + asientos
    const transfer = await this.transferRepo.crear({
      senderUserId: input.senderId,
      recipientUserId: recipient.id,
      senderTag: sender.tag,
      recipientTag: recipient.tag,
      amount: input.amount,
      asset: input.asset,
      type: "internal_p2p",
      status: "completed",
      idempotencyKey: input.idempotencyKey,
    });

    await this.ledger.crearGrupoBalanceado([
      {
        cuenta: { userId: input.senderId, walletId: senderWallet.id, accountType: "user_wallet" },
        direction: "debit",
        amount: input.amount,
        asset: input.asset,
        entryType: "transfer_out",
        referenceTransferId: transfer.id,
      },
      {
        cuenta: { userId: recipient.id, walletId: recipientWallet.id, accountType: "user_wallet" },
        direction: "credit",
        amount: input.amount,
        asset: input.asset,
        entryType: "transfer_in",
        referenceTransferId: transfer.id,
      },
    ]);

    await this.transferRepo.actualizarEstado(transfer.id, "completed", { completedAt: new Date() });

    // 8. Métricas de compliance
    await this.compliance.actualizarVolumen(input.senderId, input.amount, input.asset);
    await this.compliance.actualizarVolumen(recipient.id, input.amount, input.asset);

    return { transferId: transfer.id, status: transfer.status };
  }
}
