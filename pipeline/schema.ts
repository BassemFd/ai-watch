import { z } from "zod";

export const SECTIONS = [
  { id: "modeles", title: "Modèles" },
  { id: "agents", title: "Agents et harness" },
  { id: "outils", title: "Outils de développement" },
  { id: "evals", title: "Évaluation et sécurité" },
  { id: "open", title: "Open source et recherche" },
] as const;
export const RINGS = ["adopter", "essayer", "evaluer", "attendre"] as const;

const SectionId = z.enum(["modeles", "agents", "outils", "evals", "open"]);
const Ring = z.enum(RINGS);

export const Source = z.object({
  id: z.string(),
  name: z.string(),
  feed: z.string(),
  domains: z.array(z.string()),
  max: z.number().optional(),
});
export type Source = z.infer<typeof Source>;

export type Item = { id: string; url: string; title: string; source: string; summary: string };

export const Claim = z.object({ id: z.string(), text: z.string(), quote: z.string(), url: z.string() });
export type Claim = z.infer<typeof Claim>;

/** Un énoncé du brouillon, tel que soumis au vérificateur. */
export type Statement = { id: string; text: string; claimIds: string[] };

// --- Sorties des modèles (schémas simples : contraintes vérifiées par le code, pas par le modèle)

export const TriageOut = z.object({
  picks: z.array(z.object({ id: z.string(), score: z.number(), reason: z.string() })),
});
export const ResearchOut = z.object({
  claims: z.array(z.object({ text: z.string(), quote: z.string() })),
});
export const WriteOut = z.object({
  headline: z.string(),
  items: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      summary: z.string(),
      why: z.string(),
      claimIds: z.array(z.string()),
    }),
  ),
  radar: z.array(z.object({ name: z.string(), ring: Ring, rationale: z.string(), claimIds: z.array(z.string()) })),
  state: z.array(z.object({ sectionId: SectionId, text: z.string(), claimIds: z.array(z.string()) })),
});
export const VerifyOut = z.object({
  claims: z.array(z.object({ id: z.string(), supported: z.boolean(), reason: z.string() })),
  statements: z.array(z.object({ id: z.string(), supported: z.boolean(), reason: z.string() })),
});
export type VerifyOut = z.infer<typeof VerifyOut>;

// --- Fichiers publiés (lus par le site, qui les revalide au build)

export const Brief = z.object({
  date: z.string(),
  headline: z.string(),
  items: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      source: z.string(),
      summary: z.string(),
      why: z.string(),
      claims: z.array(Claim),
    }),
  ),
});
export type Brief = z.infer<typeof Brief>;

export const Radar = z.object({
  entries: z.array(
    z.object({
      name: z.string(),
      ring: Ring,
      rationale: z.string(),
      evidence: z.array(Claim),
      since: z.string(),
      history: z.array(z.object({ date: z.string(), ring: Ring })),
    }),
  ),
});
export type Radar = z.infer<typeof Radar>;

export const State = z.object({
  points: z.array(z.object({ date: z.string(), sectionId: SectionId, text: z.string(), evidence: z.array(Claim) })),
});
export type State = z.infer<typeof State>;

export const Trace = z.object({
  date: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  status: z.enum(["published", "rejected", "empty", "error"]),
  error: z.string().optional(),
  counts: z.record(z.string(), z.number()),
  stages: z.array(
    z.object({
      stage: z.string(),
      model: z.string(),
      ms: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
    }),
  ),
  gates: z.array(z.object({ name: z.string(), pass: z.boolean(), detail: z.string() })),
  rejected: z.array(z.object({ what: z.string(), reason: z.string() })),
  costUsd: z.number(),
});
export type Trace = z.infer<typeof Trace>;

export const EvalReport = z.object({
  date: z.string(),
  total: z.number(),
  passed: z.number(),
  failures: z.array(z.string()),
  costUsd: z.number(),
});
