import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { judge, makeLlm, type Llm, type Statement } from "./agents.ts";
import { fetchText, htmlToText, parseFeed } from "./collect.ts";
import { quoteProblem, statementProblem } from "./gates.ts";
import {
  Brief,
  Radar,
  ResearchOut,
  Source,
  State,
  TriageOut,
  WriteOut,
  SECTIONS,
  type Claim,
  type Item,
  type Trace,
} from "./schema.ts";

const MAX_TRIAGE = 200; // items soumis au tri
const MAX_ITEMS = 6; // sujets étudiés par run
const MAX_PAGE_CHARS = 40_000;
const MAX_OPS = 3; // ajouts au radar et à l'état de l'art par run
const MIN_JUDGE_RATIO = 0.7;

const readJson = <T>(path: string, fallback: T): T =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Options = {
  root: string;
  date: string;
  llm: Llm;
  fetchText: (url: string) => Promise<string>;
  sources: Source[];
  budgetUsd: number;
  dryRun?: boolean;
};

export async function collect(o: Pick<Options, "root" | "date" | "fetchText" | "sources">) {
  const seen = new Set(readJson<string[]>(join(o.root, "data/seen.json"), []));
  const all = new Map<string, Item>();
  const failures: { what: string; reason: string }[] = [];
  for (const source of o.sources) {
    try {
      for (const item of parseFeed(await o.fetchText(source.feed), source, o.date)) all.set(item.id, item);
    } catch (e) {
      failures.push({ what: source.name, reason: `flux illisible : ${msg(e)}` });
    }
  }
  const fresh = [...all.values()].filter((i) => !seen.has(i.id)).slice(0, MAX_TRIAGE);
  return { seen, total: all.size, fresh, failures };
}

export async function run(o: Options): Promise<{ trace: Trace; brief?: Brief }> {
  const t0 = Date.now();
  const trace: Trace = {
    date: o.date,
    startedAt: new Date(t0).toISOString(),
    durationMs: 0,
    status: "error",
    counts: {},
    stages: [],
    gates: [],
    rejected: [],
    costUsd: 0,
  };
  const reject = (what: string, reason: string) => trace.rejected.push({ what: what.slice(0, 200), reason });
  const gate = (name: string, pass: boolean, detail: string) => (trace.gates.push({ name, pass, detail }), pass);
  let seen = new Set<string>();
  let fresh: Item[] = [];
  let brief: Brief | undefined;

  try {
    // 1. Collecte — code, sans modèle
    const collected = await collect(o);
    ({ seen, fresh } = collected);
    trace.rejected.push(...collected.failures);
    trace.counts = { collectes: collected.total, nouveaux: fresh.length };
    if (!fresh.length) {
      trace.status = "empty";
      return { trace };
    }

    // 2. Tri
    const tri = await o.llm.call(
      "triage",
      JSON.stringify(fresh.map(({ id, title, source, summary }) => ({ id, title, source, summary }))),
      TriageOut,
    );
    const byId = new Map(fresh.map((i) => [i.id, i]));
    const picked = tri.picks
      .filter((p) => byId.has(p.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ITEMS)
      .map((p) => byId.get(p.id)!);
    trace.counts.retenus = picked.length;
    if (!picked.length) {
      trace.status = "empty";
      return { trace };
    }

    // 3. Recherche — un appel par sujet, en parallèle. Le code télécharge la page ; le modèle n'a
    // aucun outil. Porte : chaque citation doit figurer mot pour mot dans cette même page.
    const claims = new Map<string, Claim>();
    let proposed = 0;
    const sheets = (
      await Promise.all(
        picked.map(async (item) => {
          try {
            const page = htmlToText(await o.fetchText(item.url)).slice(0, MAX_PAGE_CHARS);
            const out = await o.llm.call(
              "research",
              `Titre : ${item.title}\nURL : ${item.url}\n<source>\n${page}\n</source>`,
              ResearchOut,
            );
            const kept: Claim[] = [];
            out.claims.forEach((c, i) => {
              proposed++;
              const problem = quoteProblem(c.quote, page);
              if (problem) return reject(c.text, problem);
              const claim = { id: `${item.id}-${i}`, text: c.text, quote: c.quote, url: item.url };
              claims.set(claim.id, claim);
              kept.push(claim);
            });
            return kept.length ? { item, claims: kept } : null;
          } catch (e) {
            reject(item.title, `sujet abandonné : ${msg(e)}`);
            return null;
          }
        }),
      )
    ).filter((s) => s !== null);
    trace.counts.faitsProposes = proposed;
    trace.counts.faitsCites = claims.size;
    if (!gate("citations littérales", claims.size > 0, `${claims.size}/${proposed} citations retrouvées mot pour mot`)) {
      trace.status = "rejected";
      return { trace };
    }

    // 4. Rédaction — le rédacteur ne voit que les faits vérifiés, jamais le web
    const radar = readJson<Radar>(join(o.root, "content/radar.json"), { entries: [] });
    const draft = await o.llm.call(
      "write",
      JSON.stringify({
        date: o.date,
        fiches: sheets.map((s) => ({
          itemId: s.item.id,
          titre: s.item.title,
          source: s.item.source,
          faits: s.claims.map(({ id, text }) => ({ id, text })),
        })),
        radar: radar.entries.map(({ name, ring }) => ({ name, ring })),
        sections: SECTIONS,
      }),
      WriteOut,
    );
    const statements: Statement[] = [
      ...draft.items.map((x, i) => ({ id: `item:${i}`, text: `${x.title}. ${x.summary} ${x.why}`, claimIds: x.claimIds })),
      ...draft.radar.map((x, i) => ({ id: `radar:${i}`, text: `${x.name} (${x.ring}). ${x.rationale}`, claimIds: x.claimIds })),
      ...draft.state.map((x, i) => ({ id: `state:${i}`, text: x.text, claimIds: x.claimIds })),
    ];
    if (!statements.length) {
      trace.status = "empty";
      return { trace };
    }

    // 5. Vérification — modèle indépendant, contexte neuf
    const cited = [...new Set(statements.flatMap((s) => s.claimIds))].flatMap((id) => claims.get(id) ?? []);
    const verdict = await judge(
      o.llm,
      cited.map(({ id, text, quote }) => ({ id, text, quote })),
      statements,
    );
    const okClaims = new Set(verdict.claims.filter((v) => v.supported).map((v) => v.id));
    const okStatements = new Set(verdict.statements.filter((v) => v.supported).map((v) => v.id));
    const literal = new Set(claims.keys());
    const publishable = new Set<string>();
    for (const s of statements) {
      const problem = statementProblem(s, literal, okClaims, okStatements);
      if (problem) reject(s.text, problem);
      else publishable.add(s.id);
    }

    // 6. Portes — toutes obligatoires
    const ratio = publishable.size / statements.length;
    const passed = [
      gate("vérificateur", ratio >= MIN_JUDGE_RATIO, `${publishable.size}/${statements.length} énoncés validés (seuil ${MIN_JUDGE_RATIO * 100} %)`),
      gate("volume", draft.radar.length <= MAX_OPS && draft.state.length <= MAX_OPS, `${draft.radar.length} radar, ${draft.state.length} état de l'art (max ${MAX_OPS})`),
      gate("budget", o.llm.spent <= o.budgetUsd, `${o.llm.spent.toFixed(3)} $ sur ${o.budgetUsd} $`),
    ].every(Boolean);
    if (!passed) {
      trace.status = "rejected";
      return { trace };
    }

    // 7. Publication — seul le code écrit, et seulement ce qui a passé les portes
    const evidence = (ids: string[]) => ids.map((id) => claims.get(id)!);
    const items = draft.items.flatMap((x, i) => {
      const item = byId.get(x.itemId);
      if (!publishable.has(`item:${i}`) || !item) return [];
      return [{ title: x.title, url: item.url, source: item.source, summary: x.summary, why: x.why, claims: evidence(x.claimIds) }];
    });
    draft.radar.forEach((x, i) => {
      if (!publishable.has(`radar:${i}`)) return;
      const existing = radar.entries.find((e) => e.name.toLowerCase() === x.name.toLowerCase());
      const update = { ring: x.ring, rationale: x.rationale, evidence: evidence(x.claimIds) };
      if (existing) Object.assign(existing, update).history.push({ date: o.date, ring: x.ring });
      else radar.entries.push({ name: x.name, ...update, since: o.date, history: [{ date: o.date, ring: x.ring }] });
    });
    const state = readJson<State>(join(o.root, "content/state.json"), { points: [] });
    draft.state.forEach((x, i) => {
      if (publishable.has(`state:${i}`)) state.points.push({ date: o.date, sectionId: x.sectionId, text: x.text, evidence: evidence(x.claimIds) });
    });
    if (items.length) brief = Brief.parse({ date: o.date, headline: draft.headline, items });
    trace.counts.publies = publishable.size;
    if (!o.dryRun) {
      if (brief) writeJson(join(o.root, `content/briefs/${o.date}.json`), brief);
      writeJson(join(o.root, "content/radar.json"), Radar.parse(radar));
      writeJson(join(o.root, "content/state.json"), State.parse(state));
    }
    trace.status = "published";
    return { trace, brief };
  } catch (e) {
    trace.status = "error";
    trace.error = msg(e);
    return { trace };
  } finally {
    trace.stages = o.llm.calls;
    trace.costUsd = o.llm.spent;
    trace.durationMs = Date.now() - t0;
    if (!o.dryRun) {
      // Après une erreur, les items restent « non vus » pour être retentés au prochain run.
      if (trace.status !== "error") {
        writeJson(join(o.root, "data/seen.json"), [...seen, ...fresh.map((i) => i.id)].slice(-5000));
      }
      // Un rerun le même jour qui ne trouve rien de neuf ne doit pas écraser la trace du run publié.
      const tracePath = join(o.root, `runs/${o.date}.json`);
      if (trace.status !== "empty" || !existsSync(tracePath)) writeJson(tracePath, trace);
    }
  }
}

if (import.meta.main) {
  const root = process.cwd();
  const date = new Date().toISOString().slice(0, 10);
  const sources = Source.array().parse(readJson(join(root, "sources.json"), []));
  if (process.argv.includes("--collect-only")) {
    const c = await collect({ root, date, fetchText, sources });
    console.log(JSON.stringify({ total: c.total, nouveaux: c.fresh.length, echecs: c.failures, apercu: c.fresh.slice(0, 15).map((i) => `${i.source} — ${i.title}`) }, null, 2));
  } else {
    const dryRun = process.argv.includes("--dry-run");
    const budgetUsd = Number(process.env.RUN_BUDGET_USD ?? 2);
    const { trace, brief } = await run({ root, date, llm: makeLlm(budgetUsd), fetchText, sources, budgetUsd, dryRun });
    console.log(JSON.stringify(dryRun ? { trace, brief } : { status: trace.status, error: trace.error, counts: trace.counts, gates: trace.gates, costUsd: trace.costUsd }, null, 2));
    if (trace.status === "error") process.exit(1);
  }
}
