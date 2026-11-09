import { query, queryOne } from "./db";
import type { TransferRepository, Transfer, ActualizarTransferOpts } from "../domain/transfer";

export class PostgresTransferRepository implements TransferRepository {
  async obtenerPorIdempotencyKey(key: string): Promise<Transfer | null> {
    const row = await queryOne("SELECT * FROM transfers WHERE idempotency_key = $1 LIMIT 1", [key]);
    return row ? mapRow(row) : null;
  }

  async obtenerPorId(id: string): Promise<Transfer | null> {
    const row = await queryOne("SELECT * FROM transfers WHERE id = $1 LIMIT 1", [id]);
    return row ? mapRow(row) : null;
  }

  async listarPorEstado(status: string): Promise<Transfer[]> {
    const rows = await query("SELECT * FROM transfers WHERE status = $1 ORDER BY created_at", [status]);
    return rows.map(mapRow);
  }

  async crear(data: {
    senderUserId: string;
    recipientUserId?: string | null;
    senderTag: string;
    recipientTag: string;
    amount: number;
    asset: string;
    type: string;
    status: string;
    idempotencyKey: string;
  }): Promise<Transfer> {
    const row = await queryOne(
      `INSERT INTO transfers (sender_user_id, recipient_user_id, sender_tag, recipient_tag, amount, asset, type, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        data.senderUserId,
        data.recipientUserId ?? null,
        data.senderTag,
        data.recipientTag,
        data.amount,
        data.asset,
        data.type,
        data.status,
        data.idempotencyKey,
      ],
    );
    return mapRow(row);
  }

  async actualizarEstado(id: string, status: string, opts: ActualizarTransferOpts = {}): Promise<void> {
    await query(
      `UPDATE transfers SET
         status = $2,
         stellar_create_tx_hash = COALESCE($3, stellar_create_tx_hash),
         stellar_claim_tx_hash = COALESCE($4, stellar_claim_tx_hash),
         failure_reason = COALESCE($5, failure_reason),
         completed_at = COALESCE($6, completed_at),
         recipient_user_id = COALESCE($7, recipient_user_id)
       WHERE id = $1`,
      [
        id,
        status,
        opts.stellarCreateTxHash ?? null,
        opts.stellarClaimTxHash ?? null,
        opts.failureReason ?? null,
        opts.completedAt ?? null,
        opts.recipientUserId ?? null,
      ],
    );
  }
}

function mapRow(row: any): Transfer {
  return {
    id: row.id,
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    senderTag: row.sender_tag,
    recipientTag: row.recipient_tag,
    amount: Number(row.amount),
    asset: row.asset,
    type: row.type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    stellarCreateTxHash: row.stellar_create_tx_hash,
    stellarClaimTxHash: row.stellar_claim_tx_hash,
    failureReason: row.failure_reason,
    completedAt: row.completed_at,
  };
}
