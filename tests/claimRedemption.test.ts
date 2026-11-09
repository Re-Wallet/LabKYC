import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo, sufijo } from "./helpers";
import { derivarAddressDesdeTag } from "../src/application/claim";
import { buildContainer } from "../src/composition";
import { PostgresLedgerService } from "../src/infrastructure/ledgerRepo";
import { StellarMockClient } from "../src/infrastructure/stellarClient";
import crypto from "crypto";

const SPONSOR = "GSPONSOR0000000000000000000000000000000000000000000000000000";

/** Usa el contenedor de composición: mismo wiring que las rutas HTTP. */
function buildStack() {
  return buildContainer({ workflowId: "wf_test", webhookSecret: "secret_test" });
}

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

  const ledger = new PostgresLedgerService();
  await ledger.crearGrupoBalanceado([
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

describe("Módulo 8 — Reclamo del claim (KYC gate)", () => {
  it("deriva una address Stellar determinística y con formato válido desde el tag", () => {
    const a1 = derivarAddressDesdeTag("nuevo.usuario");
    const a2 = derivarAddressDesdeTag("nuevo.usuario");
    const a3 = derivarAddressDesdeTag("otro.usuario");

    expect(a1).toBe(a2); // determinista
    expect(a1).not.toBe(a3); // tags distintos -> addresses distintas
    expect(a1.startsWith("G")).toBe(true);
    expect(a1.length).toBe(56);
  });

  it("redimir sin KYC aprobado NO libera el claim: devuelve next=kyc y deja el claim pending", async () => {
    const { claims: claimUseCases } = buildStack();
    const remitente = await crearRemitenteConSaldo(
      `u.r1.${sufijo()}`,
      `r1.${sufijo()}@labkyc.test`,
    );

    const claim = await claimUseCases.crearClaim({
      senderId: remitente.userId,
      recipientTag: `u.r1.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    // El usuario B todavía NO tiene KYC: se crea y se le inicia el KYC.
    const resultado = await claimUseCases.redimirClaim({
      claimToken: claim.claimToken,
      email: `destino.${sufijo()}@labkyc.test`,
      phone: "+5491100000000",
    });

    expect(resultado.next).toBe("kyc");
    expect(resultado.url).toBeDefined();

    // El claim sigue pending y el transfer en pending_claim: NO se liberó nada.
    const claimRow = await queryOne("SELECT status, claimed_by_user_id FROM claims WHERE id = $1", [
      claim.claimId,
    ]);
    expect(claimRow.status).toBe("pending");
    expect(claimRow.claimed_by_user_id).toBe(resultado.userId);

    const transferRow = await queryOne("SELECT status, recipient_user_id FROM transfers WHERE id = $1", [
      claim.transferId,
    ]);
    expect(transferRow.status).toBe("pending_claim");
    expect(transferRow.recipient_user_id).toBeNull();

    // No se movió saldo al wallet del destinatario (el asiento claim_release NO existe).
    const release = await queryOne(
      "SELECT count(*) AS c FROM ledger_entries WHERE reference_claim_id = $1 AND entry_type = 'claim_release'",
      [claim.claimId],
    );
    expect(Number(release.c)).toBe(0);
  });

  it("webhook Approved dispara la liberación: el claim pasa a claimed y el saldo se asienta", async () => {
    const { claims: claimUseCases, kyc: kycUseCases } = buildStack();
    const remitente = await crearRemitenteConSaldo(
      `u.r2.${sufijo()}`,
      `r2.${sufijo()}@labkyc.test`,
    );

    const claim = await claimUseCases.crearClaim({
      senderId: remitente.userId,
      recipientTag: `u.r2.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    // B se registra redimiendo el claim (queda con KYC pendiente)
    const redeem = await claimUseCases.redimirClaim({
      claimToken: claim.claimToken,
      email: `destino2.${sufijo()}@labkyc.test`,
    });
    expect(redeem.next).toBe("kyc");

    // Simular el webhook Approved de Didit para el usuario B
    const verification = await queryOne(
      "SELECT id, didit_session_id FROM kyc_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [redeem.userId],
    );
    expect(verification).not.toBeNull();

    const payload = {
      event_id: `evt_${sufijo()}`,
      event_type: "status.updated",
      session_id: verification.didit_session_id,
      status: "Approved",
      decision: { id_verifications: [{ full_name: "B Person", document_number: "99887766" }] },
    };
    const raw = JSON.stringify(payload);
    const hmac = crypto.createHmac("sha256", "secret_test").update(raw).digest("hex");

    const res = await kycUseCases.procesarWebhook({
      rawBody: raw,
      signatureHeader: `sha256=${hmac}`,
    });
    expect(res.procesado).toBe(true);

    // El claim fue liberado por el webhook
    const claimRow = await queryOne("SELECT status FROM claims WHERE id = $1", [claim.claimId]);
    expect(claimRow.status).toBe("claimed");

    const transferRow = await queryOne("SELECT status, recipient_user_id FROM transfers WHERE id = $1", [
      claim.transferId,
    ]);
    expect(transferRow.status).toBe("completed");
    expect(transferRow.recipient_user_id).toBe(redeem.userId);

    // El destinatario tiene los 50 USDC acreditados en su wallet
    const walletB = await queryOne("SELECT id FROM wallets WHERE user_id = $1", [redeem.userId]);
    const saldoB = await queryOne(
      `SELECT balance_after FROM ledger_entries
       WHERE user_id = $1 AND wallet_id = $2 AND account_type = 'user_wallet'
       ORDER BY created_at DESC LIMIT 1`,
      [redeem.userId, walletB.id],
    );
    expect(Number(saldoB.balance_after)).toBe(50);

    // Asientos claim_release presentes (debit pending_claim / credit user_wallet)
    const release = await queryOne(
      `SELECT count(*) AS c FROM ledger_entries
       WHERE reference_claim_id = $1 AND entry_type = 'claim_release'`,
      [claim.claimId],
    );
    expect(Number(release.c)).toBe(2);

    // Invariante de suma cero intacto
    const descuadre = await queryOne(
      `SELECT asset FROM ledger_entries GROUP BY asset
       HAVING SUM(CASE WHEN direction='credit' THEN amount WHEN direction='debit' THEN -amount END) <> 0`,
    );
    expect(descuadre).toBeNull();
  });

  it("token expirado rechaza el redeem", async () => {
    const { claims: claimUseCases } = buildStack();
    const remitente = await crearRemitenteConSaldo(
      `u.r3.${sufijo()}`,
      `r3.${sufijo()}@labkyc.test`,
    );

    const claim = await claimUseCases.crearClaim({
      senderId: remitente.userId,
      recipientTag: `u.r3.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    // Forzar expiración en la DB
    await query(
      `UPDATE claims
       SET claimable_until = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE id = $1`,
      [claim.claimId],
    );

    await expect(
      claimUseCases.redimirClaim({
        claimToken: claim.claimToken,
        email: `destino3.${sufijo()}@labkyc.test`,
      }),
    ).rejects.toThrow(/expirado/);
  });

  it("token ya usado rechaza el redeem", async () => {
    const { claims: claimUseCases } = buildStack();
    const remitente = await crearRemitenteConSaldo(
      `u.r4.${sufijo()}`,
      `r4.${sufijo()}@labkyc.test`,
    );

    const claim = await claimUseCases.crearClaim({
      senderId: remitente.userId,
      recipientTag: `u.r4.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    // Marcar el claim como ya reclamado
    await query("UPDATE claims SET status = 'claimed' WHERE id = $1", [claim.claimId]);

    await expect(
      claimUseCases.redimirClaim({
        claimToken: claim.claimToken,
        email: `destino4.${sufijo()}@labkyc.test`,
      }),
    ).rejects.toThrow(/ya usado/);
  });

  it("token inexistente rechaza el redeem", async () => {
    const { claims: claimUseCases } = buildStack();
    await expect(
      claimUseCases.redimirClaim({
        claimToken: "token_inventado",
        email: `nadie.${sufijo()}@labkyc.test`,
      }),
    ).rejects.toThrow(/link inválido/);
  });

  it("la consulta pública del claim no expone el token plano", async () => {
    const { claims: claimUseCases } = buildStack();
    const remitente = await crearRemitenteConSaldo(
      `u.r5.${sufijo()}`,
      `r5.${sufijo()}@labkyc.test`,
    );

    const claim = await claimUseCases.crearClaim({
      senderId: remitente.userId,
      recipientTag: `u.r5.destino.${sufijo()}`,
      amount: 50,
      asset: "USDC",
      idempotencyKey: `idem_${sufijo()}`,
    });

    const resumen = await claimUseCases.consultarClaim(claim.claimToken);
    expect(resumen.amount).toBe(50);
    expect(resumen.asset).toBe("USDC");
    expect(resumen.senderTag).toBe(remitente.tag);
    expect(resumen.status).toBe("pending");
    expect(JSON.stringify(resumen)).not.toContain(claim.claimToken);
  });
});
