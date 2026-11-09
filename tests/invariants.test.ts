/**
 * Tests de invariantes obligatorios (CI bloqueante) del brief.
 *
 * Los 10 tests exigidos por el brief, con los nombres canónicos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo, sufijo } from "./helpers";
import { buildContainer } from "../src/composition";
import crypto from "crypto";

async function crearUsuario(
  opts: { tag: string; email: string; kyc?: string; saldo?: number; chain?: string },
) {
  const kyc = opts.kyc ?? "approved";
  await query(
    `INSERT INTO users (id, tag, email, kyc_status, account_status)
     VALUES ($1,$2,$3,$4,'active')`,
    [crypto.randomUUID(), opts.tag, opts.email, kyc],
  );
  const user = await queryOne("SELECT id, tag, email, kyc_status FROM users WHERE tag = $1", [
    opts.tag,
  ]);
  const wallet = await queryOne(
    `INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, status)
     VALUES ($1,$2,$3,'non_custodial','turnkey',$4) RETURNING id`,
    [
      user.id,
      opts.chain ?? "stellar",
      `G${sufijo()}`,
      kyc === "approved" ? "active" : "pending_kyc",
    ],
  );

  if (opts.saldo && opts.saldo > 0) {
    const { ledger } = buildContainer();
    await ledger.crearGrupo([
      {
        cuenta: { userId: null, walletId: null, accountType: "external" },
        direction: "debit",
        amount: opts.saldo,
        asset: "USDC",
        entryType: "ramp_in",
      },
      {
        cuenta: { userId: user.id, walletId: wallet.id, accountType: "user_wallet" },
        direction: "credit",
        amount: opts.saldo,
        asset: "USDC",
        entryType: "ramp_in",
      },
    ]);
  }

  return { userId: user.id, tag: user.tag, walletId: wallet.id };
}

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Invariantes obligatorios del brief", () => {
  it("1. test_suma_cero_todos_los_grupos", async () => {
    // Generar operaciones válidas de varios módulos
    const { claims, transfers } = buildContainer();

    const a = await crearUsuario({
      tag: `u.i1.a.${sufijo()}`,
      email: `i1a.${sufijo()}@labkyc.test`,
      saldo: 1000,
    });
    const b = await crearUsuario({
      tag: `u.i1.b.${sufijo()}`,
      email: `i1b.${sufijo()}@labkyc.test`,
      saldo: 100,
    });

    await transfers.transferir({
      senderId: a.userId,
      recipientTag: b.tag,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    await claims.crearClaim({
      senderId: a.userId,
      recipientTag: `u.i1.nuevo.${sufijo()}`,
      amount: 100,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    const descuadres = await query("SELECT * FROM check_ledger_invariants()");
    expect(descuadres).toEqual([]);
  });

  it("2. test_balance_after_consistente", async () => {
    const a = await crearUsuario({
      tag: `u.i2.${sufijo()}`,
      email: `i2.${sufijo()}@labkyc.test`,
      saldo: 300,
    });

    // balance_after debe coincidir con la suma corrida de los asientos de la cuenta
    const filas = await query(
      `SELECT direction, amount, balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet'
       ORDER BY created_at, id`,
      [a.userId],
    );
    expect(filas.length).toBeGreaterThan(0);

    let saldo = 0;
    for (const f of filas) {
      saldo += f.direction === "credit" ? Number(f.amount) : -Number(f.amount);
      expect(Number(f.balance_after)).toBe(saldo);
    }
    expect(saldo).toBe(300);
  });

  it("3. test_idempotencia_transfers", async () => {
    const { transfers } = buildContainer();
    const a = await crearUsuario({
      tag: `u.i3.a.${sufijo()}`,
      email: `i3a.${sufijo()}@labkyc.test`,
      saldo: 500,
    });
    const b = await crearUsuario({
      tag: `u.i3.b.${sufijo()}`,
      email: `i3b.${sufijo()}@labkyc.test`,
    });

    const key = "test-001";
    const r1 = await transfers.transferir({
      senderId: a.userId,
      recipientTag: b.tag,
      amount: 25,
      asset: "USDC",
      idempotencyKey: key,
    });
    const r2 = await transfers.transferir({
      senderId: a.userId,
      recipientTag: b.tag,
      amount: 25,
      asset: "USDC",
      idempotencyKey: key,
    });

    expect(r1.transferId).toBe(r2.transferId);

    const count = await queryOne("SELECT count(*) AS c FROM transfers WHERE idempotency_key = $1", [
      key,
    ]);
    expect(Number(count.c)).toBe(1);

    // Y el saldo del destinatario se acreditó una sola vez
    const saldoB = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [b.userId],
    );
    expect(Number(saldoB.balance_after)).toBe(25);
  });

  it("4. test_idempotencia_webhook", async () => {
    const { kyc } = buildContainer({ webhookSecret: "secret_test" });
    const user = await crearUsuario({
      tag: `u.i4.${sufijo()}`,
      email: `i4.${sufijo()}@labkyc.test`,
      kyc: "not_started",
    });

    await kyc.iniciarKYC({ userId: user.userId, callbackUrl: "https://app.local/kyc/return" });
    const verification = await queryOne(
      "SELECT didit_session_id FROM kyc_verifications WHERE user_id = $1 LIMIT 1",
      [user.userId],
    );

    const payload = {
      event_id: `evt_${sufijo()}`,
      event_type: "status.updated",
      session_id: verification.didit_session_id,
      status: "In Progress",
      decision: {},
    };
    const raw = JSON.stringify(payload);
    const sig = `sha256=${crypto.createHmac("sha256", "secret_test").update(raw).digest("hex")}`;

    await kyc.procesarWebhook({ rawBody: raw, signatureHeader: sig });
    await kyc.procesarWebhook({ rawBody: raw, signatureHeader: sig });

    const count = await queryOne(
      "SELECT count(*) AS c FROM webhook_events WHERE provider = 'didit' AND event_id = $1",
      [payload.event_id],
    );
    expect(Number(count.c)).toBe(1);
  });

  it("5. test_kyc_gate_claim: KYC declined NO libera el claim", async () => {
    const { claims, kyc } = buildContainer({ webhookSecret: "secret_test" });
    const a = await crearUsuario({
      tag: `u.i5.a.${sufijo()}`,
      email: `i5a.${sufijo()}@labkyc.test`,
      saldo: 500,
    });

    const claim = await claims.crearClaim({
      senderId: a.userId,
      recipientTag: `u.i5.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    // B se registra y queda con KYC pendiente
    const redeem = await claims.redimirClaim({
      claimToken: claim.claimToken,
      email: `i5b.${sufijo()}@labkyc.test`,
    });
    expect(redeem.next).toBe("kyc");

    // Webhook Declined
    const verification = await queryOne(
      "SELECT didit_session_id FROM kyc_verifications WHERE user_id = $1 LIMIT 1",
      [redeem.userId],
    );
    const payload = {
      event_id: `evt_${sufijo()}`,
      event_type: "status.updated",
      session_id: verification.didit_session_id,
      status: "Declined",
      decision: {},
    };
    const raw = JSON.stringify(payload);
    const sig = `sha256=${crypto.createHmac("sha256", "secret_test").update(raw).digest("hex")}`;
    await kyc.procesarWebhook({ rawBody: raw, signatureHeader: sig });

    // El claim NO se liberó
    const claimRow = await queryOne("SELECT status FROM claims WHERE id = $1", [claim.claimId]);
    expect(claimRow.status).toBe("pending");

    const transferRow = await queryOne("SELECT status FROM transfers WHERE id = $1", [
      claim.transferId,
    ]);
    expect(transferRow.status).toBe("pending_claim");

    const release = await queryOne(
      "SELECT count(*) AS c FROM ledger_entries WHERE reference_claim_id = $1 AND entry_type = 'claim_release'",
      [claim.claimId],
    );
    expect(Number(release.c)).toBe(0);
  });

  it("6. test_pending_claim_no_crea_usuario", async () => {
    const { claims } = buildContainer();
    const a = await crearUsuario({
      tag: `u.i6.a.${sufijo()}`,
      email: `i6a.${sufijo()}@labkyc.test`,
      saldo: 500,
    });

    const tagDestino = `u.i6.nuevo.${sufijo()}`;
    const claim = await claims.crearClaim({
      senderId: a.userId,
      recipientTag: tagDestino,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    const usuario = await queryOne("SELECT 1 FROM users WHERE lower(tag) = $1", [
      tagDestino.toLowerCase(),
    ]);
    expect(usuario).toBeNull();

    const transfer = await queryOne(
      "SELECT recipient_user_id, status FROM transfers WHERE id = $1",
      [claim.transferId],
    );
    expect(transfer.recipient_user_id).toBeNull();
    expect(transfer.status).toBe("pending_claim");
  });

  it("7. test_expiracion_revierte: el saldo vuelve al remitente", async () => {
    const { claims, expiration } = buildContainer();
    const a = await crearUsuario({
      tag: `u.i7.${sufijo()}`,
      email: `i7.${sufijo()}@labkyc.test`,
      saldo: 500,
    });

    const claim = await claims.crearClaim({
      senderId: a.userId,
      recipientTag: `u.i7.destino.${sufijo()}`,
      amount: 100,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    const saldoInicial = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [a.userId],
    );
    expect(Number(saldoInicial.balance_after)).toBe(400);

    await query(
      `UPDATE claims
       SET claimable_until = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE id = $1`,
      [claim.claimId],
    );

    await expiration.expirarClaimsVencidos();

    const saldoFinal = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [a.userId],
    );
    expect(Number(saldoFinal.balance_after)).toBe(500);

    const claimRow = await queryOne("SELECT status FROM claims WHERE id = $1", [claim.claimId]);
    expect(claimRow.status).toBe("expired");

    const transferRow = await queryOne("SELECT status FROM transfers WHERE id = $1", [
      claim.transferId,
    ]);
    expect(transferRow.status).toBe("reversed");
  });

  it("8. test_firma_webhook_invalida: no procesa lógica de negocio", async () => {
    const { kyc } = buildContainer({ webhookSecret: "secret_test" });
    const user = await crearUsuario({
      tag: `u.i8.${sufijo()}`,
      email: `i8.${sufijo()}@labkyc.test`,
      kyc: "not_started",
    });

    await kyc.iniciarKYC({ userId: user.userId, callbackUrl: "https://app.local/kyc/return" });
    const verification = await queryOne(
      "SELECT didit_session_id FROM kyc_verifications WHERE user_id = $1 LIMIT 1",
      [user.userId],
    );

    const payload = {
      event_id: `evt_${sufijo()}`,
      event_type: "status.updated",
      session_id: verification.didit_session_id,
      status: "Approved",
      decision: {},
    };
    const raw = JSON.stringify(payload);

    const res = await kyc.procesarWebhook({ rawBody: raw, signatureHeader: "sha256=invalida" });
    expect(res.procesado).toBe(false);

    // El evento se guardó para auditoría, con signature_valid = false
    const event = await queryOne(
      "SELECT signature_valid, processed_at FROM webhook_events WHERE event_id = $1",
      [payload.event_id],
    );
    expect(event).not.toBeNull();
    expect(event.signature_valid).toBe(false);

    // Y el usuario NO quedó aprobado
    const row = await queryOne("SELECT kyc_status FROM users WHERE id = $1", [user.userId]);
    expect(row.kyc_status).toBe("in_progress");
  });

  it("9. test_grupo_descuadrado_hace_rollback", async () => {
    const { ledger } = buildContainer();
    const a = await crearUsuario({
      tag: `u.i9.${sufijo()}`,
      email: `i9.${sufijo()}@labkyc.test`,
    });

    const antes = await queryOne(
      "SELECT count(*) AS c FROM ledger_entries WHERE user_id = $1",
      [a.userId],
    );

    await expect(
      ledger.crearGrupo([
        {
          cuenta: { userId: a.userId, walletId: a.walletId, accountType: "user_wallet" },
          direction: "debit",
          amount: 100,
          asset: "USDC",
          entryType: "transfer_out",
        },
        {
          cuenta: { userId: a.userId, walletId: a.walletId, accountType: "user_wallet" },
          direction: "credit",
          amount: 40,
          asset: "USDC",
          entryType: "transfer_in",
        },
      ]),
    ).rejects.toThrow(/descuadrado/);

    // Ningún asiento quedó persistido
    const despues = await queryOne(
      "SELECT count(*) AS c FROM ledger_entries WHERE user_id = $1",
      [a.userId],
    );
    expect(Number(despues.c)).toBe(Number(antes.c));
  });

  it("10. test_wallet_sin_secret_en_db", async () => {
    // La tabla wallets no debe tener columnas que permitan reconstruir una clave
    const columnas = await query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'wallets' ORDER BY column_name`,
    );
    const nombres = columnas.map((c: any) => String(c.column_name));

    const prohibidas = [
      "private_key",
      "secret_key",
      "secret",
      "seed",
      "mnemonic",
      "keypair",
      "password",
      "private",
      "signing_key",
    ];
    for (const p of prohibidas) {
      expect(nombres.some((n: string) => n.includes(p))).toBe(false);
    }

    // Y tampoco debe haber datos que parezcan claves (hex de 32 bytes) en la fila
    const { walletRepo } = { walletRepo: new (await import("../src/infrastructure/walletRepo")).PostgresWalletRepository() };
    const user = await crearUsuario({
      tag: `u.i10.${sufijo()}`,
      email: `i10.${sufijo()}@labkyc.test`,
    });
    const wallet = await walletRepo.obtenerPorUsuario(user.userId);
    expect(wallet).not.toBeNull();
    expect(Object.keys(wallet!).sort()).toEqual([
      "address",
      "chain",
      "custodyType",
      "id",
      "signingProvider",
      "status",
      "turnkeySubOrgId",
      "userId",
    ]);
  });
});
