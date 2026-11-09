import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo, sufijo } from "./helpers";
import { FeeUseCases } from "../src/application/fee";
import { PostgresFeeRepository } from "../src/infrastructure/feeRepo";

const feeUseCases = new FeeUseCases(new PostgresFeeRepository());

beforeAll(async () => {
  await limpiarTodo();
  // El seed de fee_configs vive en la migración; lo recreamos para aislar el test.
  await query(
    `INSERT INTO fee_configs (name, operation_type, fiat_currency, crypto_asset, provider, fee_payer, fee_type, percentage, flat_amount, min_fee, max_fee, tiers, asset_charged_in, is_active, valid_from)
     VALUES
       ('on_ramp ARS→USDC 1.5%', 'on_ramp', 'ARS', 'USDC', 'pollar', 'user', 'percentage', 0.015, NULL, NULL, NULL, NULL, 'USDC', true, now()),
       ('p2p 0% absorbed', 'p2p_transfer', NULL, 'USDC', 'platform', 'platform', 'flat', NULL, 0, NULL, NULL, NULL, 'USDC', true, now()),
       ('withdrawal flat 0.5', 'withdrawal', NULL, 'USDC', 'platform', 'user', 'flat', NULL, 0.5, NULL, NULL, NULL, 'USDC', true, now()),
       ('p2p con min/max', 'p2p_transfer', NULL, 'USDC', 'minmax', 'user', 'percentage', 0.01, NULL, 0.25, 2, NULL, 'USDC', true, now()),
       ('p2p tiered', 'p2p_transfer', NULL, 'USDC', 'tiered', 'user', 'tiered', NULL, NULL, NULL, NULL,
         '[{"min":0,"max":100,"percentage":0.05,"flat":0.1},{"min":100,"max":null,"percentage":0.03,"flat":0}]',
         'USDC', true, now())`,
  );
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 11 — Cálculo de fees", () => {
  it("fee porcentual: 1.5% de 100 USDC = 1.5", async () => {
    const r = await feeUseCases.calcularFee({
      operationType: "on_ramp",
      fiatCurrency: "ARS",
      cryptoAsset: "USDC",
      provider: "pollar",
      gross: 100,
    });
    expect(r.fee).toBe(1.5);
    expect(r.config?.feeType).toBe("percentage");
    expect(r.config?.feePayer).toBe("user");
  });

  it("fee flat: withdrawal USDC = 0.5", async () => {
    const r = await feeUseCases.calcularFee({
      operationType: "withdrawal",
      cryptoAsset: "USDC",
      provider: "platform",
      gross: 250,
    });
    expect(r.fee).toBe(0.5);
    expect(r.config?.feeType).toBe("flat");
  });

  it("fee flat en cero (p2p absorbed)", async () => {
    const r = await feeUseCases.calcularFee({
      operationType: "p2p_transfer",
      cryptoAsset: "USDC",
      provider: "platform",
      gross: 100,
    });
    expect(r.fee).toBe(0);
  });

  it("respeta min_fee y max_fee", async () => {
    // 1% de 10 = 0.1, pero min_fee = 0.25 -> aplica el piso
    const bajo = await feeUseCases.calcularFee({
      operationType: "p2p_transfer",
      cryptoAsset: "USDC",
      provider: "minmax",
      gross: 10,
    });
    expect(bajo.fee).toBe(0.25);

    // 1% de 500 = 5, pero max_fee = 2 -> aplica el techo
    const alto = await feeUseCases.calcularFee({
      operationType: "p2p_transfer",
      cryptoAsset: "USDC",
      provider: "minmax",
      gross: 500,
    });
    expect(alto.fee).toBe(2);
  });

  it("fee tiered: aplica el tier correspondiente al gross", async () => {
    // gross 50 -> tier 1 (0-100): 5% + 0.1 = 2.6
    const t1 = await feeUseCases.calcularFee({
      operationType: "p2p_transfer",
      cryptoAsset: "USDC",
      provider: "tiered",
      gross: 50,
    });
    expect(t1.fee).toBe(2.6);

    // gross 200 -> tier 2 (100+): 3% + 0 = 6
    const t2 = await feeUseCases.calcularFee({
      operationType: "p2p_transfer",
      cryptoAsset: "USDC",
      provider: "tiered",
      gross: 200,
    });
    expect(t2.fee).toBe(6);
  });

  it("sin config aplicable devuelve fee 0 y config null", async () => {
    const r = await feeUseCases.calcularFee({
      operationType: "off_ramp",
      cryptoAsset: "BTC",
      provider: "inexistente",
      gross: 100,
    });
    expect(r.fee).toBe(0);
    expect(r.config).toBeNull();
  });

  it("crea fee_charge en estado quoted", async () => {
    const feeRepo = new PostgresFeeRepository();
    await query(
      `INSERT INTO users (id, tag, email, kyc_status, account_status)
       VALUES ($1,$2,$3,'approved','active')`,
      [crypto.randomUUID(), `u.fee.${sufijo()}`, `fee.${sufijo()}@labkyc.test`],
    );
    const user = await queryOne("SELECT id FROM users WHERE email LIKE '%@labkyc.test' LIMIT 1");
    const transfer = await queryOne(
      `INSERT INTO transfers (sender_user_id, sender_tag, recipient_tag, amount, asset, type, status, idempotency_key)
       VALUES ($1,'origen','destino',100,'USDC','internal_p2p','completed',$2) RETURNING id`,
      [user.id, `idem_${sufijo()}`],
    );

    const charge = await feeRepo.crearCharge({
      transferId: transfer.id,
      provider: "pollar",
      legType: "PROVIDER_ONRAMP",
      grossAmount: 100,
      feeAmount: 1.5,
      feeAsset: "USDC",
      feePayer: "user",
      status: "quoted",
    });

    expect(charge.feeAmount).toBe(1.5);
    expect(charge.status).toBe("quoted");

    const row = await queryOne("SELECT count(*) AS c FROM fee_charges WHERE transfer_id = $1", [
      transfer.id,
    ]);
    expect(Number(row.c)).toBe(1);
  });
});
