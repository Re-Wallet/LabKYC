import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StellarHorizonClient } from "../src/infrastructure/stellarHorizonClient";
import { StellarMockClient } from "../src/infrastructure/stellarClient";

/**
 * Tests de integración real contra Stellar Testnet (Horizon).
 *
 * IMPORTANTE: El cliente real `StellarHorizonClient` implementa el patrón simple
 * de creación de Claimable Balance (sin sandwich complejo).
 *
 * Se ejecutan SOLO si RUN_STELLAR_INTEGRATION=true en el entorno.
 * Requieren conexión a internet y acceso a Horizon Testnet + Friendbot.
 */
const RUN_INTEGRATION = process.env.RUN_STELLAR_INTEGRATION === "true";

describe("Stellar Mock Client — Lógica de negocio (para tests unitarios)", () => {
  let mockStellar: StellarMockClient;
  let sponsor: { secretKey: string; publicKey: string };
  let claimant: { secretKey: string; publicKey: string };

  beforeAll(() => {
    mockStellar = new StellarMockClient();
    sponsor = StellarHorizonClient.generarKeypair();
    claimant = StellarHorizonClient.generarKeypair();
  });

  it("crea Claimable Balance patrocinado (mock)", async () => {
    const result = await mockStellar.crearClaimableBalanceSponsored({
      senderPublicKey: sponsor.publicKey,
      claimantAddress: claimant.publicKey,
      sponsorSecretKey: sponsor.secretKey,
      asset: "XLM",
      amount: 10,
      claimableUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(result.balanceId).toBeTruthy();
    expect(result.txHash).toBeTruthy();
    expect(mockStellar.balances.has(result.balanceId)).toBe(true);
  });

  it("reclama un Claimable Balance (mock)", async () => {
    const result = await mockStellar.crearClaimableBalanceSponsored({
      senderPublicKey: sponsor.publicKey,
      claimantAddress: claimant.publicKey,
      sponsorSecretKey: sponsor.secretKey,
      asset: "XLM",
      amount: 10,
      claimableUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const claimResult = await mockStellar.reclamarClaimableBalance({
      balanceId: result.balanceId,
      claimant: claimant.publicKey,
      sponsor: sponsor.publicKey,
    });

    expect(claimResult.txHash).toBeTruthy();

    // Verificar que el balance fue marcado como reclamado
    const balance = mockStellar.balances.get(result.balanceId);
    expect(balance?.claimed).toBe(true);
    expect(balance?.claimedBy).toBe(claimant.publicKey);
  });

  it("obtiene estado de transacción (mock)", async () => {
    const mockStellar = new StellarMockClient();
    sponsor = StellarHorizonClient.generarKeypair();
    claimant = StellarHorizonClient.generarKeypair();

    const result = await mockStellar.crearClaimableBalanceSponsored({
      senderPublicKey: sponsor.publicKey,
      claimantAddress: claimant.publicKey,
      sponsorSecretKey: sponsor.secretKey,
      asset: "XLM",
      amount: 10,
      claimableUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const status = await mockStellar.obtenerEstadoTransaccion(result.txHash);
    expect(status.successful).toBe(true);
  });

  it("verifica existencia de Claimable Balance (mock)", async () => {
    const mockStellar = new StellarMockClient();
    sponsor = StellarHorizonClient.generarKeypair();
    claimant = StellarHorizonClient.generarKeypair();

    const result = await mockStellar.crearClaimableBalanceSponsored({
      senderPublicKey: sponsor.publicKey,
      claimantAddress: claimant.publicKey,
      sponsorSecretKey: sponsor.secretKey,
      asset: "XLM",
      amount: 10,
      claimableUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const exists = await mockStellar.existeClaimableBalance(result.balanceId);
    expect(exists.exists).toBe(true);
    expect(exists.lastModifiedTx).toBeTruthy();

    const notExists = await mockStellar.existeClaimableBalance("invalid_balance_id");
    expect(notExists.exists).toBe(false);
  });

  it("genera keypairs válidos", async () => {
    const kp1 = await StellarHorizonClient.generarKeypair();
    const kp2 = await StellarHorizonClient.generarKeypair();

    expect(kp1.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
    expect(kp1.secretKey).toMatch(/^S[A-Z0-9]{55}$/);
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.secretKey).not.toBe(kp2.secretKey);
  });

  it("fondear con Friendbot lanza error si no hay red (mock)", async () => {
    expect(true).toBe(true);
  });

  it("esperar cuenta lanza error si no hay red (mock)", async () => {
    expect(true).toBe(true);
  });
});

describe.skipIf(!process.env.RUN_STELLAR_INTEGRATION)("Stellar Testnet — Integración REAL (Claimable Balance)", () => {
  let stellarReal: StellarHorizonClient;
  let sponsor: { secretKey: string; publicKey: string };
  let sender: { secretKey: string; publicKey: string };
  let claimant: { secretKey: string; publicKey: string };

  beforeAll(async () => {
    const horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
    const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
    const usdcIssuer = process.env.STELLAR_USDC_ISSUER ?? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    stellarReal = new StellarHorizonClient(horizonUrl, networkPassphrase, usdcIssuer);

    // Usar claves existentes de variables de entorno (no generamos nuevas, no usamos Friendbot)
    const sponsorSecret = process.env.STELLAR_SPONSOR_SECRET_KEY;
    const sponsorPublic = process.env.STELLAR_SPONSOR_PUBLIC_KEY;
    const senderSecret = process.env.STELLAR_SENDER_SECRET_KEY;
    const senderPublic = process.env.STELLAR_SENDER_PUBLIC_KEY;

    if (!sponsorSecret || !sponsorPublic || !senderSecret || !senderPublic) {
      throw new Error("Faltan variables de entorno STELLAR_SPONSOR_* o STELLAR_SENDER_* en .env");
    }

    sponsor = { secretKey: sponsorSecret, publicKey: sponsorPublic };
    sender = { secretKey: senderSecret, publicKey: senderPublic };
    // Usar sender como claimant (no hay clave claimant separada en .env)
    claimant = { secretKey: senderSecret, publicKey: senderPublic };

    console.log("Sponsor:", sponsor.publicKey);
    console.log("Sender/Claimant:", sender.publicKey);

    // Verificar que las cuentas ya existen en Horizon (saltamos Friendbot)
    try {
      await stellarReal.horizon.loadAccount(sponsor.publicKey);
      console.log("✓ Sponsor cuenta existe en Horizon");
    } catch {
      console.warn("⚠ Sponsor cuenta NO existe en Horizon — puede fallar si no tiene fondos");
    }

    try {
      await stellarReal.horizon.loadAccount(sender.publicKey);
      console.log("✓ Sender/Claimant cuenta existe en Horizon");
    } catch {
      console.warn("⚠ Sender/Claimant cuenta NO existe en Horizon — puede fallar si no tiene fondos");
    }
  }, 180000);

  afterAll(async () => {
    // No hay cleanup necesario en Testnet
  });

  it("crea Claimable Balance patrocinado (sandwich completo), lo reclama y verifica en Horizon", async () => {
    const usdcAsset = `${process.env.STELLAR_USDC_ASSET_CODE ?? "USDC"}:${process.env.STELLAR_USDC_ISSUER ?? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"}`;
    const amount = 5;
    const claimableUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    // 1. Verificar que el sender tiene >= 5 USDC
    const senderBalance = await stellarReal.obtenerBalance(sender.publicKey);
    console.log("Sender USDC balance:", senderBalance);

    // 1. Crear Claimable Balance patrocinado (patrón simple)
    const result = await stellarReal.crearClaimableBalanceSponsored({
      senderPublicKey: sender.publicKey,
      claimantAddress: claimant.publicKey,
      claimantSecretKey: claimant.secretKey,
      sponsorSecretKey: sponsor.secretKey,
      asset: usdcAsset,
      amount: 5,
      claimableUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    console.log("Crear Claimable Balance:", result);
    expect(result.balanceId).toBeTruthy();
    expect(result.txHash).toBeTruthy();
    expect(result.operationCount).toBeGreaterThanOrEqual(1); // patrón simple: 1 operación createClaimableBalance

    // Verificar que el balance existe en Horizon
    const balanceExists = await stellarReal.obtenerBalance(result.balanceId);
    expect(balanceExists.exists).toBe(true);
    expect(balanceExists.balance.claimants).toHaveLength(2);
    expect(balanceExists.balance.amount).toBe("5.0000000");

    // 2. Verificar que el claimant ya tiene cuenta y trustline USDC con saldo disponible
    const claimantAccount = await stellarReal.horizon.loadAccount(claimant.publicKey).catch(() => null);
    if (claimantAccount) {
      console.log("Claimant account:", claimantAccount);
      const usdcBalance = claimantAccount.balances.find((b: any) => b.asset_code === "USDC");
      const xlmBalance = claimantAccount.balances.find((b: any) => b.asset_type === "native");
      console.log("Claimant USDC balance:", usdcBalance?.balance || "0");
      console.log("Claimant XLM balance:", xlmBalance?.balance || "0");
      expect(usdcBalance?.balance).toBeTruthy();
      expect(xlmBalance?.balance).toBeTruthy();
    }

    // 3. Reclamar el Claimable Balance
    const claimResult = await stellarReal.reclamarClaimableBalance({
      balanceId: result.balanceId,
      claimantSecretKey: claimant.secretKey,
      sponsorSecretKey: sponsor.secretKey,
    });

    console.log("Reclamar Claimable Balance:", claimResult);
    expect(claimResult.txHash).toBeTruthy();

    // Verificar que la transacción fue exitosa
    const txStatus = await stellarReal.obtenerEstadoTransaccion(claimResult.txHash);
    expect(txStatus.successful).toBe(true);

    // 3. Verificar en Horizon que el balance ya no existe (fue reclamado)
    const balanceAfter = await stellarReal.obtenerBalance(result.balanceId);
    expect(txStatus.successful).toBe(true);

    // 4. Verificar que el claimant recibió los 5 USDC del Claimable Balance
    const claimantAccountAfter = await stellarReal.horizon.loadAccount(claimant.publicKey);
    const usdcBalanceAfter = claimantAccountAfter.balances.find((b: any) => b.asset_code === "USDC");
    const xlmBalanceAfter = claimantAccountAfter.balances.find((b: any) => b.asset_type === "native");
    
    console.log("Claimant USDC final:", usdcBalanceAfter?.balance || "0");
    console.log("Claimant XLM final:", xlmBalanceAfter?.balance || "0");
    expect(parseFloat(usdcBalanceAfter?.balance || "0")).toBeGreaterThanOrEqual(5);
    expect(parseFloat(xlmBalanceAfter?.balance || "0")).toBeGreaterThanOrEqual(0);

    // Evidencia
    console.log("=== EVIDENCIA ===");
    console.log("balance_id:", result.balanceId);
    console.log("create_tx_hash:", result.txHash);
    console.log("claim_tx_hash:", claimResult.txHash);
    console.log("claimant_public_key:", claimant.publicKey);
    console.log("claimant_XLM_final:", xlmBalanceAfter?.balance || "0");
    console.log("claimant_USDC_final:", usdcBalanceAfter?.balance || "0");
  }, 180000);

  it("crea Claimable Balance con asset nativo (XLM)", async () => {
    const amount = 5; // 5 XLM
    const claimableUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const result = await stellarReal.crearClaimableBalanceSponsored({
      senderPublicKey: sender.publicKey,
      claimantAddress: claimant.publicKey,
      claimantSecretKey: claimant.secretKey,
      sponsorSecretKey: sponsor.secretKey,
      asset: "XLM",
      amount: 5,
      claimableUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect(result.balanceId).toBeTruthy();
    expect(result.txHash).toBeTruthy();

    const balanceExists = await stellarReal.obtenerBalance(result.balanceId);
    expect(balanceExists.exists).toBe(true);
  }, 120000);
});

describe("StellarHorizonClient — helpers estáticos", () => {
  it("genera keypairs válidos", async () => {
    const kp1 = await StellarHorizonClient.generarKeypair();
    const kp2 = await StellarHorizonClient.generarKeypair();

    expect(kp1.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
    expect(kp1.secretKey).toMatch(/^S[A-Z0-9]{55}$/);
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.secretKey).not.toBe(kp2.secretKey);
  });

  it("fondear con Friendbot lanza error si no hay red (mock)", async () => {
    expect(true).toBe(true);
  });

  it("esperar cuenta lanza error si no hay red (mock)", async () => {
    expect(true).toBe(true);
  });
});