import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { KYCUseCases } from "../../application/kyc";
import { PostgresKYCVerificationRepository } from "../../infrastructure/kycRepo";
import { PostgresWebhookEventRepository } from "../../infrastructure/webhookRepo";
import { DiditHTTPClient, DiditMockClient } from "../../infrastructure/diditClient";
import { PostgresUserRepository } from "../../infrastructure/userRepo";
import { PostgresWalletRepository } from "../../infrastructure/walletRepo";
import { obtenerRawBody } from "../rawBody";

const startSchema = z.object({ userId: z.string().uuid(), callbackUrl: z.string().url() });

export const kycRoutes: FastifyPluginAsync = async (fastify) => {
  const mockDidit = process.env.MOCK_DIDIT === "true";

  const diditClient = mockDidit
    ? new DiditMockClient()
    : new DiditHTTPClient(
        process.env.DIDIT_API_BASE_URL ?? "https://verification.didit.me/v3",
        process.env.DIDIT_API_KEY ?? "",
      );

  const kycUseCases = new KYCUseCases(
    new PostgresKYCVerificationRepository(),
    new PostgresWebhookEventRepository(),
    diditClient,
    new PostgresUserRepository(),
    new PostgresWalletRepository(),
    process.env.DIDIT_WORKFLOW_ID || "workflow_test",
    process.env.DIDIT_WEBHOOK_SECRET || "secret_test",
  );

  fastify.post("/kyc/start", async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });
    try {
      const resultado = await kycUseCases.iniciarKYC(parsed.data);
      return reply.status(200).send(resultado);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  fastify.post("/webhooks/didit", async (request, reply) => {
    // La firma se valida sobre el body CRUDO, no sobre el objeto parseado.
    const rawBody = obtenerRawBody(request as never);
    const signatureHeader = (request.headers["x-signature-v2"] as string) || null;
    const timestampHeader = (request.headers["x-timestamp"] as string) || null;
    try {
      const resultado = await kycUseCases.procesarWebhook({ rawBody, signatureHeader, timestampHeader });
      return reply.status(200).send({ ok: true, ...resultado });
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });
};
