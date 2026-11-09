import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo } from "./helpers";
import { KYCUseCases } from "../src/application/kyc";
import { PostgresKYCVerificationRepository } from "../src/infrastructure/kycRepo";
import { PostgresWebhookEventRepository } from "../src/infrastructure/webhookRepo";
import { DiditMockClient } from "../src/infrastructure/diditClient";
import { PostgresUserRepository } from "../src/infrastructure/userRepo";
import { PostgresWalletRepository } from "../src/infrastructure/walletRepo";

const kycUseCases = new KYCUseCases(
  new PostgresKYCVerificationRepository(),
  new PostgresWebhookEventRepository(),
  new DiditMockClient(),
  new PostgresUserRepository(),
  new PostgresWalletRepository(),
  "wf_test",
  "secret_test",
);

function sufijo() { return Math.random().toString(36).slice(2, 8); }

async function crearUsuario(tag: string, email: string) {
  await query("INSERT INTO users (id, tag, email, kyc_status, account_status) VALUES ($1,$2,$3,'not_started','active')",
    [crypto.randomUUID(), tag, email]);
  const row = await queryOne("SELECT id FROM users WHERE tag = $1", [tag]);
  return row.id;
}

beforeAll(async () => {
  await limpiarTodo();
});

afterEach(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 3 — KYC con Didit", () => {
  it("iniciar KYC crea sesión y actualiza usuario a in_progress", async () => {
    const userId = await crearUsuario(`u.k.${sufijo()}`, `k.${sufijo()}@labkyc.test`);
    const r = await kycUseCases.iniciarKYC({ userId, callbackUrl: "https://app.local/kyc/return" });
    expect(r.url).toContain("didit");
    expect(r.verificationId).toBeDefined();

    const user = await queryOne("SELECT kyc_status FROM users WHERE id = $1", [userId]);
    expect(user.kyc_status).toBe("in_progress");

    const v = await queryOne("SELECT * FROM kyc_verifications WHERE id = $1", [r.verificationId]);
    expect(v.status).toBe("In Progress");
  });

  it("reutiliza sesión activa si ya existe", async () => {
    const userId = await crearUsuario(`u.k2.${sufijo()}`, `k2.${sufijo()}@labkyc.test`);
    const r1 = await kycUseCases.iniciarKYC({ userId, callbackUrl: "https://app.local/kyc/return" });
    const r2 = await kycUseCases.iniciarKYC({ userId, callbackUrl: "https://app.local/kyc/return" });
    expect(r1.verificationId).toBe(r2.verificationId);
  });

  it("webhook In Progress -> Approved activa KYC y wallet", async () => {
    const userId = await crearUsuario(`u.k3.${sufijo()}`, `k3.${sufijo()}@labkyc.test`);
    // Crear wallet pendiente
    const walletRepo = new PostgresWalletRepository();
    await walletRepo.crear({ userId, address: `G${sufijo()}`, signingProvider: "turnkey", status: "pending_kyc" });

    // Iniciar KYC para tener una verification
    const inicio = await kycUseCases.iniciarKYC({ userId, callbackUrl: "https://app.local/kyc/return" });

    // Simular webhook Approved
    const payload = {
      event_id: `evt_${sufijo()}`,
      event_type: "status.updated",
      session_id: `didit_${userId}_${Date.now()}`,
      status: "Approved",
      decision: { id_verifications: [{ full_name: "Juan Pérez", document_number: "12345678" }] },
    };
    const crypto = await import("crypto");
    const hmac = crypto.createHmac("sha256", "secret_test");
    hmac.update(JSON.stringify(payload));
    const sig = "sha256=" + hmac.digest("hex");

    // Insertar la verification con el session_id del webhook
    await query("UPDATE kyc_verifications SET didit_session_id = $1 WHERE id = $2", [payload.session_id, inicio.verificationId]);

    const res = await kycUseCases.procesarWebhook({ rawBody: JSON.stringify(payload), signatureHeader: sig });
    expect(res.procesado).toBe(true);

    const user = await queryOne("SELECT kyc_status FROM users WHERE id = $1", [userId]);
    expect(user.kyc_status).toBe("approved");

    const wallet = await queryOne("SELECT status FROM wallets WHERE user_id = $1", [userId]);
    expect(wallet.status).toBe("active");
  });

  it("webhook con firma inválida no procesa lógica", async () => {
    const userId = await crearUsuario(`u.k4.${sufijo()}`, `k4.${sufijo()}@labkyc.test`);
    const payload = {
      event_id: `evt_bad_${sufijo()}`,
      event_type: "status.updated",
      session_id: `didit_bad_${Date.now()}`,
      status: "Approved",
      decision: {},
    };
    const res = await kycUseCases.procesarWebhook({ rawBody: JSON.stringify(payload), signatureHeader: "sha256=firmafalsa" });
    expect(res.procesado).toBe(false);

    const user = await queryOne("SELECT kyc_status FROM users WHERE id = $1", [userId]);
    expect(user.kyc_status).toBe("not_started");
  });

  it("webhook duplicado (mismo event_id) no reprocesa", async () => {
    const userId = await crearUsuario(`u.k5.${sufijo()}`, `k5.${sufijo()}@labkyc.test`);
    const payload = {
      event_id: `evt_dup_${sufijo()}`,
      event_type: "status.updated",
      session_id: `didit_dup_${Date.now()}`,
      status: "Declined",
      decision: {},
    };
    const crypto = await import("crypto");
    const hmac = crypto.createHmac("sha256", "secret_test");
    hmac.update(JSON.stringify(payload));
    const sig = "sha256=" + hmac.digest("sig");

    await kycUseCases.procesarWebhook({ rawBody: JSON.stringify(payload), signatureHeader: sig });
    const res2 = await kycUseCases.procesarWebhook({ rawBody: JSON.stringify(payload), signatureHeader: sig });
    expect(res2.procesado).toBe(false);
  });

  it("Declined no activa wallet", async () => {
    const userId = await crearUsuario(`u.k6.${sufijo()}`, `k6.${sufijo()}@labkyc.test`);
    const payload = {
      event_id: `evt_dec_${sufijo()}`,
      event_type: "status.updated",
      session_id: `didit_dec_${Date.now()}`,
      status: "Declined",
      decision: {},
    };
    const crypto = await import("crypto");
    const hmac = crypto.createHmac("sha256", "secret_test");
    hmac.update(JSON.stringify(payload));
    const sig = "sha256=" + hmac.digest("hex");

    await query("INSERT INTO kyc_verifications (id, user_id, didit_session_id, workflow_id, status) VALUES ($1,$2,$3,'wf','In Progress')",
      [crypto.randomUUID(), userId, payload.session_id]);

    await kycUseCases.procesarWebhook({ rawBody: JSON.stringify(payload), signatureHeader: sig });
    const user = await queryOne("SELECT kyc_status FROM users WHERE id = $1", [userId]);
    expect(user.kyc_status).toBe("declined");
  });
});
