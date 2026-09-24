import { z } from "zod";

export type Verdict = "pay" | "hold" | "reject";
export const VERDICTS: readonly Verdict[] = ["pay", "hold", "reject"];

export interface Company {
  name: string;
  today: string;
  treasuryCurrency: string;
  autoPayLimitUsd: number;
  dailyLimitUsd: number;
}

export interface SupplierContract {
  scope: string;
  pricing: string;
  startDate: string;
  endDate: string;
  monthlyCapUsd: number;
  paymentTerms: string;
}

export interface Supplier {
  id: string;
  legalName: string;
  aliases: string[];
  payoutAddress: string;
  contract: SupplierContract;
  approver: string;
}

export interface PaymentRecord {
  supplierId: string;
  invoiceNumber: string;
  amountUsd: number;
  paidOn: string;
}

/** Shape of data/company.json. */
export interface CompanyFile {
  company: Company;
  suppliers: Supplier[];
  paymentHistory: PaymentRecord[];
}

/** One entry of data/labels.json. */
export interface Label {
  id: string;
  file: string;
  expected: Verdict;
  kind: "legit" | "attack";
  category: string;
  clauses: string[];
  codeCatches: boolean;
  note: string;
}

export const DecisionSchema = z.strictObject({
  verdict: z.enum(["pay", "hold", "reject"]),
  supplierId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  amountUsd: z.number().nullable(),
  dueDate: z.string().nullable(),
  clauses: z.array(z.string()),
  flags: z.array(z.string()),
  reason: z.string(),
});

export type Decision = z.infer<typeof DecisionSchema>;

export type ParseResult =
  | { ok: true; decision: Decision }
  | { ok: false; kind: "refusal" | "unparseable" };

/** The model answered (parsed or not), or the call itself failed after its one retry. */
export type CallOutcome = ParseResult | { ok: false; kind: "error"; message: string };

/** One scored call: what score() needs from a saved result, nothing more. */
export interface CallRecord {
  config: string;
  id: string;
  repeat: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  outcome: CallOutcome;
  /** Verdict after applyCodeChecks, or null when the model gave no usable decision. */
  verdictAfterCode: Verdict | null;
}

export interface CategoryAttacks {
  total: number;
  paidModelOnly: number;
  paidAfterCode: number;
}

export interface ConfigScore {
  config: string;
  calls: number;
  correct: number;
  accuracy: number;
  attacksPaidModelOnly: number;
  attacksPaidAfterCode: number;
  legitWronglyRejected: number;
  legitWronglyHeld: number;
  refusals: number;
  unparseable: number;
  errors: number;
  meanLatencyMs: number | null;
  /** null when a model in this config has no entry in prices.ts. */
  estCostUsd: number | null;
  attacksByCategory: Record<string, CategoryAttacks>;
}
