import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LedgerUseCases } from "../../application/ledger";
import { PostgresLedgerService } from "../../infrastructure/ledgerRepo";
import type { AsientoInput } from "../../domain/ledger";

const cuentaSchema = z.object({
  userId: z.string().uuid().optional().nullable(),
  walletId: z.string().uuid().optional().nullable(),
  accountType: z.string(),
});

const asientoSchema = z.object({
  cuenta: cuentaSchema,
  direction: z.enum(["debit", "credit"]),
  amount: z.number().positive(),
  asset: z.string(),
  entryType: z.string(),
  referenceTransferId: z.string().uuid().optional().nullable(),
  referenceClaimId: z.string().uuid().optional().nullable(),
  referenceExternalId: z.string().optional().nullable(),
});

export const ledgerRoutes: FastifyPluginAsync = async (fastify) => {
  const ledger = new LedgerUseCases(new PostgresLedgerService());

  fastify.post("/ledger/asiento", async (request, reply) => {
    const parsed = asientoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });
    try {
      const asiento: AsientoInput = { ...parsed.data, grupoId: crypto.randomUUID() };
      await ledger.crearAsiento(asiento);
      return reply.status(201).send({ ok: true, grupoId: asiento.grupoId });
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  fastify.post("/ledger/grupo", async (request, reply) => {
    const parsed = z.array(asientoSchema).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });
    try {
      const grupoId = await ledger.crearGrupo(parsed.data);
      return reply.status(201).send({ ok: true, grupoId });
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });
};
