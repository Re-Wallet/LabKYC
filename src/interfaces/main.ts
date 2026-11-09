import Fastify from "fastify";
import { usersRoutes } from "./routes/users";
import { kycRoutes } from "./routes/kyc";
import { walletRoutes } from "./routes/wallets";
import { ledgerRoutes } from "./routes/ledger";
import { transfersRoutes } from "./routes/transfers";
import { claimsRoutes } from "./routes/claims";
import { feesRoutes } from "./routes/fees";
import { jobsRoutes } from "./routes/jobs";
import { registrarRawBody } from "./rawBody";

export function buildApp() {
  const app = Fastify({ logger: true });

  // El body crudo se necesita para validar la firma HMAC del webhook de Didit.
  registrarRawBody(app);

  app.register(usersRoutes);
  app.register(kycRoutes);
  app.register(walletRoutes);
  app.register(ledgerRoutes);
  app.register(transfersRoutes);
  app.register(claimsRoutes);
  app.register(feesRoutes);
  app.register(jobsRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

export const app = buildApp();

async function start() {
  const port = Number(process.env.APP_PORT) || 8000;
  const host = process.env.APP_HOST || "0.0.0.0";
  try {
    await app.listen({ port, host });
    console.log(`LabKYC escuchando en http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  void start();
}
