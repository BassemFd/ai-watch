import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { Item, Source } from "./schema.ts";

const MAX_AGE_DAYS = 7; // la déduplication (data/seen.json) évite les redites
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

/** Vrai si l'adresse est en https et que son hôte est un domaine de la liste, ou l'un de ses sous-domaines. */
export function isAllowed(url: string, domains: readonly string[], paths: readonly string[] = []): boolean {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:") return false;
  if (!domains.some((d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`))) return false;
  // Sur un hôte partagé, le domaine ne dit rien de l'auteur : les préfixes de chemin le font.
  return paths.length === 0 || paths.some((p) => parsed.pathname.startsWith(p));
}

/**
 * `allowed` dit si l'adresse finale reste dans ce que la source a le droit de lire : une redirection vers un autre
 * domaine de la même source (deepmind.google → blog.google) passe, toute autre est refusée.
 */
export async function fetchText(url: string, allowed: (finalUrl: string) => boolean = () => false): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "veille-ia-bot/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Une redirection vers un autre hôte contournerait la liste blanche, vérifiée sur l'adresse demandée.
  if (new URL(res.url).hostname !== new URL(url).hostname && !allowed(res.url)) throw new Error(`redirected off-host to ${new URL(res.url).hostname}`);
  return res.text();
}

// ponytail: nettoyage par regex, pas un parseur DOM. Une page rendue en JavaScript donne peu de
// texte et ses citations sont rejetées. Passer à un vrai extracteur si le taux de rejet est élevé.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: unknown): string =>
  v && typeof v === "object" ? String((v as Record<string, unknown>)["#text"] ?? "") : String(v ?? "");

/** Flux RSS ou Atom → items récents dont le lien pointe vers un domaine de la liste blanche. */
export function parseFeed(xml: string, source: Source, today: string): Item[] {
  const doc = parser.parse(xml);
  const entries: Record<string, unknown>[] = doc.rss ? arr(doc.rss.channel?.item) : arr(doc.feed?.entry);
  const minTime = Date.parse(today) - MAX_AGE_DAYS * 864e5;
  const items: Item[] = [];
  for (const e of entries) {
    const links = arr(e.link) as unknown[];
    const atom = links.find(
      (l) => l && typeof l === "object" && ((l as Record<string, string>)["@_rel"] ?? "alternate") === "alternate",
    ) as Record<string, string> | undefined;
    const url = atom?.["@_href"] ?? txt(links[0]);
    if (!isAllowed(url, source.domains, source.paths)) continue;
    const parsed = new URL(url);
    const time = Date.parse(txt(e.pubDate ?? e.published ?? e.updated ?? e["dc:date"]));
    if (!(time >= minTime)) continue;
    items.push({
      id: createHash("sha1").update(parsed.href).digest("hex").slice(0, 12),
      url: parsed.href,
      title: htmlToText(txt(e.title)),
      source: source.name,
      summary: htmlToText(txt(e.description ?? e.summary ?? e.content)).slice(0, 400),
      ...(source.primary && { primary: true }),
    });
    if (items.length >= (source.max ?? 40)) break;
  }
  return items;
}
