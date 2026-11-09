import { query, queryOne } from "./db";
import type { KYCVerification, KYCVerificationRepository } from "../domain/kyc";

export class PostgresKYCVerificationRepository implements KYCVerificationRepository {
  async crear(data: {
    userId: string;
    diditSessionId: string;
    workflowId: string;
    sessionUrl?: string | null;
    sessionCreatedAt?: Date | null;
  }): Promise<KYCVerification> {
    const row = await queryOne(
      `INSERT INTO kyc_verifications (user_id, didit_session_id, workflow_id, session_url, session_created_at, status)
       VALUES ($1,$2,$3,$4,$5,'In Progress')
       RETURNING *`,
      [
        data.userId,
        data.diditSessionId,
        data.workflowId,
        data.sessionUrl ?? null,
        data.sessionCreatedAt ?? null,
      ],
    );
    return mapRow(row);
  }

  async obtenerPorDiditSessionId(diditSessionId: string): Promise<KYCVerification | null> {
    const row = await queryOne(
      "SELECT * FROM kyc_verifications WHERE didit_session_id = $1 LIMIT 1",
      [diditSessionId],
    );
    return row ? mapRow(row) : null;
  }

  async obtenerSesionActivaPorUsuario(userId: string): Promise<KYCVerification | null> {
    const row = await queryOne(
      `SELECT * FROM kyc_verifications
       WHERE user_id = $1 AND status = 'In Progress'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return row ? mapRow(row) : null;
  }

  async actualizarEstado(
    id: string,
    estado: string,
    decisionPayload?: unknown | null,
    declineReason?: string | null,
  ): Promise<void> {
    await query(
      `UPDATE kyc_verifications
       SET status = $2, decision_payload = $3, decline_reason = $4, resolved_at = now()
       WHERE id = $1`,
      [id, estado, decisionPayload ?? null, declineReason ?? null],
    );
  }
}

function mapRow(row: any): KYCVerification {
  return {
    id: row.id,
    userId: row.user_id,
    diditSessionId: row.didit_session_id,
    workflowId: row.workflow_id,
    sessionUrl: row.session_url,
    status: row.status,
    decisionPayload: row.decision_payload,
    declineReason: row.decline_reason,
    sessionCreatedAt: row.session_created_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}
