import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PostgresWalletRepository } from "../../infrastructure/walletRepo";

const crearSchema = z.object({
  userId: z.string().uuid(),
  chain: z.string().default("stellar"),
  address: z.string().min(1),
  signingProvider: z.string(),
  turnkeySubOrgId: z.string().optional().nullable(),
});

export const walletRoutes: FastifyPluginAsync = async (fastify) => {
  const walletRepo = new PostgresWalletRepository();

  fastify.post("/wallets", async (request, reply) => {
    const parsed = crearSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });
    try {
      const wallet = await walletRepo.crear({
        userId: parsed.data.userId,
        chain: parsed.data.chain,
        address: parsed.data.address,
        signingProvider: parsed.data.signingProvider,
        turnkeySubOrgId: parsed.data.turnkeySubOrgId ?? null,
        status: "pending_kyc",
      });
      return reply.status(201).send(wallet);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  fastify.get("/wallets/me", async (request, reply) => {
    const { userId } = request.query as { userId?: string };
    if (!userId) return reply.status(400).send({ error: "userId requerido" });
    const wallet = await walletRepo.obtenerPorUsuario(userId);
    if (!wallet) return reply.status(404).send({ error: "wallet no encontrada" });
    return reply.status(200).send(wallet);
  });
};
