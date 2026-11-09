/** Helpers compartidos de tests: limpieza respetando el orden de FKs. */
import { query } from "../src/infrastructure/db";

/**
 * Limpia todas las tablas de datos del lab en el orden correcto de FKs.
 * ledger_entries -> claims -> kyc_verifications -> transfers -> wallets -> users
 */
export async function limpiarTodo(): Promise<void> {
  await query("DELETE FROM ledger_entries");
  await query("DELETE FROM claims");
  await query("DELETE FROM kyc_verifications");
  await query("DELETE FROM fee_charges");
  await query("DELETE FROM transfers");
  await query("DELETE FROM wallets");
  await query("DELETE FROM tag_history");
  await query("DELETE FROM compliance_profiles");
  await query("DELETE FROM users");
  await query("DELETE FROM webhook_events");
}

export function sufijo(): string {
  return Math.random().toString(36).slice(2, 8);
}
