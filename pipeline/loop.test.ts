import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent, type Conversation, type Tool, type ToolCall, type ToolEvent, type ToolResult, type Turn } from "./loop.ts";

// --- Fabriques : une conversation jouée d'avance, deux outils (un qui répond, un qui casse).

const call = (id: string, name = "echo", input: unknown = { n: id }): ToolCall => ({ id, name, input });
const asks = (...calls: ToolCall[]): Turn<string> => ({ calls, output: null });
const done = (output = "fini"): Turn<string> => ({ calls: [], output });

/** Rend les tours dans l'ordre et note ce que la boucle renvoie à chaque envoi. */
function scripted(...turns: Turn<string>[]) {
  const sent: ToolResult[][] = [];
  const conversation: Conversation<string> = {
    async send(results) {
      sent.push([...results]);
      const turn = turns[sent.length - 1];
      if (!turn) throw new Error("script épuisé");
      return turn;
    },
  };
  return { conversation, sent };
}

/** Un modèle qui appelle un outil à chaque tour et ne conclut jamais. */
function endless() {
  const sent: ToolResult[][] = [];
  const conversation: Conversation<string> = {
    async send(results) {
      sent.push([...results]);
      return asks(call(`c${sent.length}`));
    },
  };
  return { conversation, sent };
}

const echo: Tool = async (input) => `vu ${JSON.stringify(input)}`;
const boom: Tool = async () => {
  throw new Error("panne");
};
const tools = { echo, boom };

type Extra = { maxTurns?: number; onToolCall?: (e: ToolEvent) => void; tools?: Record<string, Tool> };
const go = (s: { conversation: Conversation<string> }, extra: Extra = {}) =>
  runAgent({ conversation: s.conversation, tools, maxTurns: 5, ...extra });

/** Lance la boucle et rend les événements reçus par `onToolCall`. */
async function eventsOf(...turns: Turn<string>[]) {
  const events: ToolEvent[] = [];
  await go(scripted(...turns), { onToolCall: (e) => events.push(e) });
  return events;
}

// --- Règle 1 : départ et fin

test("boucle : le premier envoi ne porte aucun résultat", async () => {
  const s = scripted(done());
  await go(s);
  assert.deepEqual(s.sent[0], []);
});

test("boucle : une sortie sans appel est rendue telle quelle", async () => {
  assert.equal(await go(scripted(done("la réponse"))), "la réponse");
});

test("boucle : une sortie sans appel termine la boucle, sans autre envoi", async () => {
  const s = scripted(done(), done("jamais lu"));
  await go(s);
  assert.equal(s.sent.length, 1);
});

// --- Règle 2 : un appel réussi

test("outil : il reçoit l'entrée de l'appel", async () => {
  const inputs: unknown[] = [];
  const spy: Tool = async (input) => {
    inputs.push(input);
    return "";
  };
  await go(scripted(asks(call("c1", "spy", { url: "https://example.org/a" })), done()), { tools: { spy } });
  assert.deepEqual(inputs, [{ url: "https://example.org/a" }]);
});

test("outil : son texte est renvoyé au modèle avec l'identifiant de l'appel, sans erreur", async () => {
  const s = scripted(asks(call("c1", "echo", { n: 1 })), done());
  await go(s);
  assert.deepEqual(s.sent[1], [{ id: "c1", content: 'vu {"n":1}', isError: false }]);
});

test("boucle : après un tour d'appels, la sortie du tour suivant est rendue", async () => {
  assert.equal(await go(scripted(asks(call("c1")), done("après l'outil"))), "après l'outil");
});

// --- Règle 3 : outil en échec, outil inconnu

test("outil en échec : le modèle reçoit le message d'erreur, marqué comme erreur", async () => {
  const s = scripted(asks(call("c1", "boom")), done());
  await go(s);
  assert.deepEqual(s.sent[1], [{ id: "c1", content: "panne", isError: true }]);
});

test("outil en échec : la boucle continue jusqu'à la sortie finale", async () => {
  assert.equal(await go(scripted(asks(call("c1", "boom")), done("malgré la panne"))), "malgré la panne");
});

test("outil inconnu : le modèle reçoit une erreur qui dit « unknown tool »", async () => {
  const s = scripted(asks(call("c1", "rm_rf")), done());
  await go(s);
  const [result] = s.sent[1];
  assert.deepEqual([result.id, result.isError], ["c1", true]);
  assert.match(result.content, /unknown tool/);
});

test("outil inconnu : la boucle continue jusqu'à la sortie finale", async () => {
  assert.equal(await go(scripted(asks(call("c1", "rm_rf")), done("malgré l'inconnu"))), "malgré l'inconnu");
});

// --- Règle 4 : un seul envoi par tour, dans l'ordre des appels

test("tour à plusieurs appels : tous les résultats partent dans un seul envoi", async () => {
  const s = scripted(asks(call("c1"), call("c2", "boom"), call("c3", "rm_rf")), done());
  await go(s);
  assert.deepEqual(s.sent.map((results) => results.length), [0, 3]);
});

test("tour à plusieurs appels : les résultats suivent l'ordre des appels, même si le premier outil est le plus lent", async () => {
  const slow: Tool = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "lent";
  };
  const s = scripted(asks(call("c1", "slow"), call("c2", "echo"), call("c3", "boom")), done());
  await go(s, { tools: { ...tools, slow } });
  assert.deepEqual(s.sent[1].map((r) => r.id), ["c1", "c2", "c3"]);
});

// --- Règle 5 : onToolCall

test("onToolCall : appelé exactement une fois par appel", async () => {
  const events = await eventsOf(asks(call("c1"), call("c2", "boom")), asks(call("c3", "rm_rf")), done());
  assert.deepEqual(events.map((e) => e.tool), ["echo", "boom", "rm_rf"]);
});

test("onToolCall : jamais appelé quand le modèle conclut sans outil", async () => {
  assert.deepEqual(await eventsOf(done()), []);
});

test("onToolCall : rapporte le nom de l'outil et l'entrée de l'appel", async () => {
  const [event] = await eventsOf(asks(call("c1", "echo", { n: 7 })), done());
  assert.deepEqual([event.tool, event.input], ["echo", { n: 7 }]);
});

test("onToolCall : un appel réussi est ok, sans détail", async () => {
  const [event] = await eventsOf(asks(call("c1")), done());
  assert.deepEqual([event.ok, event.detail], [true, undefined]);
});

test("onToolCall : un outil en échec n'est pas ok, avec le message d'erreur en détail", async () => {
  const [event] = await eventsOf(asks(call("c1", "boom")), done());
  assert.deepEqual([event.ok, event.detail], [false, "panne"]);
});

test("onToolCall : un outil inconnu n'est pas ok, avec « unknown tool » en détail", async () => {
  const [event] = await eventsOf(asks(call("c1", "rm_rf")), done());
  assert.equal(event.ok, false);
  assert.match(String(event.detail), /unknown tool/);
});

test("onToolCall : la durée est un nombre de millisecondes, jamais négatif", async () => {
  const events = await eventsOf(asks(call("c1"), call("c2", "boom"), call("c3", "rm_rf")), done());
  for (const e of events) assert.ok(typeof e.ms === "number" && e.ms >= 0, `ms invalide pour ${e.tool} : ${e.ms}`);
});

// --- Règle 6 : appels et sortie dans le même tour

const callsAndOutput = (): Turn<string> => ({ calls: [call("c1")], output: "prématurée" });

test("tour avec appels et sortie : la sortie de ce tour est ignorée, celle du tour final est rendue", async () => {
  assert.equal(await go(scripted(callsAndOutput(), done("finale"))), "finale");
});

test("tour avec appels et sortie : les appels sont exécutés et leurs résultats renvoyés", async () => {
  const s = scripted(callsAndOutput(), done());
  await go(s);
  assert.deepEqual(s.sent[1], [{ id: "c1", content: 'vu {"n":"c1"}', isError: false }]);
});

// --- Règle 7 : ni appel ni sortie

test("tour vide : sans appel ni sortie, la boucle échoue avec « no output »", async () => {
  await assert.rejects(go(scripted({ calls: [], output: null })), /no output/);
});

test("tour vide : la boucle s'arrête là, sans autre envoi", async () => {
  const s = scripted({ calls: [], output: null }, done());
  await assert.rejects(go(s));
  assert.equal(s.sent.length, 1);
});

// --- Règle 8 : maxTurns compte les envois

test("max turns : un modèle qui ne conclut jamais fait échouer la boucle avec « max turns »", async () => {
  await assert.rejects(go(endless(), { maxTurns: 3 }), /max turns/);
});

test("max turns : aucun envoi n'est fait au-delà de la limite", async () => {
  const s = endless();
  await assert.rejects(go(s, { maxTurns: 3 }));
  assert.equal(s.sent.length, 3);
});

test("max turns : une sortie finale reçue au dernier envoi permis est rendue", async () => {
  assert.equal(await go(scripted(asks(call("c1")), asks(call("c2")), done("juste à temps")), { maxTurns: 3 }), "juste à temps");
});
