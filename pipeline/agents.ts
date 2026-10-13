import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Conversation } from "./loop.ts";
import { VerifyOut, type Statement, type Text } from "./schema.ts";

export type Stage = "triage" | "research" | "write" | "verify";
export type Call = { stage: string; model: string; ms: number; inputTokens: number; outputTokens: number; costUsd: number };

/** Un outil tel que décrit au modèle. Le code qui l'exécute est passé à la boucle, pas ici. */
export type ToolSpec = { name: string; description: string; inputSchema: Anthropic.Tool.InputSchema };

/** Le seul point de contact avec un modèle : texte en entrée, JSON validé en sortie. */
export interface Llm {
  /** Un appel, sans outil. */
  call<S extends z.ZodType>(stage: Stage, user: string, schema: S): Promise<z.infer<S>>;
  /** Une conversation avec outils : chaque envoi est un appel au modèle, la boucle est dans loop.ts. */
  open<S extends z.ZodType>(stage: Stage, user: string, schema: S, tools: ToolSpec[]): Conversation<z.infer<S>>;
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
  // Refus, troncature ou JSON invalide : l'étape échoue, rien n'est publié.
  const unusable = (stage: Stage, stopReason: string | null) => new Error(`stage ${stage}: unusable response (${stopReason})`);

  /** Un appel au modèle : plafond vérifié avant, coût compté après. */
  async function ask<S extends z.ZodType>(stage: Stage, schema: S, messages: Anthropic.MessageParam[], tools?: Anthropic.Tool[]) {
    // ponytail: le plafond est vérifié avant chaque appel, donc dépassable d'un appel au plus.
    if (spent >= budgetUsd) throw new Error(`run budget exceeded (${spent.toFixed(2)} USD)`);
    const role = ROLES[stage];
    const t0 = Date.now();
    const res = await client.messages.parse({
      model: role.model,
      max_tokens: 16000,
      system: prompt(stage),
      messages,
      tools,
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
    return res;
  }

  return {
    calls,
    get spent() {
      return spent;
    },
    async call(stage, user, schema) {
      const res = await ask(stage, schema, [{ role: "user", content: user }]);
      if (res.stop_reason !== "end_turn" || !res.parsed_output) throw unusable(stage, res.stop_reason);
      return res.parsed_output;
    },
    open(stage, user, schema, specs) {
      // L'historique ne fait que grandir : résultats d'outils, puis réponse du modèle rejouée telle quelle
      // (tout son contenu, blocs de réflexion compris).
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
      const tools = specs.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, strict: true }));
      return {
        async send(results) {
          if (results.length) {
            messages.push({
              role: "user",
              content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
            });
          }
          const res = await ask(stage, schema, messages, tools);
          messages.push({ role: "assistant", content: res.content });
          if (res.stop_reason !== "end_turn" && res.stop_reason !== "tool_use") throw unusable(stage, res.stop_reason);
          return {
            calls: res.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
            output: res.stop_reason === "end_turn" ? res.parsed_output : null,
          };
        },
      };
    },
  };
}

/** Vérificateur : contexte neuf, il ne voit ni les pages ni le raisonnement du rédacteur. */
export function judge(
  llm: Llm,
  claims: { id: string; text: Text; quote: string }[],
  statements: Statement[],
): Promise<VerifyOut> {
  return llm.call("verify", JSON.stringify({ claims, statements }), VerifyOut);
}
