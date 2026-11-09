/**
 * Contenedor de composición (composition root).
 *
 * Punto único donde se conectan los casos de uso con sus adaptadores.
 * Las rutas y los tests consumen este contenedor, de modo que el wiring
 * (incluida la dependencia circular KYC <-> Claims) queda en un solo lugar.
 */
import { ClaimUseCases } from "./application/claim";
import { KYCUseCases } from "./application/kyc";
import { TransferUseCases } from "./application/transfer";
import { FeeUseCases } from "./application/fee";
import { ExpiracionUseCases } from "./application/expiration";
import { ReconciliacionUseCases } from "./application/reconciliation";
import { LedgerUseCases } from "./application/ledger";
import { RegistrarUsuarioUseCase } from "./application/users";

import { PostgresClaimRepository } from "./infrastructure/claimRepo";
import { PostgresTransferRepository } from "./infrastructure/transferRepo";
import { PostgresUserRepository } from "./infrastructure/userRepo";
import { PostgresWalletRepository } from "./infrastructure/walletRepo";
import { PostgresKYCVerificationRepository } from "./infrastructure/kycRepo";
import { PostgresWebhookEventRepository } from "./infrastructure/webhookRepo";
import { PostgresComplianceProfileRepository } from "./infrastructure/complianceRepo";
import { PostgresTagHistoryRepository } from "./infrastructure/tagHistoryRepo";
import { PostgresLedgerService } from "./infrastructure/ledgerRepo";
import { PostgresFeeRepository } from "./infrastructure/feeRepo";
import { DiditMockClient } from "./infrastructure/diditClient";
import { StellarMockClient } from "./infrastructure/stellarClient";

export interface Container {
  registrarUsuario: RegistrarUsuarioUseCase;
  kyc: KYCUseCases;
  claims: ClaimUseCases;
  transfers: TransferUseCases;
  fees: FeeUseCases;
  expiration: ExpiracionUseCases;
  reconciliation: ReconciliacionUseCases;
  ledger: LedgerUseCases;
  stellar: StellarMockClient;
}

export interface ContainerOptions {
  stellar?: StellarMockClient;
  sponsorAccount?: string;
  workflowId?: string;
  webhookSecret?: string;
}

export function buildContainer(options: ContainerOptions = {}): Container {
  const stellar = options.stellar ?? new StellarMockClient();
  const sponsorAccount =
    options.sponsorAccount ??
    process.env.STELLAR_SPONSOR_PUBLIC_KEY ??
    "GSPONSOR0000000000000000000000000000000000000000000000000000";

  const claimRepo = new PostgresClaimRepository();
  const transferRepo = new PostgresTransferRepository();
  const userRepo = new PostgresUserRepository();
  const walletRepo = new PostgresWalletRepository();
  const kycRepo = new PostgresKYCVerificationRepository();
  const webhookRepo = new PostgresWebhookEventRepository();
  const complianceRepo = new PostgresComplianceProfileRepository();
  const tagHistoryRepo = new PostgresTagHistoryRepository();
  const ledgerService = new PostgresLedgerService();
  const feeRepo = new PostgresFeeRepository();

  const claims = new ClaimUseCases(
    claimRepo,
    transferRepo,
    userRepo,
    walletRepo,
    ledgerService,
    stellar,
    sponsorAccount,
  );

  const kyc = new KYCUseCases(
    kycRepo,
    webhookRepo,
    new DiditMockClient(),
    userRepo,
    walletRepo,
    options.workflowId ?? process.env.DIDIT_WORKFLOW_ID ?? "workflow_test",
    options.webhookSecret ?? process.env.DIDIT_WEBHOOK_SECRET ?? "secret_test",
    claims, // al aprobar KYC dispara la liberación de claims pendientes
  );

  // Cierra la dependencia circular: el redeem de un claim puede iniciar el KYC.
  claims.conectarKYCSessionStarter(kyc);

  return {
    registrarUsuario: new RegistrarUsuarioUseCase(userRepo, complianceRepo, tagHistoryRepo),
    kyc,
    claims,
    transfers: new TransferUseCases(
      transferRepo,
      userRepo,
      walletRepo,
      ledgerService,
      complianceRepo,
    ),
    fees: new FeeUseCases(feeRepo),
    expiration: new ExpiracionUseCases(
      claimRepo,
      transferRepo,
      walletRepo,
      ledgerService,
      stellar,
    ),
    reconciliation: new ReconciliacionUseCases(transferRepo, claimRepo, stellar),
    ledger: new LedgerUseCases(ledgerService),
    stellar,
  };
}
