import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { RegistrarUsuarioUseCase } from "../../application/users";
import { PostgresUserRepository } from "../../infrastructure/userRepo";
import { PostgresComplianceProfileRepository } from "../../infrastructure/complianceRepo";
import { PostgresTagHistoryRepository } from "../../infrastructure/tagHistoryRepo";

const schema = z.object({
  tag: z.string(),
  email: z.string().email(),
  phone_number: z.string().optional(),
});

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/users", async (request, reply) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "datos inválidos", details: parsed.error.flatten() });
    }
    const { tag, email, phone_number } = parsed.data;

    const useCase = new RegistrarUsuarioUseCase(
      new PostgresUserRepository(),
      new PostgresComplianceProfileRepository(),
      new PostgresTagHistoryRepository()
    );

    try {
      const resultado = await useCase.ejecutar({ tag, email, phone_number });
      return reply.status(201).send(resultado);
    } catch (e: any) {
      if (e.name === "TagInvalido" || e.name === "TagReservado") return reply.status(400).send({ error: e.message });
      if (e.name === "TagDuplicado" || e.name === "EmailDuplicado") return reply.status(409).send({ error: e.message });
      throw e;
    }
  });
};
