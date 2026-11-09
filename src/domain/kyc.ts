export class KYCError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KYCError";
  }
}

export interface KYCVerification {
  id: string;
  userId: string;
  diditSessionId: string;
  workflowId: string;
  sessionUrl?: string | null;
  status: string;
  decisionPayload?: unknown | null;
  declineReason?: string | null;
  sessionCreatedAt?: Date | null;
  resolvedAt?: Date | null;
  createdAt: Date;
}

export interface DiditClient {
  crearSesion(
    workflowId: string,
    vendorData: string,
    callback: string,
  ): Promise<{ sessionId: string; url: string }>;
}

export interface KYCVerificationRepository {
  crear(data: {
    userId: string;
    diditSessionId: string;
    workflowId: string;
    sessionUrl?: string | null;
    sessionCreatedAt?: Date | null;
  }): Promise<KYCVerification>;
  obtenerPorDiditSessionId(diditSessionId: string): Promise<KYCVerification | null>;
  obtenerSesionActivaPorUsuario(userId: string): Promise<KYCVerification | null>;
  actualizarEstado(
    id: string,
    estado: string,
    decisionPayload?: unknown | null,
    declineReason?: string | null,
  ): Promise<void>;
}

export interface WebhookEventRepository {
  crearSiNoExiste(data: {
    provider: string;
    eventId: string;
    eventType: string;
    payload: unknown;
    signatureValid: boolean;
    kycVerificationId?: string | null;
  }): Promise<{ creado: boolean; id?: string }>;
  marcarProcesado(id: string): Promise<void>;
}

/** Puerto que dispara la liberación de claims cuando el usuario aprueba KYC. */
export interface ClaimReleaser {
  dispararClaimsPendientes(userId: string): Promise<number>;
}
