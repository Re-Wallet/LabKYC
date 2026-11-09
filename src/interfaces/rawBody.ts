import { FastifyInstance } from "fastify";

/**
 * Captura el body crudo de las requests JSON.
 *
 * Es indispensable para validar la firma HMAC-SHA256 del webhook de Didit:
 * la firma se calcula sobre los bytes EXACTOS recibidos, no sobre el objeto
 * re-serializado (el orden de las claves y los espacios cambiarían el hash).
 */
export function registrarRawBody(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      (req as unknown as { rawBody: string }).rawBody = raw;
      try {
        done(null, raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}

export function obtenerRawBody(request: { rawBody?: string; body?: unknown }): string {
  if (typeof request.rawBody === "string") return request.rawBody;
  return JSON.stringify(request.body ?? {});
}
