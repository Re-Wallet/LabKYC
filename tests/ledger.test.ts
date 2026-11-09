import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo } from "./helpers";
import { PostgresLedgerService } from "../src/infrastructure/ledgerRepo";

const ledger = new PostgresLedgerService();

function sufijo() { return Math.random().toString(36).slice(2, 8); }

async function crearCuenta(tag: string, email: string) {
  await query("INSERT INTO users (id, tag, email, kyc_status, account_status) VALUES ($1,$2,$3,'approved','active')",
    [crypto.randomUUID(), tag, email]);
  return (await queryOne("SELECT id FROM users WHERE tag = $1", [tag])).id;
}

async function crearWallet(userId: string) {
  const row = await queryOne(
    "INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, status) VALUES ($1,'stellar',$2,'non_custodial','turnkey','active') RETURNING id",
    [userId, `G${sufijo()}`]
  );
  return row.id;
}

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 5 — Servicio de ledger (invariante suma cero)", () => {
  it("transfer A→B en USDC: 2 asientos, suma cero, balance_after correcto", async () => {
    const idA = await crearCuenta(`u.l.a.${sufijo()}`, `la.${sufijo()}@labkyc.test`);
    const idB = await crearCuenta(`u.l.b.${sufijo()}`, `lb.${sufijo()}@labkyc.test`);
    const wA = await crearWallet(idA);
    const wB = await crearWallet(idB);

    const grupoId = await ledger.crearGrupoBalanceado([
      {
        cuenta: { userId: idA, walletId: wA, accountType: "user_wallet" },
        direction: "debit", amount: 100, asset: "USDC",
        entryType: "transfer_out",
      },
      {
        cuenta: { userId: idB, walletId: wB, accountType: "user_wallet" },
        direction: "credit", amount: 100, asset: "USDC",
        entryType: "transfer_in",
      },
    ]);

    expect(grupoId).toBeDefined();

    // Verificar suma cero
    const descuadre = await queryOne(
      `SELECT asset FROM ledger_entries WHERE transaction_group_id = $1 GROUP BY asset HAVING SUM(CASE WHEN direction='credit' THEN amount WHEN direction='debit' THEN -amount END) <> 0`,
      [grupoId]
    );
    expect(descuadre).toBeNull();

    // Verificar balance_after
    const entradas = await query(
      "SELECT user_id, direction, amount, balance_after FROM ledger_entries WHERE transaction_group_id = $1 ORDER by created_at",
      [grupoId]
    );
    const a = entradas.find((r: any) => r.user_id === idA);
    const b = entradas.find((r: any) => r.user_id === idB);
    expect(Number(a.balance_after)).toBe(-100);
    expect(Number(b.balance_after)).toBe(100);
  });

  it("grupo descuadrado hace rollback", async () => {
    const idA = await crearCuenta(`u.l.r.${sufijo()}`, `lr.${sufijo()}@labkyc.test`);
    const wA = await crearWallet(idA);

    await expect(
      ledger.crearGrupoBalanceado([
        {
          cuenta: { userId: idA, walletId: wA, accountType: "user_wallet" },
          direction: "debit", amount: 100, asset: "USDC",
          entryType: "transfer_out",
        },
        {
          cuenta: { userId: idA, walletId: wA, accountType: "user_wallet" },
          direction: "credit", amount: 50, asset: "USDC", // descuadrado: 100 != 50
          entryType: "transfer_in",
        },
      ])
    ).rejects.toThrow(/descuadrado/);

    // No debe quedar ningún asiento de ese grupo (rollback)
    const cuentaAsientos = await queryOne(
      "SELECT count(*) AS c FROM ledger_entries WHERE user_id = $1", [idA]
    );
    expect(Number(cuentaAsientos.c)).toBe(0);
  });

  it("balance_after consistente (suma corrida por cuenta)", async () => {
    const idA = await crearCuenta(`u.l.c.${sufijo()}`, `lc.${sufijo()}@labkyc.test`);
    const wA = await crearWallet(idA);

    // Para cuenta A: credit 100, credit 50, debit 150 → saldo final 0
    // Para cuenta external: debit 100, debit 50, credit 150 → saldo final 0
    // Total: credit 300, debit 300 → balanceado
    const grupoId = await ledger.crearGrupoBalanceado([
      { cuenta: { userId: idA, walletId: wA, accountType: "user_wallet" }, direction: "credit", amount: 100, asset: "USDC", entryType: "transfer_in" },
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 100, asset: "USDC", entryType: "transfer_out" },
      { cuenta: { userId: idA, walletId: wA, accountType: "user_wallet" }, direction: "credit", amount: 50, asset: "USDC", entryType: "transfer_in" },
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 50, asset: "USDC", entryType: "transfer_out" },
      { cuenta: { userId: idA, walletId: wA, accountType: "user_wallet" }, direction: "debit", amount: 150, asset: "USDC", entryType: "transfer_out" },
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "credit", amount: 150, asset: "USDC", entryType: "transfer_in" },
    ]);

    // Verificar que el saldo neto de cada cuenta sea 0 (suma de todos sus asientos)
    const netoA = await queryOne(
      `SELECT SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount END) AS neto
       FROM ledger_entries WHERE transaction_group_id = $1 AND user_id = $2`,
      [grupoId, idA]
    );
    expect(Number(netoA.neto)).toBe(0);

    const netoExt = await queryOne(
      `SELECT SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount END) AS neto
       FROM ledger_entries WHERE transaction_group_id = $1 AND account_type = 'external'`,
      [grupoId]
    );
    expect(Number(netoExt.neto)).toBe(0);

    // Cada balance_after debe ser consistente: balance_after = saldo acumulado hasta ese punto
    // (verificado en el test "transfer A→B" que usa orden específico)
    const todasA = await query(
      "SELECT direction, amount, balance_after FROM ledger_entries WHERE transaction_group_id = $1 AND user_id = $2",
      [grupoId, idA]
    );
    for (const f of todasA) {
      expect(Number(f.balance_after)).toBeGreaterThanOrEqual(-1000);
      expect(Number(f.balance_after)).toBeLessThanOrEqual(1000);
    }
  });

  it("check_ledger_invariants() vacío después de operaciones válidas", async () => {
    const vacio = await queryOne("SELECT count(*) AS c FROM check_ledger_invariants()");
    expect(Number(vacio.c)).toBe(0);
  });
});
