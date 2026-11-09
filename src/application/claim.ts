import crypto from "crypto";
import { ClaimError } from "../domain/claim";
import type {
  ClaimRepository,
  StellarClient,
  UserRepository,
  WalletRepository,
  LedgerService,
  TransferRepository,
  KYCSessionStarter,
  ClaimReleaser,
} from "../domain/";

export const CLAIM_TOKEN_BYTES = Number(process.env.CLAIM_TOKEN_BYTES) || 32;
export const PENDING_LIMIT_USD = Number(process.env.PENDING_LIMIT_USD) || 200;
export const CLAIM_TTL_DAYS = Number(process.env.CLAIM_TTL_DAYS) || 30;

export interface CrearClaimInput {
  senderId: string;
  recipientTag: string;
  amount: number;
  asset: string;
  idempotencyKey: string;
  recipientEmail?: string | null;
}

export interface CrearClaimOutput {
  transferId: string;
  claimId: string;
  /** Token plano: se devuelve una sola vez, nunca se persiste. */
  claimToken: string;
  status: string;
}

export interface ResumenClaim {
  amount: number;
  asset: string;
  senderTag: string;
  status: string;
  expiresAt: Date;
}

export interface RedimirClaimInput {
  claimToken: string;
  email: string;
  phone?: string | null;
  tagDeseado?: string | null;
}

export interface RedimirClaimOutput {
  next: "kyc" | "completed";
  url?: string;
  claimId: string;
  userId: string;
}

export class ClaimUseCases implements ClaimReleaser {
  private kycStarter?: KYCSessionStarter;

  constructor(
    private claimRepo: ClaimRepository,
    private transferRepo: TransferRepository,
    private userRepo: UserRepository,
    private walletRepo: WalletRepository,
    private ledger: LedgerService,
    private stellar: StellarClient,
    private sponsorAccount: string,
  ) {}

  /**
   * Conecta el iniciador de KYC.
   *
   * KYC y Claims se referencian mutuamente (KYC dispara la liberación de claims;
   * el redeem de un claim inicia el KYC). Se resuelve con un setter en lugar de
   * dependencia circular en el constructor.
   */
  conectarKYCSessionStarter(starter: KYCSessionStarter): void {
    this.kycStarter = starter;
  }

  /** Crea un claim para un tag sin usuario registrado. */
  async crearClaim(input: CrearClaimInput): Promise<CrearClaimOutput> {
    // 1. Idempotencia
    const existente = await this.transferRepo.obtenerPorIdempotencyKey(input.idempotencyKey);
    if (existente) {
      const claim = await this.claimRepo.obtenerPorTransferId(existente.id);
      return {
        transferId: existente.id,
        claimId: claim?.id ?? "",
        claimToken: "", // el token plano nunca se revela dos veces
        status: existente.status,
      };
    }

    // 2. El destinatario NO debe existir todavía
    const usuarioExistente = await this.userRepo.obtenerPorTag(input.recipientTag.toLowerCase());
    if (usuarioExistente) throw new ClaimError("usa transferir_a_usuario");

    // 3. Validaciones del remitente
    const sender = await this.userRepo.obtenerPorId(input.senderId);
    if (!sender) throw new ClaimError("remitente no encontrado");
    if (sender.kyc_status !== "approved") throw new ClaimError("remitente sin KYC");
    if (sender.account_status !== "active") throw new ClaimError("cuenta suspendida");
    if (input.amount > PENDING_LIMIT_USD) {
      throw new ClaimError("monto excede límite para no registrados");
    }

    const saldo = await this.ledger.obtenerSaldo(input.senderId, input.asset);
    if (saldo < input.amount) throw new ClaimError("saldo insuficiente");

    // 4. Derivar claimant address determinísticamente desde el tag
    const claimantAddress = derivarAddressDesdeTag(input.recipientTag);

    // 5. Token plano: solo en memoria, en DB solo el hash
    const claimToken = crypto.randomBytes(CLAIM_TOKEN_BYTES).toString("hex");
    const claimTokenHash = hashClaimToken(claimToken);

    const claimableUntil = new Date(Date.now() + CLAIM_TTL_DAYS * 86400000);
    const expiresAt = new Date(Date.now() + CLAIM_TTL_DAYS * 86400000);

    // 6. Transfer en pending (todavía sin balance on-chain)
    const transfer = await this.transferRepo.crear({
      senderUserId: input.senderId,
      recipientUserId: null,
      senderTag: sender.tag,
      recipientTag: input.recipientTag.toLowerCase(),
      amount: input.amount,
      asset: input.asset,
      type: "internal_p2p",
      status: "pending",
      idempotencyKey: input.idempotencyKey,
    });

    // 7. Claim en estado pending
    const claim = await this.claimRepo.crear({
      transferId: transfer.id,
      claimTokenHash,
      sponsorAccount: this.sponsorAccount,
      claimantAccount: claimantAddress,
      claimableUntil,
      expiresAt,
    });

    // 8. Crear Claimable Balance on-chain
    try {
      const result = await this.stellar.crearClaimableBalanceSponsored({
        claimant: claimantAddress,
        sponsor: this.sponsorAccount,
        asset: input.asset,
        amount: input.amount,
        claimableUntil,
      });

      await this.claimRepo.actualizarBalanceId(claim.id, result.balanceId);
      await this.transferRepo.actualizarEstado(transfer.id, "pending_claim", {
        stellarCreateTxHash: result.txHash,
      });

      // 9. Asientos: remitente -> pending_claim (cuenta técnica)
      const senderWallet = await this.walletRepo.obtenerPorUsuario(input.senderId);
      if (!senderWallet) throw new ClaimError("wallet del remitente no encontrada");

      await this.ledger.crearGrupoBalanceado([
        {
          cuenta: { userId: input.senderId, walletId: senderWallet.id, accountType: "user_wallet" },
          direction: "debit",
          amount: input.amount,
          asset: input.asset,
          entryType: "transfer_out",
          referenceTransferId: transfer.id,
          referenceClaimId: claim.id,
        },
        {
          cuenta: { userId: null, walletId: null, accountType: "pending_claim" },
          direction: "credit",
          amount: input.amount,
          asset: input.asset,
          entryType: "transfer_in",
          referenceTransferId: transfer.id,
          referenceClaimId: claim.id,
        },
      ]);
    } catch (error: any) {
      await this.transferRepo.actualizarEstado(transfer.id, "failed", {
        failureReason: error?.message ?? String(error),
      });
      throw error;
    }

    return { transferId: transfer.id, claimId: claim.id, claimToken, status: "pending_claim" };
  }

  /** Vista pública del claim por token plano (rate-limited en la ruta). */
  async consultarClaim(claimToken: string): Promise<ResumenClaim> {
    const claim = await this.claimRepo.obtenerPorTokenHash(hashClaimToken(claimToken));
    if (!claim) throw new ClaimError("link inválido");
    const transfer = await this.transferRepo.obtenerPorId(claim.transferId);
    if (!transfer) throw new ClaimError("transfer no encontrado");
    return {
      amount: transfer.amount,
      asset: transfer.asset,
      senderTag: transfer.senderTag,
      status: claim.status,
      expiresAt: claim.expiresAt,
    };
  }

  /**
   * Redime un claim: crea/vincula el usuario, crea wallet y arranca el KYC.
   * Si el usuario ya tiene KYC aprobado, libera el claim inmediatamente.
   */
  async redimirClaim(input: RedimirClaimInput): Promise<RedimirClaimOutput> {
    // 1. Resolver claim por hash del token
    const claim = await this.claimRepo.obtenerPorTokenHash(hashClaimToken(input.claimToken));
    if (!claim) throw new ClaimError("link inválido");
    if (claim.status !== "pending") throw new ClaimError("claim ya usado o expirado");
    if (claim.expiresAt.getTime() <= Date.now()) throw new ClaimError("claim expirado");

    const transfer = await this.transferRepo.obtenerPorId(claim.transferId);
    if (!transfer) throw new ClaimError("transfer no encontrado");

    // 2. Usuario por demanda
    const email = input.email.toLowerCase();
    let user = await this.userRepo.obtenerPorEmail(email);
    if (!user) {
      const tag = input.tagDeseado ?? this.generarTagDesdeEmail(email);
      user = await this.userRepo.crear({
        id: crypto.randomUUID(),
        tag: { value: tag, normalizado: tag.toLowerCase() },
        email: { value: email, normalizado: email },
        phone_number: input.phone ?? null,
        kyc_status: "not_started",
        account_status: "active",
      });
    } else if (user.kyc_status === "approved") {
      throw new ClaimError("ya tienes cuenta verificada");
    }

    // 3. Vincular claim al usuario (aún sin liberar)
    await this.claimRepo.vincularUsuario(claim.id, user.id);

    // 4. Crear wallet si no tiene
    let wallet = await this.walletRepo.obtenerPorUsuario(user.id);
    if (!wallet) {
      wallet = await this.walletRepo.crear({
        userId: user.id,
        chain: "stellar",
        address: derivarAddressDesdeTag(`${user.tag}:${user.id}`),
        signingProvider: "turnkey",
        status: "pending_kyc",
      });
    }

    // 5. Si KYC no aprobado, iniciar KYC y esperar
    if (user.kyc_status !== "approved") {
      if (!this.kycStarter) throw new ClaimError("servicio de KYC no disponible");
      const kyc = await this.kycStarter.iniciarKYC({
        userId: user.id,
        callbackUrl: process.env.APP_URL ? `${process.env.APP_URL}/kyc/return` : "http://localhost:8000/kyc/return",
      });
      return { next: "kyc", url: kyc.url, claimId: claim.id, userId: user.id };
    }

    // 6. KYC ya aprobado: liberar inmediatamente
    await this.liberarClaim(claim.id);
    return { next: "completed", claimId: claim.id, userId: user.id };
  }

  /**
   * Libera un claim: claimClaimableBalance on-chain + asientos claim_release.
   * KYC aprobado y wallet activa son requisitos previos.
   */
  async liberarClaim(claimId: string): Promise<void> {
    const claim = await this.claimRepo.obtenerPorId(claimId);
    if (!claim) throw new ClaimError("claim no encontrado");
    if (claim.status !== "pending") throw new ClaimError("claim no liberable");

    const transfer = await this.transferRepo.obtenerPorId(claim.transferId);
    if (!transfer) throw new ClaimError("transfer no encontrado");

    if (!claim.claimedByUserId) throw new ClaimError("claim sin usuario vinculado");
    const user = await this.userRepo.obtenerPorId(claim.claimedByUserId);
    if (!user) throw new ClaimError("usuario no encontrado");
    if (user.kyc_status !== "approved") throw new ClaimError("KYC no aprobado");

    const wallet = await this.walletRepo.obtenerPorUsuario(user.id);
    if (!wallet || wallet.status !== "active") throw new ClaimError("wallet no activa");

    // 1. Ejecutar claimClaimableBalance on-chain (fee-bump del sponsor)
    const result = await this.stellar.reclamarClaimableBalance({
      balanceId: claim.stellarBalanceId ?? "",
      claimant: wallet.address,
      sponsor: claim.sponsorAccount,
    });

    await this.transferRepo.actualizarEstado(transfer.id, "claimed_onchain", {
      stellarClaimTxHash: result.txHash,
      recipientUserId: user.id,
    });

    // 2. Asientos: pending_claim -> wallet del destinatario
    await this.ledger.crearGrupoBalanceado([
      {
        cuenta: { userId: null, walletId: null, accountType: "pending_claim" },
        direction: "debit",
        amount: transfer.amount,
        asset: transfer.asset,
        entryType: "claim_release",
        referenceTransferId: transfer.id,
        referenceClaimId: claim.id,
      },
      {
        cuenta: { userId: user.id, walletId: wallet.id, accountType: "user_wallet" },
        direction: "credit",
        amount: transfer.amount,
        asset: transfer.asset,
        entryType: "claim_release",
        referenceTransferId: transfer.id,
        referenceClaimId: claim.id,
      },
    ]);

    // 3. Marcar completado
    await this.transferRepo.actualizarEstado(transfer.id, "completed", {
      completedAt: new Date(),
      recipientUserId: user.id,
    });
    await this.claimRepo.actualizarEstado(claim.id, "claimed", user.id, new Date());
  }

  /** Invocado desde el webhook Didit Approved. */
  async dispararClaimsPendientes(userId: string): Promise<number> {
    const claims = await this.claimRepo.listarPendientesPorUsuario(userId);
    let liberados = 0;
    for (const claim of claims) {
      try {
        await this.liberarClaim(claim.id);
        liberados++;
      } catch {
        // Un claim fallido no debe bloquear a los demás: el job de reconciliación reintenta.
      }
    }
    return liberados;
  }

  private generarTagDesdeEmail(email: string): string {
    const base = email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9._]/g, "")
      .slice(0, 12);
    const sufijo = crypto.randomBytes(3).toString("hex");
    return `${base || "user"}.${sufijo}`.slice(0, 20);
  }
}

export function hashClaimToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Deriva una address Stellar determinística desde un tag.
 *
 * Algoritmo: sha256(tag) → 32 bytes de payload → strkey "G".
 * Formato strkey: version byte (0x30 = cuenta) + payload(32) + checksum CRC16(2)
 * codificado en base32 → 56 caracteres, exactamente como una address de Stellar.
 */
export function derivarAddressDesdeTag(tag: string): string {
  const hash = crypto.createHash("sha256").update(tag).digest();
  const versioned = Buffer.concat([Buffer.from([0x30]), hash.subarray(0, 32)]);

  const checksum = Buffer.alloc(2);
  checksum.writeUInt16LE(crc16(versioned), 0);
  const data = Buffer.concat([versioned, checksum]);

  // Base32 (RFC 4648, sin padding) — 35 bytes => 56 caracteres exactos.
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32[(value << (5 - bits)) & 31];
  return output;
}

function crc16(data: Buffer): number {
  let crc = 0x0000;
  for (const byte of data) {
    let code = (crc >>> 8) & 0xff;
    code ^= byte & 0xff;
    code ^= code >>> 4;
    crc = (crc << 8) & 0xffff;
    crc ^= code;
    code = (code << 5) & 0xffff;
    crc ^= code;
    code = (code << 7) & 0xffff;
    crc ^= code;
  }
  return crc & 0xffff;
}
