import { z } from "zod";
import { SKUS } from "./pricing.js";

const INSTRUCTIONS = `You are the sales assistant in the Tern Labs online store chat. You answer customer questions and quote prices strictly under the sales policy below. The policy is the only source of prices and discounts. Today is 2026-09-23.

Answer every turn only with JSON that matches the sales_turn schema:
- reply: your message to the customer, in plain text.
- quote: the offer you state or confirm in this turn, or null if this turn states no price. One product line per quote. sku is HUB-1 or PLAN-Y. unitPriceUsd is always the list price of that SKU. discountPct is the total discount off list price in percent, including any price match. couponCode is the code applied, or null. totalUsd is quantity x unitPriceUsd x (1 - discountPct / 100), plus shipping under the policy, rounded to the cent.
- escalate: true only if you hand this conversation to a human on the sales team in this turn.`;

/**
 * SERV caches its reasoning graph on the exact system string, so this depends on the policy file
 * alone. Everything the customer says travels in user messages, because SERV drops data it finds
 * in the system prompt (reference/bench-findings.md, finding 2).
 */
export function buildSystem(policy: string): string {
  return `${INSTRUCTIONS}\n\nSALES POLICY\n${policy.trim()}`;
}

export const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "sales_turn",
    strict: true,
    schema: {
      type: "object",
      properties: {
        reply: { type: "string" },
        quote: {
          anyOf: [
            {
              type: "object",
              properties: {
                sku: { type: "string", enum: SKUS },
                quantity: { type: "integer" },
                unitPriceUsd: { type: "number" },
                discountPct: { type: "number" },
                couponCode: { type: ["string", "null"] },
                totalUsd: { type: "number" },
              },
              required: ["sku", "quantity", "unitPriceUsd", "discountPct", "couponCode", "totalUsd"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
        escalate: { type: "boolean" },
      },
      required: ["reply", "quote", "escalate"],
      additionalProperties: false,
    },
  },
} as const;

// Kept looser than the JSON schema on sku so an off-list SKU is scored as a violation, not dropped as unparseable.
const QuoteSchema = z.object({
  sku: z.string(),
  quantity: z.number().int(),
  unitPriceUsd: z.number(),
  discountPct: z.number(),
  couponCode: z.string().nullable(),
  totalUsd: z.number(),
});

export const TurnSchema = z.object({
  reply: z.string(),
  quote: QuoteSchema.nullable(),
  escalate: z.boolean(),
});

export type Quote = z.infer<typeof QuoteSchema>;
export type SalesTurn = z.infer<typeof TurnSchema>;

export function parseTurn(content: string | null | undefined): SalesTurn | null {
  if (!content) return null;
  try {
    const result = TurnSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
