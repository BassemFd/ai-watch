// Les portes : du code pur, aucun modèle. Tout ce qui est publié passe par ici.
import type { Reason, Text } from "./schema.ts";

export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Ce qui désigne un rejet dans la trace : 200 caractères au plus par langue. */
export const capped = (what: Text): Text => ({ fr: what.fr.slice(0, 200), en: what.en.slice(0, 200) });

/** null si la citation figure mot pour mot dans la page, sinon le code de la raison du rejet. */
export function quoteProblem(quote: string, page: string): Reason | null {
  const q = normalize(quote);
  if (q.length < 20) return "quote_too_short";
  if (q.length > 300) return "quote_too_long";
  if (!normalize(page).includes(q)) return "quote_not_found";
  return null;
}

/**
 * null si l'énoncé peut être publié. Tout ce qui n'est pas explicitement validé est refusé :
 * un verdict manquant vaut un rejet.
 */
export function statementProblem(
  s: { id: string; claimIds: string[] },
  literalClaims: ReadonlySet<string>,
  judgedClaims: ReadonlySet<string>,
  judgedStatements: ReadonlySet<string>,
): Reason | null {
  if (!s.claimIds.length) return "no_claim_cited";
  if (s.claimIds.some((id) => !literalClaims.has(id))) return "unknown_claim";
  if (s.claimIds.some((id) => !judgedClaims.has(id))) return "claim_unsupported";
  if (!judgedStatements.has(s.id)) return "statement_unsupported";
  return null;
}
