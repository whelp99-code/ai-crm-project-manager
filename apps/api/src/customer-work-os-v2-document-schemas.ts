import { z } from "zod";

const money = z.string().regex(/^\d+$/).max(30);
export const contractTermsSchema = z.object({
  startDate: z.string().date().nullable(),
  endDate: z.string().date().nullable(),
  valueKrw: money.nullable(),
  items: z.array(z.object({
    id: z.string().trim().min(1), description: z.string().trim().min(1).max(2000),
    quantity: z.number().int().positive().max(1_000_000),
    unitPriceKrw: money.nullable(),
  }).strict()).max(100).nullable(),
  conditions: z.array(z.string().trim().min(1).max(5000)).max(100).nullable(),
}).strict();

export const contractDraftCommandSchema = z.object({
  renewalId: z.string().trim().min(1),
  revisionId: z.string().trim().min(1),
  revisionLabel: z.string().trim().min(1).max(200),
  source: z.object({
    kind: z.enum(["NORMALIZED", "OWNER_INPUT"]),
    id: z.string().trim().min(1),
    version: z.number().int().positive().nullable(),
    reference: z.string().trim().min(1).max(2000),
    terms: contractTermsSchema,
  }).strict(),
  terms: contractTermsSchema,
}).strict();

export const renewalDraftRequestSchema = z.object({
  action: z.literal("RENEWAL"),
  expectedVersion: z.number().int().nonnegative(),
  renewalId: z.string().trim().min(1),
  revisionId: z.string().trim().min(1),
  revisionLabel: z.string().trim().min(1).max(200),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("NORMALIZED"), id: z.string().trim().min(1), version: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal("OWNER_INPUT"), id: z.string().trim().min(1),
      reference: z.string().trim().min(1).max(2000), terms: contractTermsSchema }).strict(),
  ]),
  terms: contractTermsSchema,
}).strict();
