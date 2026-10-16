// La décision de publier : du code pur, aucun modèle, aucune écriture. Les entrées ne sont pas modifiées.
import { capped, statementProblem } from "./gates.ts";
import { Brief, untranslated, type Claim, type Item, type Radar, type State, type Statement, type Text, type Trace, type VerifyOut, type WriteOut } from "./schema.ts";

const MAX_OPS = 3; // ajouts au radar et à l'état de l'art par run
const MIN_JUDGE_RATIO = 0.5;

/** Les deux versions d'un énoncé, telles que lues par le vérificateur. */
const both = (say: (lang: keyof Text) => string) => `FR : ${say("fr")}\nEN : ${say("en")}`;

export const toStatements = (draft: WriteOut): Statement[] => [
  ...draft.items.map((x, i) => ({
    id: `item:${i}`,
    text: both((l) => `${x.title[l]}. ${x.summary[l]} ${x.why[l]}`),
    claimIds: x.claimIds,
  })),
  ...draft.radar.map((x, i) => ({ id: `radar:${i}`, text: both((l) => `${x.name} (${x.ring}). ${x.rationale[l]}`), claimIds: x.claimIds })),
  ...draft.state.map((x, i) => ({ id: `state:${i}`, text: both((l) => x.text[l]), claimIds: x.claimIds })),
];

/** Ce qui désigne chaque énoncé dans les rejets, dans l'ordre de `toStatements`. */
const labels = (draft: WriteOut): Text[] => [
  ...draft.items.map((x) => x.title),
  ...draft.radar.map((x) => untranslated(x.name)),
  ...draft.state.map((x) => x.text),
];

// 6 (suite). Énoncés publiables — tout ce qui n'est pas explicitement validé est refusé
function judgeStatements(statements: Statement[], what: Text[], verdict: VerifyOut, literal: ReadonlySet<string>) {
  const okClaims = new Set(verdict.claims.filter((v) => v.supported).map((v) => v.id));
  const okStatements = new Set(verdict.statements.filter((v) => v.supported).map((v) => v.id));
  const reasons = new Map(verdict.statements.map((v) => [v.id, v.reason]));
  const publishable = new Set<string>();
  const rejected: Trace["rejected"] = [];
  statements.forEach((s, i) => {
    const problem = statementProblem(s, literal, okClaims, okStatements);
    const reason = reasons.get(s.id);
    if (problem) rejected.push({ what: capped(what[i]), reason: problem, ...(problem === "statement_unsupported" && reason && { detail: reason }) });
    else publishable.add(s.id);
  });
  return { publishable, rejected };
}

// 7. Portes — toutes obligatoires
const evaluateGates = (validated: number, total: number, draft: WriteOut, spentUsd: number, budgetUsd: number): Trace["gates"] => [
  { name: "verifier", pass: validated / total >= MIN_JUDGE_RATIO, detail: `${validated}/${total} (>= ${MIN_JUDGE_RATIO * 100}%)` },
  { name: "volume", pass: draft.radar.length <= MAX_OPS && draft.state.length <= MAX_OPS, detail: `radar ${draft.radar.length}, state ${draft.state.length} (max ${MAX_OPS})` },
  { name: "budget", pass: spentUsd <= budgetUsd, detail: `${spentUsd.toFixed(3)}/${budgetUsd} USD` },
];

/** Met à jour l'entrée du même nom (casse ignorée) ou en ajoute une. Modifie `radar` : lui passer une copie. */
function upsertRadar(radar: Radar, x: WriteOut["radar"][number], evidence: Claim[], date: string) {
  const existing = radar.entries.find((e) => e.name.toLowerCase() === x.name.toLowerCase());
  const update = { ring: x.ring, rationale: x.rationale, evidence };
  if (existing) Object.assign(existing, update).history.push({ date, ring: x.ring });
  else radar.entries.push({ name: x.name, ...update, since: date, history: [{ date, ring: x.ring }] });
}

export function decide(o: {
  date: string;
  draft: WriteOut;
  claims: Map<string, Claim>; // Map et non ReadonlyMap : le type est repris tel quel par les tests
  items: ReadonlyMap<string, Item>;
  verdict: VerifyOut;
  radar: Radar;
  state: State;
  /** Pour chaque sujet (id d'item), l'item de la source indépendante qui le recoupe. */
  via?: ReadonlyMap<string, Item>;
  spentUsd: number;
  budgetUsd: number;
}): {
  status: "published" | "rejected";
  published: number;
  gates: Trace["gates"];
  rejected: Trace["rejected"];
  brief?: Brief;
  radar: Radar;
  state: State;
} {
  const { date, draft, claims } = o;
  const statements = toStatements(draft);
  const { publishable, rejected } = judgeStatements(statements, labels(draft), o.verdict, new Set(claims.keys()));
  const gates = evaluateGates(publishable.size, statements.length, draft, o.spentUsd, o.budgetUsd);
  const radar = structuredClone(o.radar);
  const state = structuredClone(o.state);
  const result = { published: publishable.size, gates, rejected, radar, state };
  if (!gates.every((g) => g.pass)) return { status: "rejected", ...result };

  // 8. Publication — seulement ce qui a passé les portes
  const evidence = (ids: string[]) => ids.map((id) => claims.get(id)!);
  const items = draft.items.flatMap((x, i) => {
    const item = o.items.get(x.itemId);
    if (!publishable.has(`item:${i}`) || !item) return [];
    const second = o.via?.get(x.itemId);
    return [{ title: x.title, url: item.url, source: item.source, ...(second && { confirmedBy: { source: second.source, url: second.url } }), summary: x.summary, why: x.why, claims: evidence(x.claimIds) }];
  });
  draft.radar.forEach((x, i) => {
    if (publishable.has(`radar:${i}`)) upsertRadar(radar, x, evidence(x.claimIds), date);
  });
  draft.state.forEach((x, i) => {
    if (publishable.has(`state:${i}`)) state.points.push({ date, sectionId: x.sectionId, text: x.text, evidence: evidence(x.claimIds) });
  });
  items.sort((a, b) => Number(!!b.confirmedBy) - Number(!!a.confirmedBy)); // les sujets recoupés d'abord
  // Le titre de l'édition n'est pas jugé par le vérificateur : il est donc fait des titres publiés, qui le sont.
  const headline = { fr: items.map((x) => x.title.fr).join(" ; "), en: items.map((x) => x.title.en).join("; ") };
  const brief = items.length ? Brief.parse({ date, headline, items }) : undefined;
  return { status: "published", ...result, brief };
}

/**
 * Les sujets étudiés par un run : les mieux notés d'abord, sans qu'une source dépasse son plafond.
 * Sans ce plafond, la source qui publie le plus finit par écrire toute l'édition. Les sujets recoupés passent avant les autres.
 */
export function pickTopics(
  picks: { id: string; score: number; via?: unknown }[],
  items: ReadonlyMap<string, Item>,
  maxPerSource: (source: string) => number,
  maxTotal: number,
): Item[] {
  const taken = new Map<string, number>();
  const out: Item[] = [];
  for (const pick of [...picks].sort((a, b) => Number(!!b.via) - Number(!!a.via) || b.score - a.score)) {
    const item = items.get(pick.id);
    if (!item || out.length >= maxTotal) continue;
    const n = taken.get(item.source) ?? 0;
    if (n >= maxPerSource(item.source)) continue;
    taken.set(item.source, n + 1);
    out.push(item);
  }
  return out;
}

/**
 * Associe à chaque sujet l'item d'une autre source, indépendante (un autre groupe), qui couvre la même histoire :
 * `via`. Les sujets sans second item restent, sans `via`. Les mieux notés d'abord : un item qui en recoupe
 * un autre n'est pas un sujet à part, et un item ne recoupe qu'un seul sujet.
 */
export function withSecondSource(
  picks: { id: string; score: number; sameStory?: string[] }[],
  items: ReadonlyMap<string, Item>,
  groupOf: (source: string) => string,
): { id: string; score: number; via?: Item }[] {
  const sorted = [...picks].sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const out: { id: string; score: number; via?: Item }[] = [];
  for (const pick of sorted) {
    const item = items.get(pick.id);
    if (!item || used.has(item.id)) continue;
    const via = (pick.sameStory ?? []).map((id) => items.get(id)).find((v) => v && !used.has(v.id) && v.id !== item.id && groupOf(v.source) !== groupOf(item.source));
    if (!via) continue;
    used.add(item.id).add(via.id);
    out.push({ id: pick.id, score: pick.score, via });
  }
  for (const pick of sorted) if (items.has(pick.id) && !used.has(pick.id)) out.push({ id: pick.id, score: pick.score });
  return out;
}
