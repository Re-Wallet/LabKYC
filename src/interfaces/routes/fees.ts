import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildContainer } from "../../composition";

const schema = z.object({
  operation_type: z.enum(["on_ramp", "off_ramp", "p2p_transfer", "withdrawal"]),
  fiat_currency: z.string().optional(),
  crypto_asset: z.string().optional(),
  provider: z.string().optional(),
  gross: z.number().nonnegative(),
});

export const feesRoutes: FastifyPluginAsync = async (fastify) => {
  const { fees } = buildContainer();

  fastify.post("/fees/calculate", async (request, reply) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "datos inválidos" });

    const { operation_type, fiat_currency, crypto_asset, provider, gross } = parsed.data;
    const resultado = await fees.calcularFee({
      operationType: operation_type,
      fiatCurrency: fiat_currency ?? null,
      cryptoAsset: crypto_asset ?? null,
      provider: provider ?? null,
      gross,
    });

    return reply.status(200).send({
      fee: resultado.fee,
      config_id: resultado.config?.id ?? null,
      config_name: resultado.config?.name ?? null,
      fee_type: resultado.config?.feeType ?? null,
      fee_payer: resultado.config?.feePayer ?? null,
      asset_charged_in: resultado.config?.assetChargedIn ?? null,
    });
  });
};
