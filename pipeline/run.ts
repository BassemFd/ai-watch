import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { judge, type Llm } from "./agents.ts";
import { llmFromEnv } from "./cli.ts";
import { fetchText, parseFeed } from "./collect.ts";
import { decide, pickTopics, toStatements } from "./decide.ts";
import { capped, quoteProblem } from "./gates.ts";
import { runAgent } from "./loop.ts";
import {
  Radar,
  ResearchOut,
  Source,
  State,
  TriageOut,
  WriteOut,
  SECTIONS,
  untranslated,
  type Brief,
  type Claim,
  type Item,
  type Statement,
  type Trace,
  type VerifyOut,
} from "./schema.ts";
import { FETCH_PAGE, makeFetchTool } from "./tools.ts";

const MAX_TRIAGE = 200; // items soumis au tri
const MAX_ITEMS = 6; // sujets étudiés par run
const MAX_PER_SOURCE = 2; // sujets au plus par source, sauf réglage dans sources.json
const MAX_PAGE_CHARS = 40_000;
const MAX_FETCHES = 3; // pages lues par sujet : la sienne et deux liens
const MAX_TURNS = 6; // envois au modèle par sujet

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
  /** Diagnostic : ignore les items déjà vus et n'écrit rien. */
  replay?: boolean;
};

export async function collect(o: Pick<Options, "root" | "date" | "fetchText" | "sources" | "replay">) {
  const seen = new Set(o.replay ? [] : readJson<string[]>(join(o.root, "data/seen.json"), []));
  const all = new Map<string, Item>();
  const failures: Trace["rejected"] = [];
  for (const source of o.sources) {
    try {
      for (const item of parseFeed(await o.fetchText(source.feed), source, o.date)) all.set(item.id, item);
    } catch (e) {
      failures.push({ what: untranslated(source.name), reason: "feed_unreadable", detail: msg(e) });
    }
  }
  const fresh = [...all.values()].filter((i) => !seen.has(i.id)).slice(0, MAX_TRIAGE);
  return { seen, total: all.size, fresh, failures };
}

// 2. Tri
async function triage(llm: Llm, fresh: Item[], byId: ReadonlyMap<string, Item>, sources: Source[]): Promise<Item[]> {
  const tri = await llm.call(
    "triage",
    JSON.stringify(fresh.map(({ id, title, source, summary }) => ({ id, title, source, summary }))),
    TriageOut,
  );
  const caps = new Map(sources.map((s) => [s.name, s.maxPicks ?? MAX_PER_SOURCE]));
  return pickTopics(tri.picks, byId, (source) => caps.get(source) ?? MAX_PER_SOURCE, MAX_ITEMS);
}

type Sheet = { item: Item; claims: Claim[] };

// 3. Recherche — une boucle d'agent par sujet, en parallèle. Le modèle choisit ce qu'il lit avec son
// seul outil, fetch_page ; le code fixe ce qu'il a le droit de lire. Porte : chaque citation doit
// figurer mot pour mot dans la page qu'elle cite, et cette page avoir été lue par l'outil.
async function research(
  o: Pick<Options, "llm" | "fetchText" | "sources">,
  picked: Item[],
  reject: (r: Trace["rejected"][number]) => void,
  toolCalls: Trace["toolCalls"],
) {
  // Un sujet ne lit que sa propre source : une page ne peut pas envoyer l'agent chez un tiers.
  const bySource = new Map(o.sources.map((s) => [s.name, s]));
  const claims = new Map<string, Claim>();
  let proposed = 0;
  const sheets = (
    await Promise.all(
      picked.map(async (item): Promise<Sheet | null> => {
        try {
          const source = bySource.get(item.source);
          const { tool, pages } = makeFetchTool({ domains: source?.domains ?? [], paths: source?.paths, maxFetches: MAX_FETCHES, maxChars: MAX_PAGE_CHARS, fetchText: o.fetchText });
          const out = await runAgent({
            conversation: o.llm.open("research", `Titre : ${item.title}\nURL : ${item.url}`, ResearchOut, [FETCH_PAGE]),
            tools: { [FETCH_PAGE.name]: tool },
            maxTurns: MAX_TURNS,
            onToolCall: (e) => {
              const asked = (e.input as { url?: unknown } | null)?.url;
              toolCalls.push({ ...e, item: item.url, input: typeof asked === "string" ? asked : String(JSON.stringify(e.input)) });
            },
          });
          const kept: Claim[] = [];
          out.claims.forEach((c, i) => {
            proposed++;
            const url = URL.parse(c.url)?.href ?? "";
            const page = pages.get(url);
            const problem = page === undefined ? "source_not_fetched" : quoteProblem(c.quote, page);
            if (problem) return reject({ what: c.text, reason: problem });
            const claim = { id: `${item.id}-${i}`, text: c.text, quote: c.quote, url };
            claims.set(claim.id, claim);
            kept.push(claim);
          });
          return kept.length ? { item, claims: kept } : null;
        } catch (e) {
          reject({ what: untranslated(item.title), reason: "item_failed", detail: msg(e) });
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

// 4. Vérification des faits — le vérificateur ne voit que les faits, pas d'énoncés. Rend les faits validés.
async function verifyClaims(llm: Llm, claims: ReadonlyMap<string, Claim>, reject: (r: Trace["rejected"][number]) => void) {
  const verdicts = new Map((await judge(llm, [...claims.values()], [])).claims.map((v) => [v.id, v]));
  const valid = new Map<string, Claim>();
  for (const c of claims.values()) {
    const v = verdicts.get(c.id);
    if (v?.supported) valid.set(c.id, c);
    else reject({ what: c.text, reason: "claim_unsupported", ...(v?.reason && { detail: v.reason }) });
  }
  return valid;
}

// 6. Vérification des énoncés — ne juge que les faits cités ; les faits validés le restent dans le verdict.
async function verifyStatements(llm: Llm, valid: ReadonlyMap<string, Claim>, statements: Statement[]): Promise<VerifyOut> {
  const cited = [...new Set(statements.flatMap((s) => s.claimIds))].flatMap((id) => valid.get(id) ?? []);
  const second = await judge(llm, cited, statements);
  return { ...second, claims: [...valid.keys()].map((id) => ({ id, supported: true, reason: "" })) };
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
    toolCalls: [],
    costUsd: 0,
  };
  const reject = (r: Trace["rejected"][number]) => {
    trace.rejected.push({ ...r, what: capped(r.what) });
  };
  let seen = new Set<string>();
  let fresh: Item[] = [];

  try {
    // 1. Collecte — code, sans modèle
    const collected = await collect(o);
    ({ seen, fresh } = collected);
    collected.failures.forEach(reject);
    trace.counts = { collectes: collected.total, nouveaux: fresh.length };
    if (!fresh.length) {
      trace.status = "empty";
      return { trace };
    }

    // 2. Tri
    const byId = new Map(fresh.map((i) => [i.id, i]));
    const picked = await triage(o.llm, fresh, byId, o.sources);
    trace.counts.retenus = picked.length;
    if (!picked.length) {
      trace.status = "empty";
      return { trace };
    }

    // 3. Recherche — porte : au moins une citation retrouvée mot pour mot
    const { sheets, claims, proposed } = await research(o, picked, reject, trace.toolCalls);
    trace.counts.faitsProposes = proposed;
    trace.counts.faitsCites = claims.size;
    trace.gates.push({ name: "literal_quotes", pass: claims.size > 0, detail: `${claims.size}/${proposed}` });
    if (!claims.size) {
      trace.status = "rejected";
      return { trace };
    }

    // 4. Vérification des faits — avant que le rédacteur les voie ; un fait sans verdict favorable est refusé
    const valid = await verifyClaims(o.llm, claims, reject);
    trace.counts.faitsValides = valid.size;
    trace.gates.push({ name: "supported_claims", pass: valid.size > 0, detail: `${valid.size}/${claims.size}` });
    if (!valid.size) {
      trace.status = "rejected";
      return { trace };
    }

    // 5. Rédaction
    const radar = readJson<Radar>(join(o.root, "content/radar.json"), { entries: [] });
    const kept = sheets.map((s) => ({ ...s, claims: s.claims.filter((c) => valid.has(c.id)) })).filter((s) => s.claims.length);
    const draft = await write(o.llm, o.date, kept, radar);
    const statements = toStatements(draft);
    if (!statements.length) {
      trace.status = "empty";
      return { trace };
    }

    // 6. Vérification des énoncés — modèle indépendant, contexte neuf ; les faits validés le restent
    const verdict = await verifyStatements(o.llm, valid, statements);
    // 6 (suite) à 8. Énoncés publiables, portes, publication — décidés par du code pur (decide.ts)
    const state = readJson<State>(join(o.root, "content/state.json"), { points: [] });
    const d = decide({ date: o.date, draft, claims: valid, items: byId, verdict, radar, state, spentUsd: o.llm.spent, budgetUsd: o.budgetUsd });
    trace.rejected.push(...d.rejected);
    trace.gates.push(...d.gates);
    if (d.status === "rejected") {
      trace.status = "rejected";
      return { trace };
    }
    const { brief } = d;
    trace.counts.publies = d.published;
    if (!o.dryRun && !o.replay) {
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
    if (!o.dryRun && !o.replay) {
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
    const replay = process.argv.includes("--replay");
    const dryRun = replay || process.argv.includes("--dry-run");
    const budgetUsd = Number(process.env.RUN_BUDGET_USD ?? 2);
    const { trace, brief } = await run({ root, date, llm: llmFromEnv(budgetUsd), fetchText, sources, budgetUsd, dryRun, replay });
    console.log(JSON.stringify(dryRun ? { trace, brief } : { status: trace.status, error: trace.error, counts: trace.counts, gates: trace.gates, costUsd: trace.costUsd }, null, 2));
    if (trace.status === "error") process.exit(1);
  }
}
