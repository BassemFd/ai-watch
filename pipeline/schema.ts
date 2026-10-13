import { z } from "zod";

export const SECTIONS = [
  { id: "modeles", title: "Modèles" },
  { id: "agents", title: "Agents et harness" },
  { id: "outils", title: "Outils de développement" },
  { id: "evals", title: "Évaluation et sécurité" },
  { id: "open", title: "Open source et recherche" },
] as const;
export const RINGS = ["adopter", "essayer", "evaluer", "attendre"] as const;

/** Codes des raisons de rejet et des portes : le site les traduit. */
export const REASONS = [
  "quote_too_short",
  "quote_too_long",
  "quote_not_found",
  "no_claim_cited",
  "unknown_claim",
  "source_not_fetched",
  "claim_unsupported",
  "statement_unsupported",
  "feed_unreadable",
  "item_failed",
] as const;
export type Reason = (typeof REASONS)[number];
export const GATES = ["literal_quotes", "supported_claims", "verifier", "volume", "budget"] as const;

const SectionId = z.enum(SECTIONS.map((s) => s.id));
const Ring = z.enum(RINGS);

/** Un texte publié : la même chose dite en français et en anglais. */
export const Text = z.object({ fr: z.string(), en: z.string() });
export type Text = z.infer<typeof Text>;
/** Un nom propre ou un titre d'origine : identique dans les deux langues. */
export const untranslated = (s: string): Text => ({ fr: s, en: s });

export const Source = z.object({
  id: z.string(),
  name: z.string(),
  feed: z.string(),
  domains: z.array(z.string()),
  /** Préfixes de chemin lisibles sur ces domaines ; vide ou absent : tout le domaine. */
  paths: z.array(z.string()).optional(),
  max: z.number().optional(),
  /** Sujets au plus par run pour cette source (2 par défaut). */
  maxPicks: z.number().optional(),
});
export type Source = z.infer<typeof Source>;

export type Item = { id: string; url: string; title: string; source: string; summary: string };

export const Claim = z.object({ id: z.string(), text: Text, quote: z.string(), url: z.string() });
export type Claim = z.infer<typeof Claim>;

/** Un énoncé du brouillon, tel que soumis au vérificateur. */
export type Statement = { id: string; text: string; claimIds: string[] };

// --- Sorties des modèles (schémas simples : contraintes vérifiées par le code, pas par le modèle)

export const TriageOut = z.object({
  picks: z.array(z.object({ id: z.string(), score: z.number(), reason: z.string() })),
});
export const ResearchOut = z.object({
  claims: z.array(z.object({ text: Text, quote: z.string(), url: z.string() })),
});
export const WriteOut = z.object({
  headline: Text,
  items: z.array(
    z.object({
      itemId: z.string(),
      title: Text,
      summary: Text,
      why: Text,
      claimIds: z.array(z.string()),
    }),
  ),
  radar: z.array(z.object({ name: z.string(), ring: Ring, rationale: Text, claimIds: z.array(z.string()) })),
  state: z.array(z.object({ sectionId: SectionId, text: Text, claimIds: z.array(z.string()) })),
});
export type WriteOut = z.infer<typeof WriteOut>;
export const VerifyOut = z.object({
  claims: z.array(z.object({ id: z.string(), supported: z.boolean(), reason: z.string() })),
  statements: z.array(z.object({ id: z.string(), supported: z.boolean(), reason: z.string() })),
});
export type VerifyOut = z.infer<typeof VerifyOut>;

// --- Fichiers publiés (lus par le site, qui les revalide au build)

export const Brief = z.object({
  date: z.string(),
  headline: Text,
  items: z.array(
    z.object({
      title: Text,
      url: z.string(),
      source: z.string(),
      summary: Text,
      why: Text,
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
      rationale: Text,
      evidence: z.array(Claim),
      since: z.string(),
      history: z.array(z.object({ date: z.string(), ring: Ring })),
    }),
  ),
});
export type Radar = z.infer<typeof Radar>;

export const State = z.object({
  points: z.array(z.object({ date: z.string(), sectionId: SectionId, text: Text, evidence: z.array(Claim) })),
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
  gates: z.array(z.object({ name: z.enum(GATES), pass: z.boolean(), detail: z.string() })),
  rejected: z.array(z.object({ what: Text, reason: z.enum(REASONS), detail: z.string().optional() })),
  toolCalls: z.array(
    z.object({ item: z.string(), tool: z.string(), input: z.string(), ok: z.boolean(), detail: z.string().optional(), ms: z.number() }),
  ),
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
