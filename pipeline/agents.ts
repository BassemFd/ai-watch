import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { VerifyOut, type Statement } from "./schema.ts";

export type Stage = "triage" | "research" | "write" | "verify";
export type Call = { stage: string; model: string; ms: number; inputTokens: number; outputTokens: number; costUsd: number };

/** Le seul point de contact avec un modèle. Aucun outil : texte en entrée, JSON validé en sortie. */
export interface Llm {
  call<S extends z.ZodType>(stage: Stage, user: string, schema: S): Promise<z.infer<S>>;
  readonly calls: Call[];
  readonly spent: number;
}

// Un modèle par rôle : le moins cher qui tient le rôle. Prix en $ par million de tokens (entrée, sortie).
const ROLES = {
  triage: { model: "claude-haiku-5-5", effort: "low", price: [0.1, 0.5] },
  research: { model: "claude-sonnet-5-5", effort: "medium", price: [2, 10] },
  write: { model: "claude-opus-5-5", effort: "high", price: [4, 20] },
  verify: { model: "claude-sonnet-5-5", effort: "medium", price: [2, 10] },
} as const;

const prompt = (stage: Stage) => readFileSync(join(import.meta.dirname, "prompts", `${stage}.md`), "utf8");

export function makeLlm(budgetUsd: number): Llm {
  const client = new Anthropic();
  const calls: Call[] = [];
  let spent = 0;
  return {
    calls,
    get spent() {
      return spent;
    },
    async call(stage, user, schema) {
      // ponytail: le plafond est vérifié avant chaque appel, donc dépassable d'un appel au plus.
      if (spent >= budgetUsd) throw new Error(`budget du run dépassé (${spent.toFixed(2)} $)`);
      const role = ROLES[stage];
      const t0 = Date.now();
      const res = await client.messages.parse({
        model: role.model,
        max_tokens: 16000,
        system: prompt(stage),
        messages: [{ role: "user", content: user }],
        output_config: { effort: role.effort, format: zodOutputFormat(schema) },
      });
      const costUsd = (res.usage.input_tokens * role.price[0] + res.usage.output_tokens * role.price[1]) / 1e6;
      spent += costUsd;
      calls.push({
        stage,
        model: role.model,
        ms: Date.now() - t0,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        costUsd,
      });
      // Refus, troncature ou JSON invalide : l'étape échoue, rien n'est publié.
      if (res.stop_reason !== "end_turn" || !res.parsed_output) {
        throw new Error(`étape ${stage} : réponse inexploitable (${res.stop_reason})`);
      }
      return res.parsed_output;
    },
  };
}

/** Vérificateur : contexte neuf, il ne voit ni les pages ni le raisonnement du rédacteur. */
export function judge(
  llm: Llm,
  claims: { id: string; text: string; quote: string }[],
  statements: Statement[],
): Promise<VerifyOut> {
  return llm.call("verify", JSON.stringify({ claims, statements }), VerifyOut);
}
