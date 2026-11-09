import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo, sufijo } from "./helpers";
import { buildContainer } from "../src/composition";
import crypto from "crypto";

async function crearRemitenteConSaldo(tag: string, email: string, monto = 500) {
  await query(
    `INSERT INTO users (id, tag, email, kyc_status, account_status)
     VALUES ($1,$2,$3,'approved','active')`,
    [crypto.randomUUID(), tag, email],
  );
  const user = await queryOne("SELECT id, tag FROM users WHERE tag = $1", [tag]);
  const wallet = await queryOne(
    `INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, status)
     VALUES ($1,'stellar',$2,'non_custodial','turnkey','active') RETURNING id`,
    [user.id, `G${sufijo()}`],
  );

  const { ledger } = buildContainer();
  await ledger.crearGrupo([
    {
      cuenta: { userId: null, walletId: null, accountType: "external" },
      direction: "debit",
      amount: monto,
      asset: "USDC",
      entryType: "ramp_in",
    },
    {
      cuenta: { userId: user.id, walletId: wallet.id, accountType: "user_wallet" },
      direction: "credit",
      amount: monto,
      asset: "USDC",
      entryType: "ramp_in",
    },
  ]);

  return { userId: user.id, tag: user.tag, walletId: wallet.id };
}

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 9 — Expiración y reverso", () => {
  it("claim vencido revierte el saldo al remitente y marca transfer=reversed / claim=expired", async () => {
    const { claims, expiration } = buildContainer();
    const remitente = await crearRemitenteConSaldo(
      `u.e1.${sufijo()}`,
      `e1.${sufijo()}@labkyc.test`,
    );

    const claim = await claims.crearClaim({
      senderId: remitente.userId,
      recipientTag: `u.e1.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    // El remitente tenía 500 USDC; tras enviar a claim quedan 450.
    const saldoAntes = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND wallet_id = $2 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [remitente.userId, remitente.walletId],
    );
    expect(Number(saldoAntes.balance_after)).toBe(450);

    // Forzar expiración
    await query(
      `UPDATE claims
       SET claimable_until = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE id = $1`,
      [claim.claimId],
    );

    const resultado = await expiration.expirarClaimsVencidos();
    expect(resultado.expirados).toBe(1);
    expect(resultado.fallidos).toBe(0);

    // Estados finales
    const claimRow = await queryOne("SELECT status FROM claims WHERE id = $1", [claim.claimId]);
    expect(claimRow.status).toBe("expired");

    const transferRow = await queryOne(
      "SELECT status, failure_reason FROM transfers WHERE id = $1",
      [claim.transferId],
    );
    expect(transferRow.status).toBe("reversed");
    expect(transferRow.failure_reason).toBe("claim_expired");

    // El saldo volvió al remitente
    const saldoDespues = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND wallet_id = $2 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [remitente.userId, remitente.walletId],
    );
    expect(Number(saldoDespues.balance_after)).toBe(500);

    // Asientos de reversal presentes
    const reversals = await queryOne(
      `SELECT count(*) AS c FROM ledger_entries
       WHERE reference_claim_id = $1 AND entry_type = 'reversal'`,
      [claim.claimId],
    );
    expect(Number(reversals.c)).toBe(2);

    // Invariante de suma cero intacto
    const descuadre = await queryOne(
      `SELECT asset FROM ledger_entries GROUP BY asset
       HAVING SUM(CASE WHEN direction='credit' THEN amount WHEN direction='debit' THEN -amount END) <> 0`,
    );
    expect(descuadre).toBeNull();
  });

  it("un claim vigente NO se revierte", async () => {
    const { claims, expiration } = buildContainer();
    const remitente = await crearRemitenteConSaldo(
      `u.e2.${sufijo()}`,
      `e2.${sufijo()}@labkyc.test`,
    );

    const claim = await claims.crearClaim({
      senderId: remitente.userId,
      recipientTag: `u.e2.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    const resultado = await expiration.expirarClaimsVencidos();
    expect(resultado.expirados).toBe(0);

    const claimRow = await queryOne("SELECT status FROM claims WHERE id = $1", [claim.claimId]);
    expect(claimRow.status).toBe("pending");
  });
});
