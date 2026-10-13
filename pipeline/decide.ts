// La décision de publier : du code pur, aucun modèle, aucune écriture. Les entrées ne sont pas modifiées.
import { statementProblem } from "./gates.ts";
import { Brief, type Claim, type Item, type Radar, type State, type Statement, type Trace, type VerifyOut, type WriteOut } from "./schema.ts";

const MAX_OPS = 3; // ajouts au radar et à l'état de l'art par run
const MIN_JUDGE_RATIO = 0.7;

export const toStatements = (draft: WriteOut): Statement[] => [
  ...draft.items.map((x, i) => ({ id: `item:${i}`, text: `${x.title}. ${x.summary} ${x.why}`, claimIds: x.claimIds })),
  ...draft.radar.map((x, i) => ({ id: `radar:${i}`, text: `${x.name} (${x.ring}). ${x.rationale}`, claimIds: x.claimIds })),
  ...draft.state.map((x, i) => ({ id: `state:${i}`, text: x.text, claimIds: x.claimIds })),
];

// 5. Vérification — tout ce qui n'est pas explicitement validé est refusé
function judgeStatements(statements: Statement[], verdict: VerifyOut, literal: ReadonlySet<string>) {
  const okClaims = new Set(verdict.claims.filter((v) => v.supported).map((v) => v.id));
  const okStatements = new Set(verdict.statements.filter((v) => v.supported).map((v) => v.id));
  const publishable = new Set<string>();
  const rejected: Trace["rejected"] = [];
  for (const s of statements) {
    const problem = statementProblem(s, literal, okClaims, okStatements);
    if (problem) rejected.push({ what: s.text.slice(0, 200), reason: problem });
    else publishable.add(s.id);
  }
  return { publishable, rejected };
}

// 6. Portes — toutes obligatoires
const evaluateGates = (validated: number, total: number, draft: WriteOut, spentUsd: number, budgetUsd: number): Trace["gates"] => [
  { name: "vérificateur", pass: validated / total >= MIN_JUDGE_RATIO, detail: `${validated}/${total} énoncés validés (seuil ${MIN_JUDGE_RATIO * 100} %)` },
  { name: "volume", pass: draft.radar.length <= MAX_OPS && draft.state.length <= MAX_OPS, detail: `${draft.radar.length} radar, ${draft.state.length} état de l'art (max ${MAX_OPS})` },
  { name: "budget", pass: spentUsd <= budgetUsd, detail: `${spentUsd.toFixed(3)} $ sur ${budgetUsd} $` },
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
  const { publishable, rejected } = judgeStatements(statements, o.verdict, new Set(claims.keys()));
  const gates = evaluateGates(publishable.size, statements.length, draft, o.spentUsd, o.budgetUsd);
  const radar = structuredClone(o.radar);
  const state = structuredClone(o.state);
  const result = { published: publishable.size, gates, rejected, radar, state };
  if (!gates.every((g) => g.pass)) return { status: "rejected", ...result };

  // 7. Publication — seulement ce qui a passé les portes
  const evidence = (ids: string[]) => ids.map((id) => claims.get(id)!);
  const items = draft.items.flatMap((x, i) => {
    const item = o.items.get(x.itemId);
    if (!publishable.has(`item:${i}`) || !item) return [];
    return [{ title: x.title, url: item.url, source: item.source, summary: x.summary, why: x.why, claims: evidence(x.claimIds) }];
  });
  draft.radar.forEach((x, i) => {
    if (publishable.has(`radar:${i}`)) upsertRadar(radar, x, evidence(x.claimIds), date);
  });
  draft.state.forEach((x, i) => {
    if (publishable.has(`state:${i}`)) state.points.push({ date, sectionId: x.sectionId, text: x.text, evidence: evidence(x.claimIds) });
  });
  const brief = items.length ? Brief.parse({ date, headline: draft.headline, items }) : undefined;
  return { status: "published", ...result, brief };
}
