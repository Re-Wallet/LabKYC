import crypto from "crypto";
import { KYCError } from "../domain/kyc";
import type {
  KYCVerificationRepository,
  DiditClient,
  WebhookEventRepository,
  ClaimReleaser,
} from "../domain/kyc";
import type { UserRepository, DatosKYC } from "../domain/ports";
import type { WalletRepository } from "../domain/wallet";

export interface IniciarKYCInput {
  userId: string;
  callbackUrl: string;
}

export interface IniciarKYCOutput {
  verificationId: string;
  url: string;
}

export interface ProcesarWebhookInput {
  rawBody: string;
  signatureHeader?: string | null;
  timestampHeader?: string | null;
}

export class KYCUseCases {
  constructor(
    private kycRepo: KYCVerificationRepository,
    private webhookRepo: WebhookEventRepository,
    private didit: DiditClient,
    private userRepo: UserRepository,
    private walletRepo: WalletRepository,
    private workflowId: string,
    private webhookSecret: string,
    private claimReleaser?: ClaimReleaser,
  ) {}

  async iniciarKYC(input: IniciarKYCInput): Promise<IniciarKYCOutput> {
    const user = await this.userRepo.obtenerPorId(input.userId);
    if (!user) throw new KYCError("usuario no encontrado");

    // Reutilizar sesión activa para evitar duplicar en Didit
    const sesionActiva = await this.kycRepo.obtenerSesionActivaPorUsuario(input.userId);
    if (sesionActiva) {
      return { verificationId: sesionActiva.id, url: sesionActiva.sessionUrl! };
    }

    const respuesta = await this.didit.crearSesion(this.workflowId, input.userId, input.callbackUrl);

    const verification = await this.kycRepo.crear({
      userId: input.userId,
      diditSessionId: respuesta.sessionId,
      workflowId: this.workflowId,
      sessionUrl: respuesta.url,
    });

    await this.userRepo.actualizarKycStatus(input.userId, "in_progress");

    return { verificationId: verification.id, url: respuesta.url };
  }

  async procesarWebhook(input: ProcesarWebhookInput): Promise<{ procesado: boolean; eventId?: string }> {
    // 1. Validar timestamp (rechazar entregas con X-Timestamp > 300 segundos antiguos)
    if (input.timestampHeader) {
      const ts = parseInt(input.timestampHeader, 10);
      if (isNaN(ts)) return { procesado: false, eventId: undefined };
      const ahora = Math.floor(Date.now() / 1000);
      if (ahora - ts > 300) return { procesado: false, eventId: undefined }; // > 5 min antiguo
    }

    // 2. Validar firma PRIMERO (nunca confiar en el body sin verificar)
    const firmaOk = this.verificarFirma(input.rawBody, input.signatureHeader ?? null);

    // 2. Parsear payload
    let payload: any;
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      throw new KYCError("body inválido");
    }

    const eventId = payload.event_id;
    const eventType = payload.event_type;

    // 3. Persistir el evento siempre (auditoría) e idempotencia por (provider, event_id)
    const resultado = await this.webhookRepo.crearSiNoExiste({
      provider: "didit",
      eventId,
      eventType,
      payload,
      signatureValid: firmaOk,
    });

    if (!resultado.creado) {
      return { procesado: false, eventId }; // duplicado: salir sin reprocesar
    }

    // 4. Firma inválida: el evento queda guardado pero no se procesa la lógica
    if (!firmaOk) {
      await this.webhookRepo.marcarProcesado(resultado.id!);
      return { procesado: false, eventId };
    }

    // 5. Procesar según tipo
    if (eventType === "status.updated") {
      await this.procesarCambioEstado(payload);
    }

    await this.webhookRepo.marcarProcesado(resultado.id!);
    return { procesado: true, eventId };
  }

  private verificarFirma(rawBody: string, signatureHeader?: string | null): boolean {
    if (!signatureHeader) return false;
    try {
      const hmac = crypto.createHmac("sha256", this.webhookSecret);
      hmac.update(rawBody);
      const esperado = hmac.digest("hex");
      const recibido = signatureHeader.replace(/^sha256=/, "");
      if (recibido.length !== esperado.length) return false;
      return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(recibido));
    } catch {
      return false;
    }
  }

  private async procesarCambioEstado(payload: any): Promise<void> {
    const sessionId = payload.session_id;
    const nuevoStatus = payload.status;

    const verification = await this.kycRepo.obtenerPorDiditSessionId(sessionId);
    if (!verification) return;

    await this.kycRepo.actualizarEstado(
      verification.id,
      nuevoStatus,
      payload.decision ?? null,
      nuevoStatus === "Declined" ? payload.decline_reason ?? null : null,
    );

    const userId = verification.userId;

    if (nuevoStatus === "Approved") {
      // Extraer y actualizar datos OCR
      const idV = payload.decision?.id_verifications?.[0];
      if (idV) {
        const datos: DatosKYC = {
          fullName: idV.full_name ?? idV.fullName ?? null,
          dateOfBirth: idV.date_of_birth ?? idV.dateOfBirth ?? null,
          documentType: idV.document_type ?? idV.documentType ?? null,
          documentNumber: idV.document_number ?? idV.documentNumber ?? null,
          documentExpiry: idV.expiration_date ?? idV.expirationDate ?? null,
          nationality: idV.nationality ?? null,
        };
        await this.userRepo.actualizarDatosKYC(userId, datos);
      }

      await this.userRepo.actualizarKycStatus(userId, "approved");

      // Activar wallet si estaba pendiente
      await this.walletRepo.activarWalletsPendientes(userId);

      // Disparar claims pendientes esperando este KYC
      await this.claimReleaser?.dispararClaimsPendientes(userId);
    } else if (nuevoStatus === "Declined") {
      await this.userRepo.actualizarKycStatus(userId, "declined");
    } else if (nuevoStatus === "In Review") {
      await this.userRepo.actualizarKycStatus(userId, "in_review");
    }
  }
}
