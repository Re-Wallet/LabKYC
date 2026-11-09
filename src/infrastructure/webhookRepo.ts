import { query, queryOne } from "./db";
import type { WebhookEventRepository } from "../domain/kyc";

export class PostgresWebhookEventRepository implements WebhookEventRepository {
  async crearSiNoExiste(data: {
    provider: string;
    eventId: string;
    eventType: string;
    payload: any;
    signatureValid: boolean;
    kycVerificationId?: string | null;
  }): Promise<{ creado: boolean; id?: string }> {
    // ON CONFLICT DO NOTHING y verificar si se insertó
    const row = await queryOne(
      `INSERT INTO webhook_events (provider, event_id, event_type, payload, signature_valid, kyc_verification_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [data.provider, data.eventId, data.eventType, JSON.stringify(data.payload), data.signatureValid, data.kycVerificationId ?? null]
    );
    if (row) return { creado: true, id: row.id };
    return { creado: false };
  }

  async marcarProcesado(id: string): Promise<void> {
    await query("UPDATE webhook_events SET processed_at = now() WHERE id = $1", [id]);
  }
}
