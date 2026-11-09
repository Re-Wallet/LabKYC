export interface Transfer {
  id: string;
  senderUserId: string;
  recipientUserId?: string | null;
  senderTag: string;
  recipientTag: string;
  amount: number;
  asset: string;
  type: string;
  status: string;
  idempotencyKey: string;
  stellarCreateTxHash?: string | null;
  stellarClaimTxHash?: string | null;
  failureReason?: string | null;
  completedAt?: Date | null;
}

export interface ActualizarTransferOpts {
  stellarCreateTxHash?: string | null;
  stellarClaimTxHash?: string | null;
  failureReason?: string | null;
  completedAt?: Date | null;
  recipientUserId?: string | null;
}

export interface TransferRepository {
  obtenerPorIdempotencyKey(key: string): Promise<Transfer | null>;
  obtenerPorId(id: string): Promise<Transfer | null>;
  listarPorEstado(status: string): Promise<Transfer[]>;
  crear(data: {
    senderUserId: string;
    recipientUserId?: string | null;
    senderTag: string;
    recipientTag: string;
    amount: number;
    asset: string;
    type: string;
    status: string;
    idempotencyKey: string;
  }): Promise<Transfer>;
  actualizarEstado(id: string, status: string, opts?: ActualizarTransferOpts): Promise<void>;
}

export interface ComplianceLimits {
  validarLimites(userId: string, amount: number, asset: string): Promise<void>;
  actualizarVolumen(userId: string, amount: number, asset: string): Promise<void>;
}

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
  }
}
