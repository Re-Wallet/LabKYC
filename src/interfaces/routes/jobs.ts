import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildContainer } from "../../composition";

const schema = z.object({
  job: z.enum(["expiracion", "reconciliacion"]),
});

/**
 * Disparo manual de los jobs (útil en el lab y para probar sin esperar timers).
 * POST /jobs/expiracion      -> revierte claims vencidos
 * POST /jobs/reconciliacion  -> alinea on-chain con ledger
 */
export const jobsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/jobs/:job", async (request, reply) => {
    const { job } = request.params as { job: string };
    const parsed = schema.safeParse({ job });
    if (!parsed.success) {
      return reply.status(400).send({ error: "job inválido", jobs: ["expiracion", "reconciliacion"] });
    }

    try {
      const { expiration, reconciliation } = buildContainer();
      if (parsed.data.job === "expiracion") {
        const resultado = await expiration.expirarClaimsVencidos();
        return reply.status(200).send({ job: "expiracion", ...resultado });
      }
      const resultado = await reconciliation.reconciliar();
      return reply.status(200).send({ job: "reconciliacion", ...resultado });
    } catch (e: any) {
      return reply.status(500).send({ error: e?.message ?? "error en job" });
    }
  });
};
