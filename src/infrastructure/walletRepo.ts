import { query, queryOne } from "./db";
import type { WalletRepository, Wallet } from "../domain/wallet";

export class PostgresWalletRepository implements WalletRepository {
  async crear(data: {
    userId: string;
    chain?: string;
    address: string;
    signingProvider: string;
    turnkeySubOrgId?: string | null;
    status: string;
  }): Promise<Wallet> {
    const row = await queryOne(
      `INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, turnkey_sub_org_id, status)
       VALUES ($1,$2,$3,'non_custodial',$4,$5,$6)
       RETURNING id, user_id, chain, address, custody_type, signing_provider, turnkey_sub_org_id, status`,
      [data.userId, data.chain ?? "stellar", data.address, data.signingProvider, data.turnkeySubOrgId ?? null, data.status]
    );
    return this.mapRow(row);
  }

  async obtenerPorUsuarioYChain(userId: string, chain: string): Promise<Wallet | null> {
    const row = await queryOne(
      "SELECT * FROM wallets WHERE user_id = $1 AND chain = $2 LIMIT 1",
      [userId, chain]
    );
    return row ? this.mapRow(row) : null;
  }

  async obtenerPorUsuario(userId: string): Promise<Wallet | null> {
    const row = await queryOne(
      "SELECT * FROM wallets WHERE user_id = $1 LIMIT 1",
      [userId]
    );
    return row ? this.mapRow(row) : null;
  }

  async obtenerPorId(id: string): Promise<Wallet | null> {
    const row = await queryOne("SELECT * FROM wallets WHERE id = $1 LIMIT 1", [id]);
    return row ? this.mapRow(row) : null;
  }

  async activarWalletsPendientes(userId: string): Promise<void> {
    await query(
      "UPDATE wallets SET status = 'active' WHERE user_id = $1 AND status = 'pending_kyc'",
      [userId]
    );
  }

  private mapRow(row: any): Wallet {
    return {
      id: row.id,
      userId: row.user_id,
      chain: row.chain,
      address: row.address,
      custodyType: row.custody_type,
      signingProvider: row.signing_provider,
      turnkeySubOrgId: row.turnkey_sub_org_id,
      status: row.status,
    };
  }
}
