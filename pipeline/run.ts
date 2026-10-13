import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { judge, makeLlm, type Llm } from "./agents.ts";
import { fetchText, htmlToText, parseFeed } from "./collect.ts";
import { decide, toStatements } from "./decide.ts";
import { quoteProblem } from "./gates.ts";
import {
  Radar,
  ResearchOut,
  Source,
  State,
  TriageOut,
  WriteOut,
  SECTIONS,
  type Brief,
  type Claim,
  type Item,
  type Trace,
} from "./schema.ts";

const MAX_TRIAGE = 200; // items soumis au tri
const MAX_ITEMS = 6; // sujets étudiés par run
const MAX_PAGE_CHARS = 40_000;

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

// 2. Tri
async function triage(llm: Llm, fresh: Item[], byId: ReadonlyMap<string, Item>): Promise<Item[]> {
  const tri = await llm.call(
    "triage",
    JSON.stringify(fresh.map(({ id, title, source, summary }) => ({ id, title, source, summary }))),
    TriageOut,
  );
  return tri.picks
    .filter((p) => byId.has(p.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS)
    .map((p) => byId.get(p.id)!);
}

type Sheet = { item: Item; claims: Claim[] };

// 3. Recherche — un appel par sujet, en parallèle. Le code télécharge la page ; le modèle n'a
// aucun outil. Porte : chaque citation doit figurer mot pour mot dans cette même page.
async function research(o: Pick<Options, "llm" | "fetchText">, picked: Item[], reject: (what: string, reason: string) => void) {
  const claims = new Map<string, Claim>();
  let proposed = 0;
  const sheets = (
    await Promise.all(
      picked.map(async (item): Promise<Sheet | null> => {
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
  return { sheets, claims, proposed };
}

// 4. Rédaction — le rédacteur ne voit que les faits vérifiés, jamais le web
const write = (llm: Llm, date: string, sheets: Sheet[], radar: Radar) =>
  llm.call(
    "write",
    JSON.stringify({
      date,
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
  const reject = (what: string, reason: string) => {
    trace.rejected.push({ what: what.slice(0, 200), reason });
  };
  const gate = (name: string, pass: boolean, detail: string) => (trace.gates.push({ name, pass, detail }), pass);
  let seen = new Set<string>();
  let fresh: Item[] = [];

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
    const byId = new Map(fresh.map((i) => [i.id, i]));
    const picked = await triage(o.llm, fresh, byId);
    trace.counts.retenus = picked.length;
    if (!picked.length) {
      trace.status = "empty";
      return { trace };
    }

    // 3. Recherche — porte : au moins une citation retrouvée mot pour mot
    const { sheets, claims, proposed } = await research(o, picked, reject);
    trace.counts.faitsProposes = proposed;
    trace.counts.faitsCites = claims.size;
    if (!gate("citations littérales", claims.size > 0, `${claims.size}/${proposed} citations retrouvées mot pour mot`)) {
      trace.status = "rejected";
      return { trace };
    }

    // 4. Rédaction
    const radar = readJson<Radar>(join(o.root, "content/radar.json"), { entries: [] });
    const draft = await write(o.llm, o.date, sheets, radar);
    const statements = toStatements(draft);
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
    // 5 (suite) à 7. Énoncés publiables, portes, publication — décidés par du code pur (decide.ts)
    const state = readJson<State>(join(o.root, "content/state.json"), { points: [] });
    const d = decide({ date: o.date, draft, claims, items: byId, verdict, radar, state, spentUsd: o.llm.spent, budgetUsd: o.budgetUsd });
    trace.rejected.push(...d.rejected);
    trace.gates.push(...d.gates);
    if (d.status === "rejected") {
      trace.status = "rejected";
      return { trace };
    }
    const { brief } = d;
    trace.counts.publies = d.published;
    if (!o.dryRun) {
      if (brief) writeJson(join(o.root, `content/briefs/${o.date}.json`), brief);
      writeJson(join(o.root, "content/radar.json"), Radar.parse(d.radar));
      writeJson(join(o.root, "content/state.json"), State.parse(d.state));
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
