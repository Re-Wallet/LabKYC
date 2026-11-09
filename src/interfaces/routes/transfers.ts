import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { TransferUseCases } from "../../application/transfer";
import { PostgresTransferRepository } from "../../infrastructure/transferRepo";
import { PostgresUserRepository } from "../../infrastructure/userRepo";
import { PostgresWalletRepository } from "../../infrastructure/walletRepo";
import { PostgresLedgerService } from "../../infrastructure/ledgerRepo";
import { PostgresComplianceProfileRepository } from "../../infrastructure/complianceRepo";

const transferSchema = z.object({
  senderId: z.string().uuid(),
  recipientTag: z.string(),
  amount: z.number().positive(),
  asset: z.string().default("USDC"),
  idempotencyKey: z.string(),
});

export const transfersRoutes: FastifyPluginAsync = async (fastify) => {
  const transferUseCases = new TransferUseCases(
    new PostgresTransferRepository(),
    new PostgresUserRepository(),
    new PostgresWalletRepository(),
    new PostgresLedgerService(),
    new PostgresComplianceProfileRepository()
  );

  fastify.post("/transfers", async (request, reply) => {
    const parsed = transferSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });
    try {
      const resultado = await transferUseCases.transferir(parsed.data);
      return reply.status(201).send(resultado);
    } catch (e: any) {
      if (e.name === "TransferError") return reply.status(400).send({ error: e.message });
      throw e;
    }
  });
};
