import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo } from "./helpers";
import { ClaimUseCases } from "../src/application/claim";
import { PostgresClaimRepository } from "../src/infrastructure/claimRepo";
import { PostgresTransferRepository } from "../src/infrastructure/transferRepo";
import { PostgresUserRepository } from "../src/infrastructure/userRepo";
import { PostgresWalletRepository } from "../src/infrastructure/walletRepo";
import { PostgresLedgerService } from "../src/infrastructure/ledgerRepo";
import { StellarMockClient } from "../src/infrastructure/stellarClient";

const claimUseCases = new ClaimUseCases(
  new PostgresClaimRepository(),
  new PostgresTransferRepository(),
  new PostgresUserRepository(),
  new PostgresWalletRepository(),
  new PostgresLedgerService(),
  new StellarMockClient(),
  "GSPONSOR0000000000000000000000000000000000000000000000000000"
);

function sufijo() { return Math.random().toString(36).slice(2, 8); }

async function crearUsuarioKYC(tag: string, email: string) {
  await query("INSERT INTO users (id, tag, email, kyc_status, account_status) VALUES ($1,$2,$3,'approved','active')",
    [crypto.randomUUID(), tag, email]);
  const user = await queryOne("SELECT id FROM users WHERE tag = $1", [tag]);
  const wallet = await queryOne(
    "INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, status) VALUES ($1,'stellar',$2,'non_custodial','turnkey','active') RETURNING id",
    [user.id, `G${sufijo()}`]
  );
  return { userId: user.id, walletId: wallet.id };
}

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 7 — Transfer a tag sin usuario (Claimable Balance)", () => {
  it("crear claim: no crea usuario, transfer en pending_claim, claim_token devuelto", async () => {
    const sender = await crearUsuarioKYC(`u.c.a.${sufijo()}`, `ca.${sufijo()}@labkyc.test`);

    const ledger = new PostgresLedgerService();
    await ledger.crearGrupoBalanceado([
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 500, asset: "USDC", entryType: "ramp_in" },
      { cuenta: { userId: sender.userId, walletId: sender.walletId, accountType: "user_wallet" }, direction: "credit", amount: 500, asset: "USDC", entryType: "ramp_in" },
    ]);

    const tagDestino = `u.c.destino.${sufijo()}`;
    const resultado = await claimUseCases.crearClaim({
      senderId: sender.userId,
      recipientTag: tagDestino,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    expect(resultado.status).toBe("pending_claim");
    expect(resultado.claimToken).toBeDefined();
    expect(resultado.claimToken.length).toBeGreaterThan(0);

    // No se creó usuario para el destinatario
    const usuarioDestino = await queryOne("SELECT 1 FROM users WHERE lower(tag) = $1", [tagDestino.toLowerCase()]);
    expect(usuarioDestino).toBeNull();

    // transfer tiene recipient_user_id NULL
    const transfer = await queryOne("SELECT recipient_user_id, status FROM transfers WHERE id = $1", [resultado.transferId]);
    expect(transfer.recipient_user_id).toBeNull();
    expect(transfer.status).toBe("pending_claim");

    // claim existe con hash del token (no el token plano)
    const claim = await queryOne("SELECT claim_token_hash FROM claims WHERE id = $1", [resultado.claimId]);
    expect(claim.claim_token_hash).toBeDefined();
    expect(claim.claim_token_hash).not.toBe(resultado.claimToken);
  });

  it("no permite enviar a usuario existente", async () => {
    const sender = await crearUsuarioKYC(`u.c2.a.${sufijo()}`, `ca2.${sufijo()}@labkyc.test`);
    const tagDestino = `u.c2.b.${sufijo()}`;
    await query("INSERT INTO users (id, tag, email, kyc_status, account_status) VALUES ($1,$2,$3,'approved','active')",
      [crypto.randomUUID(), tagDestino, `cb2.${sufijo()}@labkyc.test`]);

    const ledger = new PostgresLedgerService();
    await ledger.crearGrupoBalanceado([
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 500, asset: "USDC", entryType: "ramp_in" },
      { cuenta: { userId: sender.userId, walletId: sender.walletId, accountType: "user_wallet" }, direction: "credit", amount: 500, asset: "USDC", entryType: "ramp_in" },
    ]);

    await expect(
      claimUseCases.crearClaim({
        senderId: sender.userId,
        recipientTag: tagDestino,
        amount: 50,
        asset: "USDC",
        idempotencyKey: `idem_${sufijo()}`,
      })
    ).rejects.toThrow(/usa transferir_a_usuario/);
  });

  it("invariante suma cero después de crear claim", async () => {
    const sender = await crearUsuarioKYC(`u.c3.a.${sufijo()}`, `ca3.${sufijo()}@labkyc.test`);

    const ledger = new PostgresLedgerService();
    await ledger.crearGrupoBalanceado([
      { cuenta: { userId: null, walletId: null, accountType: "external" }, direction: "debit", amount: 500, asset: "USDC", entryType: "ramp_in" },
      { cuenta: { userId: sender.userId, walletId: sender.walletId, accountType: "user_wallet" }, direction: "credit", amount: 500, asset: "USDC", entryType: "ramp_in" },
    ]);

    await claimUseCases.crearClaim({
      senderId: sender.userId,
      recipientTag: `u.c3.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    const descuadre = await queryOne(
      `SELECT asset FROM ledger_entries GROUP BY asset HAVING SUM(CASE WHEN direction='credit' THEN amount WHEN direction='debit' THEN -amount END) <> 0`
    );
    expect(descuadre).toBeNull();
  });
});
