export interface Wallet {
  id: string;
  userId: string;
  chain: string;
  address: string;
  custodyType: string;
  signingProvider: string;
  turnkeySubOrgId?: string | null;
  status: string;
}

export interface WalletRepository {
  crear(data: {
    userId: string;
    chain?: string;
    address: string;
    signingProvider: string;
    turnkeySubOrgId?: string | null;
    status: string;
  }): Promise<Wallet>;
  obtenerPorUsuarioYChain(userId: string, chain: string): Promise<Wallet | null>;
  obtenerPorUsuario(userId: string): Promise<Wallet | null>;
  activarWalletsPendientes(userId: string): Promise<void>;
  obtenerPorId(id: string): Promise<Wallet | null>;
}
