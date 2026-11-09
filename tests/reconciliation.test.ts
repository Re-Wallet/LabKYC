import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo, sufijo } from "./helpers";
import { buildContainer } from "../src/composition";
import crypto from "crypto";

async function crearUsuarioMinimo(): Promise<string> {
  const tag = `u.rc.${sufijo()}`;
  await query(
    `INSERT INTO users (id, tag, email, kyc_status, account_status)
     VALUES ($1,$2,$3,'approved','active')`,
    [crypto.randomUUID(), tag, `rc.${sufijo()}@labkyc.test`],
  );
  const user = await queryOne("SELECT id FROM users WHERE tag = $1", [tag]);
  return user.id;
}

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 10 — Reconciliación on-chain", () => {
  it("un transfer en claimed_onchain con tx exitosa pasa a completed", async () => {
    // Un único contenedor: el cliente Stellar es compartido entrecasos de uso y reconciliación.
    const { reconciliation, stellar } = buildContainer();
    const senderId = await crearUsuarioMinimo();

    const { txHash } = await stellar.crearClaimableBalanceSponsored({
      claimant: "GCLAIMANT",
      sponsor: "GSPONSOR",
      asset: "USDC",
      amount: 10,
      claimableUntil: new Date(Date.now() + 86400000),
    });

    const transfer = await queryOne(
      `INSERT INTO transfers (sender_user_id, sender_tag, recipient_tag, amount, asset, type, status, idempotency_key, stellar_claim_tx_hash)
       VALUES ($1,'origen','destino',10,'USDC','internal_p2p','claimed_onchain',$2,$3)
       RETURNING id`,
      [senderId, `idem_${sufijo()}`, txHash],
    );
    expect(transfer.id).toBeDefined();

    const resultado = await reconciliation.reconciliar();
    expect(resultado.completadas).toBe(1);

    const row = await queryOne("SELECT status, completed_at FROM transfers WHERE id = $1", [
      transfer.id,
    ]);
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();
  });

  it("un claim huérfano (balance_id con transfer pending) se reconcilia a pending_claim", async () => {
    const { reconciliation, stellar } = buildContainer();
    const senderId = await crearUsuarioMinimo();

    const { balanceId } = await stellar.crearClaimableBalanceSponsored({
      claimant: "GCLAIMANT",
      sponsor: "GSPONSOR",
      asset: "USDC",
      amount: 25,
      claimableUntil: new Date(Date.now() + 86400000),
    });

    const transfer = await queryOne(
      `INSERT INTO transfers (sender_user_id, sender_tag, recipient_tag, amount, asset, type, status, idempotency_key)
       VALUES ($1,'origen','destino',25,'USDC','internal_p2p','pending',$2)
       RETURNING id`,
      [senderId, `idem_${sufijo()}`],
    );

    await query(
      `INSERT INTO claims (transfer_id, claim_token_hash, sponsor_account, claimant_account, status, claimable_until, expires_at, stellar_balance_id)
       VALUES ($1,$2,'GSPONSOR','GCLAIMANT','pending', now() + interval '30 days', now() + interval '30 days', $3)`,
      [transfer.id, `hash_${sufijo()}`, balanceId],
    );

    const resultado = await reconciliation.reconciliar();
    expect(resultado.huerfanos).toBe(1);

    const row = await queryOne("SELECT status FROM transfers WHERE id = $1", [transfer.id]);
    expect(row.status).toBe("pending_claim");
  });
});
