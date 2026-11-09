import { query, queryOne } from "./db";
import type { ComplianceProfileRepository } from "../domain/ports";
import type { ComplianceLimits } from "../domain/transfer";

export const PENDING_LIMIT_USD = Number(process.env.PENDING_LIMIT_USD) || 200;

/** Límite mensual simplificado para el lab (en producción: KYC tier + policy engine). */
const MONTHLY_LIMIT_USD = 10000;

export class PostgresComplianceProfileRepository
  implements ComplianceProfileRepository, ComplianceLimits
{
  async crearParaUsuario(userId: string): Promise<void> {
    await query(
      "INSERT INTO compliance_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
  }

  async validarLimites(userId: string, amount: number, _asset: string): Promise<void> {
    const perfil = await queryOne(
      "SELECT monthly_volume_usd, sanctions_hit FROM compliance_profiles WHERE user_id = $1",
      [userId],
    );
    if (!perfil) return;
    if (perfil.sanctions_hit) throw new Error("cuenta con hit de sanciones");
    if (Number(perfil.monthly_volume_usd) + amount > MONTHLY_LIMIT_USD) {
      throw new Error("excede el límite mensual de compliance");
    }
  }

  async actualizarVolumen(userId: string, amount: number, _asset: string): Promise<void> {
    await query(
      `UPDATE compliance_profiles
       SET cumulative_volume_usd = cumulative_volume_usd + $2,
           monthly_volume_usd    = monthly_volume_usd + $2,
           transaction_count     = transaction_count + 1,
           updated_at            = now()
       WHERE user_id = $1`,
      [userId, amount],
    );
  }
}
