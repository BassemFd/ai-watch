// La boucle d'agent : du code pur. Ni SDK, ni fichier, ni réseau : une conversation et des outils qu'on lui passe.

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; content: string; isError: boolean };
/** Ce que répond le modèle à un envoi : des appels d'outils, ou sa sortie finale. */
export type Turn<T> = { calls: ToolCall[]; output: T | null };
export interface Conversation<T> {
  /** Envoie les résultats des outils du tour précédent (aucun au premier envoi). */
  send(results: ToolResult[]): Promise<Turn<T>>;
}
/** Un outil rend du texte, ou échoue : son message d'erreur est alors rendu au modèle. */
export type Tool = (input: unknown) => Promise<string>;
export type ToolEvent = { tool: string; input: unknown; ok: boolean; detail?: string; ms: number };

/** Fait tourner la conversation jusqu'à une sortie sans appel d'outil, en `maxTurns` envois au plus. */
export async function runAgent<T>(o: {
  conversation: Conversation<T>;
  tools: Record<string, Tool>;
  maxTurns: number;
  onToolCall?: (e: ToolEvent) => void;
}): Promise<T> {
  let results: ToolResult[] = [];
  for (let turn = 0; turn < o.maxTurns; turn++) {
    const { calls, output } = await o.conversation.send(results);
    if (!calls.length) {
      if (output === null) throw new Error("no output");
      return output;
    }
    results = [];
    // Un appel après l'autre : l'ordre des résultats et de la trace est celui des appels.
    for (const call of calls) {
      const t0 = Date.now();
      try {
        // Le nom vient du modèle : seul un outil réellement fourni est exécuté.
        if (!Object.hasOwn(o.tools, call.name)) throw new Error(`unknown tool: ${call.name}`);
        results.push({ id: call.id, content: await o.tools[call.name](call.input), isError: false });
        o.onToolCall?.({ tool: call.name, input: call.input, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        results.push({ id: call.id, content: detail, isError: true });
        o.onToolCall?.({ tool: call.name, input: call.input, ok: false, detail, ms: Date.now() - t0 });
      }
    }
  }
  throw new Error(`max turns (${o.maxTurns})`);
}
