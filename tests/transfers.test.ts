import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo } from "./helpers";
import { TransferUseCases } from "../src/application/transfer";
import { PostgresTransferRepository } from "../src/infrastructure/transferRepo";
import { PostgresUserRepository } from "../src/infrastructure/userRepo";
import { PostgresWalletRepository } from "../src/infrastructure/walletRepo";
import { PostgresLedgerService } from "../src/infrastructure/ledgerRepo";
import { PostgresComplianceProfileRepository } from "../src/infrastructure/complianceRepo";

const transferUseCases = new TransferUseCases(
  new PostgresTransferRepository(),
  new PostgresUserRepository(),
  new PostgresWalletRepository(),
  new PostgresLedgerService(),
  new PostgresComplianceProfileRepository()
);

function sufijo() { return Math.random().toString(36).slice(2, 8); }

async function crearUsuarioKYC(tag: string, email: string) {
  await query("INSERT INTO users (id, tag, email, kyc_status, account_status) VALUES ($1,$2,$3,'approved','active')",
    [crypto.randomUUID(), tag, email]);
  const user = await queryOne("SELECT id, tag FROM users WHERE tag = $1", [tag]);
  const wallet = await queryOne(
    "INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, status) VALUES ($1,'stellar',$2,'non_custodial','turnkey','active') RETURNING id",
    [user.id, `G${sufijo()}`]
  );
  return { userId: user.id, tag: user.tag, walletId: wallet.id };
}

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 6 — Transfer P2P a usuario existente", () => {
  it("transfer exitosa con idempotencia", async () => {
    const a = await crearUsuarioKYC(`u.t2.a.${sufijo()}`, `ta2.${sufijo()}@labkyc.test`);
    const b = await crearUsuarioKYC(`u.t2.b.${sufijo()}`, `tb2.${sufijo()}@labkyc.test`);

    const ledger = new PostgresLedgerService();
    await ledger.crearGrupoBalanceado([
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 500, asset: "USDC", entryType: "ramp_in" },
      { cuenta: { userId: a.userId, walletId: a.walletId, accountType: "user_wallet" }, direction: "credit", amount: 500, asset: "USDC", entryType: "ramp_in" },
    ]);

    const key = `idem_${sufijo()}`;
    const r1 = await transferUseCases.transferir({
      senderId: a.userId, recipientTag: b.tag, amount: 100, asset: "USDC", idempotencyKey: key,
    });

    const r2 = await transferUseCases.transferir({
      senderId: a.userId, recipientTag: b.tag, amount: 100, asset: "USDC", idempotencyKey: key,
    });

    expect(r1.transferId).toBe(r2.transferId);
    expect(r1.status).toBe("completed");

    const count = await queryOne("SELECT count(*) AS c FROM transfers WHERE idempotency_key = $1", [key]);
    expect(Number(count.c)).toBe(1);
  });

  it("saldo insuficiente", async () => {
    const a = await crearUsuarioKYC(`u.t3.a.${sufijo()}`, `ta3.${sufijo()}@labkyc.test`);
    const b = await crearUsuarioKYC(`u.t3.b.${sufijo()}`, `tb3.${sufijo()}@labkyc.test`);

    await expect(
      transferUseCases.transferir({
        senderId: a.userId, recipientTag: b.tag, amount: 1000, asset: "USDC", idempotencyKey: `idem_${sufijo()}`,
      })
    ).rejects.toThrow(/saldo insuficiente/);
  });

  it("destinatario sin KYC", async () => {
    const a = await crearUsuarioKYC(`u.t4.a.${sufijo()}`, `ta4.${sufijo()}@labkyc.test`);
    const tagB = `u.t4.b.${sufijo()}`;
    await query("INSERT INTO users (id, tag, email, kyc_status, account_status) VALUES ($1,$2,$3,'not_started','active')",
      [crypto.randomUUID(), tagB, `tb4.${sufijo()}@labkyc.test`]);

    const ledger = new PostgresLedgerService();
    await ledger.crearGrupoBalanceado([
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 500, asset: "USDC", entryType: "ramp_in" },
      { cuenta: { userId: a.userId, walletId: a.walletId, accountType: "user_wallet" }, direction: "credit", amount: 500, asset: "USDC", entryType: "ramp_in" },
    ]);

    await expect(
      transferUseCases.transferir({
        senderId: a.userId, recipientTag: tagB, amount: 100, asset: "USDC", idempotencyKey: `idem_${sufijo()}`,
      })
    ).rejects.toThrow(/sin KYC/);
  });

  it("invariante suma cero después de transfer", async () => {
    const a = await crearUsuarioKYC(`u.t5.a.${sufijo()}`, `ta5.${sufijo()}@labkyc.test`);
    const b = await crearUsuarioKYC(`u.t5.b.${sufijo()}`, `tb5.${sufijo()}@labkyc.test`);

    const ledger = new PostgresLedgerService();
    await ledger.crearGrupoBalanceado([
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 500, asset: "USDC", entryType: "ramp_in" },
      { cuenta: { userId: a.userId, walletId: a.walletId, accountType: "user_wallet" }, direction: "credit", amount: 500, asset: "USDC", entryType: "ramp_in" },
    ]);

    await transferUseCases.transferir({
      senderId: a.userId, recipientTag: b.tag, amount: 100, asset: "USDC", idempotencyKey: `idem_${sufijo()}`,
    });

    const descuadre = await queryOne(
      `SELECT asset FROM ledger_entries GROUP BY asset HAVING SUM(CASE WHEN direction='credit' THEN amount WHEN direction='debit' THEN -amount END) <> 0`
    );
    expect(descuadre).toBeNull();
  });
});
