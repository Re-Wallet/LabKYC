export interface LedgerService {
  crearAsiento(input: AsientoInput): Promise<void>;
  crearGrupoBalanceado(asientos: Omit<AsientoInput, "grupoId">[]): Promise<string>;
  obtenerSaldo(userId: string, asset: string): Promise<number>;
}

export interface AsientoInput {
  grupoId: string;
  cuenta: { userId?: string | null; walletId?: string | null; accountType: string };
  direction: "debit" | "credit";
  amount: number | string;
  asset: string;
  entryType: string;
  referenceTransferId?: string | null;
  referenceClaimId?: string | null;
  referenceExternalId?: string | null;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}
