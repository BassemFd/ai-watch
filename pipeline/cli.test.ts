import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { makeCliLlm } from "./cli.ts";

// Second adaptateur du port Llm : le CLI `claude` en mode non interactif, sans clé API.
// `exec` est injecté : aucun processus n'est lancé par ces tests.

const Out = z.object({ answer: z.string() });
const TOOL = {
  name: "fetch_page",
  description: "Lit une page.",
  inputSchema: { type: "object" as const, properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
};
const reply = (structured: unknown, extra: object = {}) =>
  JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 7 }, structured_output: structured, ...extra });

function recorder(replies: string[]) {
  const seen: { args: string[]; stdin: string }[] = [];
  const exec = async (args: string[], stdin: string) => {
    seen.push({ args, stdin });
    return replies.shift() ?? reply({ answer: "?" });
  };
  return { seen, exec };
}
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("cli : un appel rend la sortie structurée validée par le schéma", async () => {
  const { exec } = recorder([reply({ answer: "ok" })]);
  assert.deepEqual(await makeCliLlm(1, exec).call("triage", "question", Out), { answer: "ok" });
});

test("cli : le modèle n'a aucun outil intégré et aucun serveur MCP", async () => {
  const { seen, exec } = recorder([reply({ answer: "ok" })]);
  await makeCliLlm(1, exec).call("triage", "question", Out);
  const { args, stdin } = seen[0];
  assert.equal(flag(args, "--tools"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(flag(args, "--setting-sources"), "");
  assert.equal(stdin, "question");
});

test("cli : chaque étape garde son modèle", async () => {
  const { seen, exec } = recorder([reply({ answer: "a" }), reply({ answer: "b" })]);
  const llm = makeCliLlm(1, exec);
  await llm.call("triage", "q", Out);
  await llm.call("write", "q", Out);
  assert.equal(flag(seen[0].args, "--model"), "claude-haiku-5-5");
  assert.equal(flag(seen[1].args, "--model"), "claude-sonnet-5-5");
});

test("cli : le coût et les tokens sont comptés à chaque appel", async () => {
  const { exec } = recorder([reply({ answer: "a" }), reply({ answer: "b" })]);
  const llm = makeCliLlm(1, exec);
  await llm.call("triage", "q", Out);
  await llm.call("triage", "q", Out);
  assert.equal(llm.spent, 0.02);
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0].inputTokens, 16);
  assert.equal(llm.calls[0].outputTokens, 7);
});

test("cli : le budget dépassé bloque l'appel suivant sans lancer le CLI", async () => {
  const { seen, exec } = recorder([reply({ answer: "a" })]);
  const llm = makeCliLlm(0.01, exec);
  await llm.call("triage", "q", Out);
  await assert.rejects(llm.call("triage", "q", Out), /budget/);
  assert.equal(seen.length, 1);
});

test("cli : une réponse en erreur ou hors schéma fait échouer l'étape", async () => {
  await assert.rejects(makeCliLlm(1, recorder([reply({ answer: "a" }, { is_error: true })]).exec).call("triage", "q", Out), /unusable/);
  await assert.rejects(makeCliLlm(1, recorder([reply({ wrong: 1 })]).exec).call("triage", "q", Out), /unusable/);
  await assert.rejects(makeCliLlm(1, recorder(["pas du json"]).exec).call("triage", "q", Out), /unusable/);
});

test("cli, boucle : un tour avec appels rend les appels et pas de sortie", async () => {
  const { exec } = recorder([reply({ calls: [{ name: "fetch_page", input: { url: "https://example.org/a" } }], output: null })]);
  const turn = await makeCliLlm(1, exec).open("research", "sujet", Out, [TOOL]).send([]);
  assert.equal(turn.output, null);
  assert.equal(turn.calls.length, 1);
  assert.equal(turn.calls[0].name, "fetch_page");
  assert.deepEqual(turn.calls[0].input, { url: "https://example.org/a" });
  assert.ok(turn.calls[0].id);
});

test("cli, boucle : le tour suivant revoit la demande, l'appel et son résultat", async () => {
  const { seen, exec } = recorder([
    reply({ calls: [{ name: "fetch_page", input: { url: "https://example.org/a" } }], output: null }),
    reply({ calls: [], output: { answer: "fini" } }),
  ]);
  const conversation = makeCliLlm(1, exec).open("research", "sujet du jour", Out, [TOOL]);
  const first = await conversation.send([]);
  const second = await conversation.send([{ id: first.calls[0].id, content: "texte de la page", isError: false }]);
  assert.deepEqual(second, { calls: [], output: { answer: "fini" } });
  assert.ok(seen[1].stdin.includes("sujet du jour"));
  assert.ok(seen[1].stdin.includes("https://example.org/a"));
  assert.ok(seen[1].stdin.includes("texte de la page"));
});

test("cli, boucle : une erreur d'outil est signalée comme telle au modèle", async () => {
  const { seen, exec } = recorder([
    reply({ calls: [{ name: "fetch_page", input: { url: "https://evil.example.com/" } }], output: null }),
    reply({ calls: [], output: { answer: "fini" } }),
  ]);
  const conversation = makeCliLlm(1, exec).open("research", "sujet", Out, [TOOL]);
  const first = await conversation.send([]);
  await conversation.send([{ id: first.calls[0].id, content: "not allowed", isError: true }]);
  assert.match(seen[1].stdin, /error="true"[^]*not allowed/);
});

test("cli, boucle : le schéma demandé au modèle limite les appels aux outils fournis", async () => {
  const { seen, exec } = recorder([reply({ calls: [], output: { answer: "fini" } })]);
  await makeCliLlm(1, exec).open("research", "sujet", Out, [TOOL]).send([]);
  const schema = JSON.parse(flag(seen[0].args, "--json-schema"));
  assert.deepEqual(schema.properties.calls.items.properties.name.enum, ["fetch_page"]);
  assert.equal(flag(seen[0].args, "--tools"), "");
});

test("cli, boucle : une sortie finale hors schéma fait échouer le tour", async () => {
  const { exec } = recorder([reply({ calls: [], output: { wrong: 1 } })]);
  await assert.rejects(makeCliLlm(1, exec).open("research", "sujet", Out, [TOOL]).send([]), /unusable/);
});
