export interface Claim {
  id: string;
  transferId: string;
  claimTokenHash: string;
  stellarBalanceId?: string | null;
  sponsorAccount: string;
  claimantAccount: string;
  status: string;
  claimableUntil: Date;
  expiresAt: Date;
  claimedByUserId?: string | null;
  claimedAt?: Date | null;
}

export interface ClaimRepository {
  crear(data: {
    transferId: string;
    claimTokenHash: string;
    sponsorAccount: string;
    claimantAccount: string;
    claimableUntil: Date;
    expiresAt: Date;
  }): Promise<Claim>;
  obtenerPorTokenHash(hash: string): Promise<Claim | null>;
  obtenerPorId(id: string): Promise<Claim | null>;
  obtenerPorTransferId(transferId: string): Promise<Claim | null>;
  listarPendientesPorUsuario(userId: string): Promise<Claim[]>;
  listarVencidos(ahora: Date): Promise<Claim[]>;
  listarHuerfanos(): Promise<Claim[]>;
  vincularUsuario(claimId: string, userId: string): Promise<void>;
  actualizarEstado(
    id: string,
    status: string,
    claimedByUserId?: string | null,
    claimedAt?: Date | null,
  ): Promise<void>;
  actualizarBalanceId(id: string, stellarBalanceId: string): Promise<void>;
}

export interface StellarClient {
  crearClaimableBalanceSponsored(params: {
    claimant: string;
    sponsor: string;
    asset: string;
    amount: number;
    claimableUntil: Date;
  }): Promise<{ balanceId: string; txHash: string }>;
  reclamarClaimableBalance(params: {
    balanceId: string;
    claimant: string;
    sponsor: string;
  }): Promise<{ txHash: string }>;
  obtenerEstadoTransaccion(txHash: string): Promise<{ successful: boolean }>;
  existeClaimableBalance(balanceId: string): Promise<{ exists: boolean; lastModifiedTx?: string }>;
}

/** Puerto para iniciar KYC desde el flujo de reclamo (evita dependencia circular). */
export interface KYCSessionStarter {
  iniciarKYC(input: { userId: string; callbackUrl: string }): Promise<{ verificationId: string; url: string }>;
}

/** Puerto que dispara la liberación de claims cuando el usuario aprueba KYC. */
export interface ClaimReleaser {
  dispararClaimsPendientes(userId: string): Promise<number>;
}

export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}
