import { Horizon, Keypair, TransactionBuilder, Networks, Operation, Asset, BASE_FEE, xdr, Claimant } from "@stellar/stellar-sdk";

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

  async crearClaimableBalanceSponsored(params: {
    senderPublicKey: string;
    claimantAddress: string;
    claimantSecretKey: string;
    sponsorSecretKey: string;
    asset: string;
    amount: number;
    claimableUntil: Date;
  }): Promise<{ balanceId: string; txHash: string; operationCount: number }> {
    const {
      claimantAddress,
      claimantSecretKey,
      sponsorSecretKey,
      asset,
      amount,
      claimableUntil,
    } = params;

    const sponsorKp = Keypair.fromSecret(sponsorSecretKey);

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

    const absBefore = BigInt(Math.floor(claimableUntil.getTime() / 1000));
    const predicate = xdr.ClaimPredicate.claimPredicateBeforeAbsoluteTime(absBefore);

    const sponsorAcc = await this.horizon.loadAccount(sponsorKp.publicKey());

    await this.asegurarFondeoSponsor(sponsorKp.publicKey());
    await this.asegurarCuentaClaimant(sponsorSecretKey, claimantAddress);

    if (asset.toUpperCase() !== "XLM" && asset.toUpperCase() !== "NATIVE") {
      await this.establecerTrustline(sponsorSecretKey, claimantSecretKey, stellarAsset);
    }

    const transaction = new TransactionBuilder(sponsorAcc, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.createClaimableBalance({
          asset: stellarAsset,
          amount: amount.toString(),
          claimants: [
            new Claimant(claimantAddress, xdr.ClaimPredicate.claimPredicateBeforeAbsoluteTime(BigInt(Math.floor(claimableUntil.getTime() / 1000)))),
            new Claimant(sponsorKp.publicKey(), xdr.ClaimPredicate.claimPredicateUnconditional()),
          ],
          source: sponsorKp.publicKey(),
        }),
      )
      .setTimeout(180)
      .build();

    transaction.sign(Keypair.fromSecret(sponsorSecretKey));
    const result = await this.horizon.submitTransaction(transaction);

    let balanceId = "";
    try {
      const effects = await this.horizon.effects().forTransaction(result.hash).call();
      const claimableEffect = effects.records.find((e: any) => e.type === "claimable_balance_created");
      if (claimableEffect) {
        balanceId = (claimableEffect as any).balance_id;
      }
    } catch {
      balanceId = result.hash;
    }

    return {
      balanceId: balanceId || result.hash,
      txHash: result.hash,
      operationCount: transaction.operations.length,
    };
  }

  private async asegurarFondeoSponsor(publicKey: string): Promise<void> {
    try {
      await this.horizon.loadAccount(publicKey);
      return;
    } catch {
      const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
      if (!response.ok) throw new Error(`Friendbot failed: ${response.statusText}`);
      await this.esperarCuenta(publicKey);
    }
  }

  private async asegurarCuentaClaimant(sponsorSecretKey: string, claimantAddress: string): Promise<void> {
    try {
      await this.horizon.loadAccount(claimantAddress);
      return;
    } catch {
      const sponsorKp = Keypair.fromSecret(sponsorSecretKey);
      const sponsorAcc = await this.horizon.loadAccount(sponsorKp.publicKey());
      const tx = new TransactionBuilder(sponsorAcc, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
        .addOperation(Operation.createAccount({ destination: claimantAddress, startingBalance: "1" }))
        .setTimeout(180)
        .build();
      tx.sign(Keypair.fromSecret(sponsorSecretKey));
      await this.horizon.submitTransaction(tx);
      await this.esperarCuenta(claimantAddress);
    }
  }

  private async establecerTrustline(sponsorSecretKey: string, claimantSecretKey: string, asset: Asset): Promise<void> {
    if (asset.isNative()) return;
    const claimantKp = Keypair.fromSecret(claimantSecretKey);
    try {
      const account = await this.horizon.loadAccount(claimantKp.publicKey());
      const hasTrustline = account.balances.some((b: any) =>
        b.asset_type === "credit_alphanum4" &&
        b.asset_code === asset.getCode() &&
        b.asset_issuer === asset.getIssuer()
      );
      if (hasTrustline) return;
    } catch {
      // No tiene cuenta, ya se creó arriba
    }
    const account = await this.horizon.loadAccount(claimantKp.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(
        Operation.changeTrust({
          asset: new Asset("USDC", this.usdcIssuer),
          source: claimantKp.publicKey(),
        }),
      )
      .setTimeout(180)
      .build();
    tx.sign(claimantKp);
    await this.horizon.submitTransaction(tx);
  }

  async reclamarClaimableBalance(params: { balanceId: string; claimantSecretKey: string; sponsorSecretKey: string }): Promise<{ txHash: string }> {
    const { balanceId, claimantSecretKey, sponsorSecretKey } = params;
    const claimantKp = Keypair.fromSecret(claimantSecretKey);
    const sponsorKp = Keypair.fromSecret(sponsorSecretKey);
    const tx = new TransactionBuilder(
      await this.horizon.loadAccount(sponsorKp.publicKey()),
      { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
    )
      .addOperation(Operation.claimClaimableBalance({ balanceId, source: claimantKp.publicKey() }))
      .setTimeout(180)
      .build();
    tx.sign(Keypair.fromSecret(sponsorSecretKey));
    tx.sign(Keypair.fromSecret(claimantSecretKey));
    const r = await this.horizon.submitTransaction(tx);
    return { txHash: r.hash };
  }

  async obtenerEstadoTransaccion(txHash: string): Promise<{ successful: boolean }> {
    try { const tx = await this.horizon.transactions().transaction(txHash).call(); return { successful: tx.successful }; }
    catch { return { successful: false }; }
  }

  async obtenerBalance(balanceId: string): Promise<{ exists: boolean; balance?: any }> {
    try { const b = await this.horizon.claimableBalances().claimableBalance(balanceId).call(); return { exists: true, balance: b }; }
    catch { return { exists: false }; }
  }

  async fondearConFriendbot(publicKey: string): Promise<void> {
    const r = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
    if (!r.ok) throw new Error(`Friendbot failed: ${r.statusText}`);
    await this.esperarCuenta(r.url);
  }

  async esperarCuenta(publicKey: string, max = 30): Promise<void> {
    for (let i = 0; i < max; i++) { try { await this.horizon.loadAccount(publicKey); return; } catch { await new Promise(r => setTimeout(r, 1000)); } }
    throw new Error(`Cuenta ${publicKey} no apareció`);
  }

  static async generarKeypair(): Promise<{ secretKey: string; publicKey: string }> {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const kp = Keypair.random();
    return { secretKey: kp.secret(), publicKey: kp.publicKey() };
  }
}