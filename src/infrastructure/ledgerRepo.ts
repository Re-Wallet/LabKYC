import crypto from "crypto";
import { queryOne, transaction } from "./db";
import type { LedgerService, AsientoInput } from "../domain/ledger";

type SaldosEnMemoria = Map<string, number>;

function claveCuenta(cuenta: AsientoInput["cuenta"], asset: string): string {
  return `${cuenta.accountType}:${cuenta.userId ?? "null"}:${cuenta.walletId ?? "null"}:${asset}`;
}

/**
 * Inserta un asiento dentro de una transacción abierta.
 *
 * - Toma el lock consultivo por cuenta+asset (pg_advisory_xact_lock) para evitar
 *   race conditions sobre balance_after.
 * - Si se pasa `saldosEnMemoria`, el saldo se deriva del acumulado en la misma
 *   transacción (necesario porque now() es constante dentro de una transacción,
 *   y varios asientos de la misma cuenta comparten timestamp).
 */
async function crearAsientoDentroTx(
  conn: any,
  input: AsientoInput,
  saldosEnMemoria?: SaldosEnMemoria,
): Promise<void> {
  const lockKey = hashString(claveCuenta(input.cuenta, input.asset));
  await conn.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);

  const clave = claveCuenta(input.cuenta, input.asset);
  let saldoActual: number;

  if (saldosEnMemoria?.has(clave)) {
    saldoActual = saldosEnMemoria.get(clave)!;
  } else {
    const row = await conn.query(
      `SELECT balance_after FROM ledger_entries
       WHERE (user_id IS NOT DISTINCT FROM $1) AND (wallet_id IS NOT DISTINCT FROM $2)
         AND account_type = $3 AND asset = $4
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.cuenta.userId ?? null, input.cuenta.walletId ?? null, input.cuenta.accountType, input.asset]
    );
    saldoActual = row.rows[0]?.balance_after !== undefined ? Number(row.rows[0].balance_after) : 0;
  }

  const amount = Number(input.amount);
  if (!(amount > 0)) throw new Error("amount debe ser positivo");

  const nuevoSaldo = input.direction === "credit" ? saldoActual + amount : saldoActual - amount;
  saldosEnMemoria?.set(clave, nuevoSaldo);

  await conn.query(
    `INSERT INTO ledger_entries (
      transaction_group_id, user_id, wallet_id, account_type, direction,
      amount, asset, balance_after, entry_type,
      reference_transfer_id, reference_claim_id, reference_external_id,
      created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, clock_timestamp())`,
    [
      input.grupoId,
      input.cuenta.userId ?? null,
      input.cuenta.walletId ?? null,
      input.cuenta.accountType,
      input.direction,
      amount,
      input.asset,
      nuevoSaldo,
      input.entryType,
      input.referenceTransferId ?? null,
      input.referenceClaimId ?? null,
      input.referenceExternalId ?? null,
    ]
  );
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

export class PostgresLedgerService implements LedgerService {
  /** Saldo disponible (último balance_after) de la wallet de un usuario. */
  async obtenerSaldo(userId: string, asset: string): Promise<number> {
    const row = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet' AND asset = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, asset]
    );
    return row ? Number(row.balance_after) : 0;
  }

  async querySaldo(userId: string, asset: string): Promise<number | undefined> {
    return this.obtenerSaldo(userId, asset);
  }

  async crearAsiento(input: AsientoInput): Promise<void> {
    await transaction(async (conn) => {
      await crearAsientoDentroTx(conn, input);
    });
  }

  /**
   * Crea un grupo de asientos balanceado por asset dentro de UNA transacción.
   * Si cualquier asiento falla, se revierte el grupo completo.
   */
  async crearGrupoBalanceado(asientos: Omit<AsientoInput, "grupoId">[]): Promise<string> {
    const grupoId = crypto.randomUUID();

    // Validación de balanceo por asset antes de tocar la DB
    const porAsset = new Map<string, { credit: number; debit: number }>();
    for (const a of asientos) {
      const amt = Number(a.amount);
      if (!porAsset.has(a.asset)) porAsset.set(a.asset, { credit: 0, debit: 0 });
      const cur = porAsset.get(a.asset)!;
      if (a.direction === "credit") cur.credit += amt;
      else cur.debit += amt;
    }
    for (const [asset, cur] of porAsset) {
      if (Math.abs(cur.credit - cur.debit) > 0.00000001) {
        throw new Error(`grupo descuadrado para asset ${asset}: credit=${cur.credit} debit=${cur.debit}`);
      }
    }

    const saldos: SaldosEnMemoria = new Map();
    await transaction(async (conn) => {
      for (const a of asientos) {
        await crearAsientoDentroTx(conn, { ...a, grupoId }, saldos);
      }
    });

    // Verificación final del invariante dentro del grupo
    const descuadre = await queryOne(
      `SELECT asset FROM ledger_entries WHERE transaction_group_id = $1
       GROUP BY asset
       HAVING SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount END) <> 0`,
      [grupoId]
    );
    if (descuadre) {
      throw new Error(`grupo descuadrado en DB: asset=${descuadre.asset}`);
    }

    return grupoId;
  }
}
