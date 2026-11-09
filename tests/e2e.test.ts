/**
 * Flujo E2E del brief (criterios de aceptación).
 *
 * A envía 10 USDC a @nuevo (que no existe) → Claimable Balance on-chain →
 * B se registra y completa KYC → webhook Approved → claim on-chain →
 * transfer completed → B tiene 10 USDC → invariante vacío.
 *
 * Y el flujo de expiración: claim vencido → reverso → el saldo vuelve a A.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo, sufijo } from "./helpers";
import { buildContainer } from "../src/composition";
import crypto from "crypto";

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Flujo E2E — A → @nuevo → B", () => {
  it("completa el ciclo completo: claim on-chain, KYC gate, saldo acreditado e invariante vacío", async () => {
    const { claims, kyc, ledger, stellar } = buildContainer({ webhookSecret: "secret_test" });

    // --- A: usuario registrado, KYC aprobado y con saldo ---
    const tagA = `u.e2e.a.${sufijo()}`;
    await query(
      `INSERT INTO users (id, tag, email, kyc_status, account_status)
       VALUES ($1,$2,$3,'approved','active')`,
      [crypto.randomUUID(), tagA, `e2ea.${sufijo()}@labkyc.test`],
    );
    const a = await queryOne("SELECT id, tag FROM users WHERE tag = $1", [tagA]);
    const walletA = await queryOne(
      `INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, status)
       VALUES ($1,'stellar',$2,'non_custodial','turnkey','active') RETURNING id`,
      [a.id, `G${sufijo()}`],
    );

    // Saldo inicial de A: 100 USDC (ramp_in)
    await ledger.crearGrupo([
      {
        cuenta: { userId: null, walletId: null, accountType: "external" },
        direction: "debit",
        amount: 100,
        asset: "USDC",
        entryType: "ramp_in",
      },
      {
        cuenta: { userId: a.id, walletId: walletA.id, accountType: "user_wallet" },
        direction: "credit",
        amount: 100,
        asset: "USDC",
        entryType: "ramp_in",
      },
    ]);

    // --- A envía 10 USDC a @nuevo (que NO existe) ---
    const tagNuevo = `u.e2e.nuevo.${sufijo()}`;
    const claim = await claims.crearClaim({
      senderId: a.id,
      recipientTag: tagNuevo,
      amount: 10,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    expect(claim.status).toBe("pending_claim");
    expect(claim.claimToken).toBeTruthy();

    // NO se creó el usuario destinatario
    const usuarioNuevo = await queryOne("SELECT 1 FROM users WHERE lower(tag) = $1", [
      tagNuevo.toLowerCase(),
    ]);
    expect(usuarioNuevo).toBeNull();

    // El balance on-chain existe con el predicate correcto
    const balanceOnChain = stellar.balances.get(
      (await queryOne("SELECT stellar_balance_id FROM claims WHERE id = $1", [claim.claimId]))
        .stellar_balance_id,
    );
    expect(balanceOnChain).toBeDefined();
    expect(balanceOnChain!.amount).toBe(10);
    expect(balanceOnChain!.claimant).toBeTruthy();
    expect(balanceOnChain!.sponsor).toBeTruthy();
    expect(balanceOnChain!.claimed).toBe(false);

    // A quedó con 90 USDC
    const saldoA = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [a.id],
    );
    expect(Number(saldoA.balance_after)).toBe(90);

    // --- B abre el link del claim, se registra y arranca el KYC ---
    const redeem = await claims.redimirClaim({
      claimToken: claim.claimToken,
      email: `e2eb.${sufijo()}@labkyc.test`,
      phone: "+5491100000000",
    });
    expect(redeem.next).toBe("kyc");
    expect(redeem.url).toBeTruthy();

    // B tiene KYC en progreso y wallet pending_kyc
    const bUser = await queryOne("SELECT id, kyc_status FROM users WHERE id = $1", [redeem.userId]);
    expect(bUser.kyc_status).toBe("in_progress");
    const bWallet = await queryOne("SELECT status FROM wallets WHERE user_id = $1", [redeem.userId]);
    expect(bWallet.status).toBe("pending_kyc");

    // --- Webhook Didit Approved ---
    const verification = await queryOne(
      "SELECT didit_session_id FROM kyc_verifications WHERE user_id = $1 LIMIT 1",
      [redeem.userId],
    );
    const payload = {
      event_id: `evt_${sufijo()}`,
      event_type: "status.updated",
      session_id: verification.didit_session_id,
      status: "Approved",
      decision: {
        id_verifications: [
          {
            full_name: "B Destinatario",
            date_of_birth: "1990-01-01",
            document_type: "passport",
            document_number: "AA123456",
            expiration_date: "2030-01-01",
            nationality: "AR",
          },
        ],
        aml: { pep_hit: false, sanctions_hit: false },
      },
    };
    const raw = JSON.stringify(payload);
    const sig = `sha256=${crypto.createHmac("sha256", "secret_test").update(raw).digest("hex")}`;

    const webhook = await kyc.procesarWebhook({ rawBody: raw, signatureHeader: sig });
    expect(webhook.procesado).toBe(true);

    // --- Resultado esperado ---
    // KYC aprobado + wallet activa
    const bUserFinal = await queryOne("SELECT kyc_status FROM users WHERE id = $1", [redeem.userId]);
    expect(bUserFinal.kyc_status).toBe("approved");
    const bWalletFinal = await queryOne("SELECT status FROM wallets WHERE user_id = $1", [
      redeem.userId,
    ]);
    expect(bWalletFinal.status).toBe("active");

    // Transfer completed y con destinatario
    const transfer = await queryOne(
      "SELECT status, recipient_user_id FROM transfers WHERE id = $1",
      [claim.transferId],
    );
    expect(transfer.status).toBe("completed");
    expect(transfer.recipient_user_id).toBe(redeem.userId);

    // Claim claimed
    const claimRow = await queryOne("SELECT status FROM claims WHERE id = $1", [claim.claimId]);
    expect(claimRow.status).toBe("claimed");

    // B tiene 10 USDC en su wallet activa
    const saldoB = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [redeem.userId],
    );
    expect(Number(saldoB.balance_after)).toBe(10);

    // El balance on-chain fue reclamado por la wallet de B
    const balanceId = (await queryOne("SELECT stellar_balance_id FROM claims WHERE id = $1", [
      claim.claimId,
    ])).stellar_balance_id;
    const balance = stellar.balances.get(balanceId);
    expect(balance!.claimed).toBe(true);
    expect(balance!.claimedBy).toBeTruthy();

    // check_ledger_invariants() vacío
    const descuadres = await query("SELECT * FROM check_ledger_invariants()");
    expect(descuadres).toEqual([]);
  });

  it("flujo de expiración: el claim vencido revierte y los 10 USDC vuelven a A", async () => {
    const { claims, expiration, ledger } = buildContainer();

    const tagA = `u.e2e.exp.${sufijo()}`;
    await query(
      `INSERT INTO users (id, tag, email, kyc_status, account_status)
       VALUES ($1,$2,$3,'approved','active')`,
      [crypto.randomUUID(), tagA, `e2eexp.${sufijo()}@labkyc.test`],
    );
    const a = await queryOne("SELECT id, tag FROM users WHERE tag = $1", [tagA]);
    const walletA = await queryOne(
      `INSERT INTO wallets (user_id, chain, address, custody_type, signing_provider, status)
       VALUES ($1,'stellar',$2,'non_custodial','turnkey','active') RETURNING id`,
      [a.id, `G${sufijo()}`],
    );

    await ledger.crearGrupo([
      {
        cuenta: { userId: null, walletId: null, accountType: "external" },
        direction: "debit",
        amount: 100,
        asset: "USDC",
        entryType: "ramp_in",
      },
      {
        cuenta: { userId: a.id, walletId: walletA.id, accountType: "user_wallet" },
        direction: "credit",
        amount: 100,
        asset: "USDC",
        entryType: "ramp_in",
      },
    ]);

    const claim = await claims.crearClaim({
      senderId: a.id,
      recipientTag: `u.e2e.nadie.${sufijo()}`,
      amount: 10,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    // CLAIM_TTL_DAYS = 0 -> el claim vence de inmediato
    await query(
      `UPDATE claims
       SET claimable_until = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE id = $1`,
      [claim.claimId],
    );

    const resultado = await expiration.expirarClaimsVencidos();
    expect(resultado.expirados).toBe(1);

    // Estados finales
    const transfer = await queryOne("SELECT status FROM transfers WHERE id = $1", [
      claim.transferId,
    ]);
    expect(transfer.status).toBe("reversed");
    const claimRow = await queryOne("SELECT status FROM claims WHERE id = $1", [claim.claimId]);
    expect(claimRow.status).toBe("expired");

    // Los 10 USDC volvieron a A
    const saldoA = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [a.id],
    );
    expect(Number(saldoA.balance_after)).toBe(100);

    // Invariante vacío
    const descuadres = await query("SELECT * FROM check_ledger_invariants()");
    expect(descuadres).toEqual([]);
  });
});
