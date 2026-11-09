import { query, queryOne } from "./db";
import type { ClaimRepository, Claim } from "../domain/claim";

export class PostgresClaimRepository implements ClaimRepository {
  async crear(data: {
    transferId: string;
    claimTokenHash: string;
    sponsorAccount: string;
    claimantAccount: string;
    claimableUntil: Date;
    expiresAt: Date;
  }): Promise<Claim> {
    const row = await queryOne(
      `INSERT INTO claims (transfer_id, claim_token_hash, sponsor_account, claimant_account, status, claimable_until, expires_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6)
       RETURNING id, transfer_id, claim_token_hash, stellar_balance_id, sponsor_account, claimant_account,
                 status, claimable_until, expires_at, claimed_by_user_id, claimed_at`,
      [
        data.transferId,
        data.claimTokenHash,
        data.sponsorAccount,
        data.claimantAccount,
        data.claimableUntil,
        data.expiresAt,
      ],
    );
    return mapRow(row);
  }

  async obtenerPorTokenHash(hash: string): Promise<Claim | null> {
    const row = await queryOne("SELECT * FROM claims WHERE claim_token_hash = $1 LIMIT 1", [hash]);
    return row ? mapRow(row) : null;
  }

  async obtenerPorId(id: string): Promise<Claim | null> {
    const row = await queryOne("SELECT * FROM claims WHERE id = $1 LIMIT 1", [id]);
    return row ? mapRow(row) : null;
  }

  async obtenerPorTransferId(transferId: string): Promise<Claim | null> {
    const row = await queryOne("SELECT * FROM claims WHERE transfer_id = $1 LIMIT 1", [transferId]);
    return row ? mapRow(row) : null;
  }

  async listarPendientesPorUsuario(userId: string): Promise<Claim[]> {
    const rows = await query(
      `SELECT * FROM claims
       WHERE claimed_by_user_id = $1 AND status = 'pending' AND expires_at > now()
       ORDER BY created_at`,
      [userId],
    );
    return rows.map(mapRow);
  }

  async listarVencidos(ahora: Date): Promise<Claim[]> {
    const rows = await query(
      `SELECT * FROM claims WHERE status = 'pending' AND expires_at <= $1 ORDER BY created_at`,
      [ahora],
    );
    return rows.map(mapRow);
  }

  async listarHuerfanos(): Promise<Claim[]> {
    const rows = await query(
      `SELECT c.* FROM claims c
       JOIN transfers t ON t.id = c.transfer_id
       WHERE c.stellar_balance_id IS NOT NULL AND t.status = 'pending'
       ORDER BY c.created_at`,
    );
    return rows.map(mapRow);
  }

  async vincularUsuario(claimId: string, userId: string): Promise<void> {
    await query("UPDATE claims SET claimed_by_user_id = $2 WHERE id = $1", [claimId, userId]);
  }

  async actualizarEstado(
    id: string,
    status: string,
    claimedByUserId?: string | null,
    claimedAt?: Date | null,
  ): Promise<void> {
    await query(
      "UPDATE claims SET status = $2, claimed_by_user_id = COALESCE($3, claimed_by_user_id), claimed_at = COALESCE($4, claimed_at) WHERE id = $1",
      [id, status, claimedByUserId ?? null, claimedAt ?? null],
    );
  }

  async actualizarBalanceId(id: string, stellarBalanceId: string): Promise<void> {
    await query("UPDATE claims SET stellar_balance_id = $2 WHERE id = $1", [id, stellarBalanceId]);
  }
}

function mapRow(row: any): Claim {
  return {
    id: row.id,
    transferId: row.transfer_id,
    claimTokenHash: row.claim_token_hash,
    stellarBalanceId: row.stellar_balance_id,
    sponsorAccount: row.sponsor_account,
    claimantAccount: row.claimant_account,
    status: row.status,
    claimableUntil: row.claimable_until,
    expiresAt: row.expires_at,
    claimedByUserId: row.claimed_by_user_id,
    claimedAt: row.claimed_at,
  };
}
