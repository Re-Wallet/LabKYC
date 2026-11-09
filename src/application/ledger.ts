import type { LedgerService, AsientoInput } from "../domain/ledger";

export class LedgerUseCases {
  constructor(private ledger: LedgerService) {}

  async crearGrupo(asientos: Omit<AsientoInput, "grupoId">[]): Promise<string> {
    return this.ledger.crearGrupoBalanceado(asientos);
  }

  async crearAsiento(input: AsientoInput): Promise<void> {
    return this.ledger.crearAsiento(input);
  }
}
