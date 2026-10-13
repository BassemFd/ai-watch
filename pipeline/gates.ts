// Les portes : du code pur, aucun modèle. Tout ce qui est publié passe par ici.

export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** null si la citation figure mot pour mot dans la page, sinon la raison du rejet. */
export function quoteProblem(quote: string, page: string): string | null {
  const q = normalize(quote);
  if (q.length < 20) return "citation trop courte";
  if (q.length > 300) return "citation trop longue";
  if (!normalize(page).includes(q)) return "citation introuvable dans la source";
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
): string | null {
  if (!s.claimIds.length) return "aucune source citée";
  if (s.claimIds.some((id) => !literalClaims.has(id))) return "cite un fait absent des fiches vérifiées";
  if (s.claimIds.some((id) => !judgedClaims.has(id))) return "s'appuie sur un fait que sa citation ne soutient pas";
  if (!judgedStatements.has(s.id)) return "le vérificateur ne valide pas cet énoncé";
  return null;
}
