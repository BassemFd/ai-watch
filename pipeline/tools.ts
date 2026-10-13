// Le seul outil donné à un modèle : lire une page, en https, sur un domaine de la liste blanche.
import type { ToolSpec } from "./agents.ts";
import { htmlToText } from "./collect.ts";
import type { Tool } from "./loop.ts";

/** Vrai si l'adresse est en https et que son hôte est un domaine de la liste, ou l'un de ses sous-domaines. */
export function isAllowed(url: string, domains: readonly string[]): boolean {
  const parsed = URL.parse(url);
  return parsed?.protocol === "https:" && domains.some((d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`));
}

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
  maxFetches: number;
  maxChars: number;
  fetchText: (url: string) => Promise<string>;
}): { tool: Tool; pages: Map<string, string> } {
  const pages = new Map<string, string>();
  let fetches = 0;
  const tool: Tool = async (input) => {
    const url = (input as { url?: unknown } | null)?.url;
    if (typeof url !== "string") throw new Error("invalid input: expected { url: string }");
    if (!isAllowed(url, o.domains)) throw new Error(`not allowed: ${url}`);
    if (fetches >= o.maxFetches) throw new Error(`fetch limit reached (${o.maxFetches})`);
    fetches++;
    const text = htmlToText(await o.fetchText(url)).slice(0, o.maxChars);
    pages.set(new URL(url).href, text);
    return text;
  };
  return { tool, pages };
}
