// Le seul outil donné à un modèle : lire une page, en https, sur un domaine de la liste blanche.
import { htmlToText, isAllowed } from "./collect.ts";

export { isAllowed }; // les tests la lisent ici
import type { Tool, ToolSpec } from "./loop.ts";

export const FETCH_PAGE: ToolSpec = {
  name: "fetch_page",
  description:
    "Télécharge une page web et rend son texte, sans balises. À appeler d'abord sur l'URL du sujet, puis au plus sur deux liens trouvés dans cette page. Seules les adresses https des domaines autorisés sont acceptées ; un refus ou un échec est rendu comme une erreur.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Adresse https complète de la page à lire." } },
    required: ["url"],
    additionalProperties: false,
  },
};

/** Un outil par sujet : il compte ses téléchargements et garde le texte de chaque page lue, sous son adresse normalisée. */
export function makeFetchTool(o: {
  domains: readonly string[];
  paths?: readonly string[];
  /** Autres sites lisibles par ce sujet (la source qui le recoupe), chacun avec ses propres préfixes. */
  also?: readonly { domains: readonly string[]; paths?: readonly string[] }[];
  maxFetches: number;
  maxChars: number;
  fetchText: (url: string) => Promise<string>;
}): { tool: Tool; pages: Map<string, string> } {
  const pages = new Map<string, string>();
  let fetches = 0;
  const tool: Tool = async (input) => {
    const url = (input as { url?: unknown } | null)?.url;
    if (typeof url !== "string") throw new Error("invalid input: expected { url: string }");
    if (![o, ...(o.also ?? [])].some((a) => isAllowed(url, a.domains, a.paths))) throw new Error(`not allowed: ${url}`);
    if (fetches >= o.maxFetches) throw new Error(`fetch limit reached (${o.maxFetches})`);
    fetches++;
    const text = htmlToText(await o.fetchText(url)).slice(0, o.maxChars);
    pages.set(new URL(url).href, text);
    return text;
  };
  return { tool, pages };
}
