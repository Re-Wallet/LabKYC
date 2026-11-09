import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildContainer } from "../../composition";

const crearClaimSchema = z.object({
  senderId: z.string().uuid(),
  recipientTag: z.string(),
  amount: z.number().positive(),
  asset: z.string().default("USDC"),
  idempotencyKey: z.string().min(1),
  recipientEmail: z.string().email().optional(),
});

const redimirSchema = z.object({
  email: z.string().email(),
  phone: z.string().optional(),
  tagDeseado: z.string().optional(),
});

export const claimsRoutes: FastifyPluginAsync = async (fastify) => {
  const { claims } = buildContainer();

  // POST /transfers/claim — envío a tag sin usuario
  fastify.post("/transfers/claim", async (request, reply) => {
    const parsed = crearClaimSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });
    try {
      const resultado = await claims.crearClaim(parsed.data);
      return reply.status(201).send(resultado);
    } catch (e: any) {
      if (e.name === "ClaimError") return reply.status(400).send({ error: e.message });
      throw e;
    }
  });

  // GET /claims/:token — vista pública (monto, remitente, estado)
  fastify.get("/claims/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const resumen = await claims.consultarClaim(token);
      return reply.status(200).send({
        amount: resumen.amount,
        asset: resumen.asset,
        sender_tag: resumen.senderTag,
        status: resumen.status,
        expires_at: resumen.expiresAt,
      });
    } catch (e: any) {
      if (e.name === "ClaimError") return reply.status(404).send({ error: e.message });
      throw e;
    }
  });

  // POST /claims/:token/redeem — registra/vincula usuario y dispara KYC
  fastify.post("/claims/:token/redeem", async (request, reply) => {
    const { token } = request.params as { token: string };
    const parsed = redimirSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });
    try {
      const resultado = await claims.redimirClaim({
        claimToken: token,
        email: parsed.data.email,
        phone: parsed.data.phone ?? null,
        tagDeseado: parsed.data.tagDeseado ?? null,
      });
      return reply.status(200).send({
        next: resultado.next,
        url: resultado.url,
        claim_id: resultado.claimId,
        user_id: resultado.userId,
      });
    } catch (e: any) {
      if (e.name === "ClaimError") return reply.status(400).send({ error: e.message });
      throw e;
    }
  });
};
