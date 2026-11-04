import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Conversation, ToolSpec } from "./loop.ts";
import { VerifyOut, type Statement, type Text } from "./schema.ts";

export type Stage = "triage" | "research" | "write" | "curate" | "verify";
export type Call = { stage: string; model: string; ms: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };

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
export const ROLES = {
  triage: { model: "claude-haiku-5-5", effort: "low", price: [0.1, 0.5] },
  research: { model: "claude-sonnet-5-5", effort: "medium", price: [2, 10] },
  write: { model: "claude-sonnet-5-5", effort: "high", price: [2, 10] },
  // Le seul rôle d'Opus : arbitrer ce qui entre au radar et à quel anneau. Un appel par run, petite entrée.
  curate: { model: "claude-opus-5-5", effort: "high", price: [4, 20] },
  verify: { model: "claude-sonnet-5-5", effort: "medium", price: [2, 10] },
} as const;

export const prompt = (stage: Stage) => readFileSync(join(import.meta.dirname, "prompts", `${stage}.md`), "utf8");

/** Refus, troncature ou JSON invalide : l'étape échoue, rien n'est publié. */
export const unusable = (stage: Stage, why: string | null) => new Error(`stage ${stage}: unusable response (${why})`);

/** Copie des messages avec un point de cache sur le dernier bloc : tout l'historique précédent est relu à 0,1×.
 *  Le dernier message est toujours un `user`. Un seul point, donc jamais de cumul au fil des tours. */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  const blocks: Anthropic.ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

export function makeLlm(budgetUsd: number): Llm {
  const client = new Anthropic();
  const calls: Call[] = [];
  let spent = 0;

  /** Un appel au modèle : plafond vérifié avant, coût compté après. */
  async function ask<S extends z.ZodType>(stage: Stage, schema: S, messages: Anthropic.MessageParam[], tools?: Anthropic.Tool[], cache = false) {
    // ponytail: le plafond est vérifié avant chaque appel, donc dépassable d'un appel au plus.
    if (spent >= budgetUsd) throw new Error(`run budget exceeded (${spent.toFixed(2)} USD)`);
    const role = ROLES[stage];
    const t0 = Date.now();
    const res = await client.messages.parse({
      model: role.model,
      max_tokens: 16000,
      system: prompt(stage),
      messages: cache ? withCacheBreakpoint(messages) : messages,
      tools,
      output_config: { effort: role.effort, format: zodOutputFormat(schema) },
    });
    // input_tokens exclut le cache : lecture à 0,1× le prix d'entrée, écriture à 1,25×.
    const { input_tokens, output_tokens } = res.usage;
    const read = res.usage.cache_read_input_tokens ?? 0;
    const write = res.usage.cache_creation_input_tokens ?? 0;
    const costUsd = ((input_tokens + read * 0.1 + write * 1.25) * role.price[0] + output_tokens * role.price[1]) / 1e6;
    spent += costUsd;
    calls.push({
      stage,
      model: role.model,
      ms: Date.now() - t0,
      inputTokens: input_tokens + read + write,
      outputTokens: output_tokens,
      cacheReadTokens: read,
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
          const res = await ask(stage, schema, messages, tools, true);
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
  claims: { id: string; text: Text; quote: string; url: string; source?: string; title?: string }[],
  statements: Statement[],
): Promise<VerifyOut> {
  return llm.call("verify", JSON.stringify({ claims, statements }), VerifyOut);
}
