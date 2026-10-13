// Éval en conditions réelles du vérificateur : des faits piégés qu'il doit refuser.
// Appelle l'API (quelques centimes). Les portes en code pur sont testées par `npm test`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge } from "../pipeline/agents.ts";
import { llmFromEnv } from "../pipeline/cli.ts";
import type { Text } from "../pipeline/schema.ts";

type Case = { id: string; expect: boolean; text: Text; quote: string };
const dir = import.meta.dirname;
const cases: Case[] = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));

const llm = llmFromEnv(0.5);
const verdict = await judge(llm, cases.map(({ id, text, quote }) => ({ id, text, quote })), []);
const got = new Map(verdict.claims.map((v) => [v.id, v.supported]));
// Un verdict manquant vaut un refus, comme dans le pipeline.
const failures = cases.filter((c) => (got.get(c.id) ?? false) !== c.expect);

const report = {
  date: new Date().toISOString().slice(0, 10),
  total: cases.length,
  passed: cases.length - failures.length,
  failures: failures.map((c) => c.id),
  costUsd: llm.spent,
};
writeFileSync(join(dir, "last.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
// Seul un piège accepté est bloquant ; un fait vrai refusé coûte une brève, pas la confiance.
if (failures.some((c) => !c.expect)) process.exit(1);
