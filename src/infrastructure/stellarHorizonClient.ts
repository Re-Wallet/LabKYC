import { Horizon, Keypair, TransactionBuilder, Networks, Operation, Asset, BASE_FEE, xdr, Claimant } from "@stellar/stellar-sdk";

/**
 * Cliente Stellar real contra Horizon Testnet usando @stellar/stellar-sdk.
 *
 * Implementa la creación de Claimable Balance patrocinado (patrón simple y correcto):
 * - El sponsor crea el Claimable Balance directamente con dos claimants
 * - No requiere "sandwich" complejo ni crear la cuenta del claimant primero
 * - El sponsor firma y paga el fee
 * - El claimant reclama después con su secret key
 */
export class StellarHorizonClient {
  private horizon: Horizon.Server;
  private networkPassphrase: string;
  private usdcIssuer: string;

  constructor(
    horizonUrl: string = "https://horizon-testnet.stellar.org",
    networkPassphrase: string = Networks.TESTNET,
    usdcIssuer: string = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  ) {
    this.horizon = new Horizon.Server(horizonUrl);
    this.networkPassphrase = networkPassphrase;
    this.usdcIssuer = usdcIssuer;
  }

  /**
   * Crea un Claimable Balance patrocinado (patrón simple y correcto).
   *
   * El sponsor crea el Claimable Balance con dos claimants:
   * 1. claimantAddress (destinatario real) - con predicate abs_before
   * 2. sponsor publicKey (claimant de reverso) - predicate unconditional
   *
   * El sponsor firma y paga el fee.
   * El claimant NO necesita firmar la creación, solo el reclamo posterior.
   */
  async crearClaimableBalanceSponsored(params: {
    senderPublicKey: string;
    claimantAddress: string;
    sponsorSecretKey: string;
    asset: string;
    amount: number;
    claimableUntil: Date;
  }): Promise<{ balanceId: string; txHash: string }> {
    const {
      claimantAddress,
      sponsorSecretKey,
      asset,
      amount,
      claimableUntil,
    } = params;

    const sponsorKp = Keypair.fromSecret(sponsorSecretKey);

    // Asset
    let stellarAsset: Asset;
    if (asset.toUpperCase() === "XLM" || asset.toUpperCase() === "NATIVE") {
      stellarAsset = Asset.native();
    } else if (asset.toUpperCase() === "USDC") {
      stellarAsset = new Asset("USDC", this.usdcIssuer);
    } else {
      const [assetCode, assetIssuer] = asset.split(":");
      if (!assetCode || !assetIssuer) {
        throw new Error(`Formato de asset inválido: "${asset}". Usa "CODE:ISSUER" o "XLM"`);
      }
      stellarAsset = new Asset(assetCode, assetIssuer);
    }

    // Predicate para el claimant real: abs_before(claimableUntil)
    const absBefore = BigInt(Math.floor(claimableUntil.getTime() / 1000));
    const predicate = xdr.ClaimPredicate.claimPredicateBeforeAbsoluteTime(absBefore);

    // Claimant real (destinatario) con predicate de expiración
    const claimant = new Claimant(claimantAddress, predicate);

    // Claimant de reverso (sponsor) con predicate unconditional
    const sponsorClaimant = new Claimant(
      Keypair.fromSecret(sponsorSecretKey).publicKey(),
      xdr.ClaimPredicate.claimPredicateUnconditional()
    );

    // Cargar cuenta del sponsor
    const sponsorAcc = await this.horizon.loadAccount(Keypair.fromSecret(sponsorSecretKey).publicKey());

    // Fondear sponsor si no tiene XLM suficiente
    await this.asegurarFondeoSponsor(Keypair.fromSecret(sponsorSecretKey).publicKey());

    // Construir transacción: crear Claimable Balance con dos claimants
    const transaction = new TransactionBuilder(sponsorAcc, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.createClaimableBalance({
          asset: stellarAsset,
          amount: amount.toString(),
          claimants: [claimant, sponsorClaimant],
          source: sponsorKp.publicKey(),
        }),
      )
      .setTimeout(180)
      .build();

    // Firmar con el sponsor
    transaction.sign(Keypair.fromSecret(sponsorSecretKey));

    // Enviar
    const result = await this.horizon.submitTransaction(transaction);

    // Extraer balance ID de los efectos
    let balanceId = "";
    try {
      const effects = await this.horizon.effects().forTransaction(result.hash).call();
      const claimableEffect = effects.records.find(
        (e: any) => e.type === "claimable_balance_created",
      );
      if (claimableEffect) {
        // @ts-ignore - balance_id may not be in type
        balanceId = claimableEffect.balance_id;
      }
    } catch {
      balanceId = result.hash;
    }

    return {
      balanceId: balanceId || result.hash,
      txHash: result.hash,
    };
  }

  /**
   * Asegura que el sponsor tenga XLM suficiente (Friendbot).
   */
  private async asegurarFondeoSponsor(publicKey: string): Promise<void> {
    try {
      await this.horizon.loadAccount(publicKey);
      return; // Ya existe
    } catch {
      // No existe, fondear con Friendbot
      const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
      if (!response.ok) {
        throw new Error(`Friendbot failed: ${response.statusText}`);
      }
      // Esperar a que la cuenta exista
      await this.esperarCuenta(publicKey);
    }
  }

  /**
   * Reclama un Claimable Balance (claimClaimableBalance) con fee-bump del sponsor.
   */
  async reclamarClaimableBalance(params: {
    balanceId: string;
    claimantSecretKey: string;
    sponsorSecretKey: string;
  }): Promise<{ txHash: string }> {
    const { balanceId, claimantSecretKey, sponsorSecretKey } = params;

    const claimantKp = Keypair.fromSecret(claimantSecretKey);
    const sponsorKp = Keypair.fromSecret(sponsorSecretKey);

    const transaction = new TransactionBuilder(
      await this.horizon.loadAccount(sponsorKp.publicKey()),
      {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId,
          source: claimantKp.publicKey(),
        }),
      )
      .setTimeout(180)
      .build();

    // Fee-bump: sponsor paga las fees
    transaction.sign(Keypair.fromSecret(sponsorSecretKey));
    // El claimant firma la operación de claim
    transaction.sign(Keypair.fromSecret(claimantSecretKey));

    const result = await this.horizon.submitTransaction(transaction);
    return { txHash: result.hash };
  }

  /**
   * Obtiene el estado de una transacción.
   */
  async obtenerEstadoTransaccion(txHash: string): Promise<{ successful: boolean }> {
    try {
      const tx = await this.horizon.transactions().transaction(txHash).call();
      return { successful: tx.successful };
    } catch {
      return { successful: false };
    }
  }

  /**
   * Verifica si existe un Claimable Balance y obtiene su último tx.
   */
  async obtenerBalance(balanceId: string): Promise<{
    exists: boolean;
    balance?: any;
  }> {
    try {
      const balance = await this.horizon
        .claimableBalances()
        .claimableBalance(balanceId)
        .call();
      return {
        exists: true,
        balance,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Fondea una cuenta en Testnet via Friendbot.
   */
  async fondearConFriendbot(publicKey: string): Promise<void> {
    const response = await fetch(
      `https://friendbot.stellar.org?addr=${publicKey}`,
    );
    if (!response.ok) {
      throw new Error(`Friendbot failed: ${response.statusText}`);
    }
    await this.esperarCuenta(publicKey);
  }

  /**
   * Espera a que una cuenta exista en Horizon.
   */
  async esperarCuenta(publicKey: string, maxAttempts = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.horizon.loadAccount(publicKey);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`Cuenta ${publicKey} no apareció en Horizon tras ${maxAttempts}s`);
  }

  /**
   * Genera un keypair aleatorio para tests.
   */
  static async generarKeypair(): Promise<{ secretKey: string; publicKey: string }> {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const kp = Keypair.random();
    return { secretKey: kp.secret(), publicKey: kp.publicKey() };
  }
}