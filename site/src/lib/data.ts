import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { Brief, EvalReport, Radar, State, Trace } from "../../../pipeline/schema.ts";

// Le site ne lit que des fichiers du dépôt, revalidés ici : une donnée invalide casse le build,
// donc rien n'est déployé.
const root = process.env.DATA_DIR ?? process.cwd();
const load = <S extends z.ZodType>(path: string, schema: S): z.infer<S> | null =>
  existsSync(join(root, path)) ? schema.parse(JSON.parse(readFileSync(join(root, path), "utf8"))) : null;
const loadAll = <S extends z.ZodType>(dir: string, schema: S): z.infer<S>[] =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => load(`${dir}/${f}`, schema)!)
    : [];

export const briefs = loadAll("content/briefs", Brief);
export const runs = loadAll("runs", Trace);
export const radar = load("content/radar.json", Radar) ?? { entries: [] };
export const state = load("content/state.json", State) ?? { points: [] };
export const evals = load("evals/last.json", EvalReport);

export const usd = (n: number) => `${n.toFixed(n < 0.1 ? 3 : 2)} $`;
