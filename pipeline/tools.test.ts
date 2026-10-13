import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToText } from "./collect.ts";
import { isAllowed, makeFetchTool } from "./tools.ts";

const DOMAINS = ["example.org", "docs.example.net"];
const A = "https://example.org/a";
const B = "https://example.org/b";
const C = "https://example.org/c";
const HTML = `<html><script>var hidden = 1;</script><body><h1>Title</h1>
  <p>The model scores 91&nbsp;percent on the   benchmark.</p></body></html>`;

// --- Fabrique : un outil sur une liste blanche, un téléchargement factice qui note ce qu'on lui demande.

type Extra = { maxFetches?: number; maxChars?: number; fetchText?: (url: string) => Promise<string> };
function setup(extra: Extra = {}) {
  const fetched: string[] = [];
  const answer = extra.fetchText ?? (async () => HTML);
  const { tool, pages } = makeFetchTool({
    domains: DOMAINS,
    maxFetches: extra.maxFetches ?? 3,
    maxChars: extra.maxChars ?? 1000,
    fetchText: async (url) => {
      fetched.push(url);
      return answer(url);
    },
  });
  return { tool, pages, fetched };
}
const down = async () => {
  throw new Error("HTTP 500");
};

// --- Règle 1 : isAllowed

test("liste blanche : une adresse https sur un domaine autorisé passe", () => {
  assert.equal(isAllowed("https://example.org/a?x=1", DOMAINS), true);
});

test("liste blanche : chaque domaine de la liste est autorisé, pas seulement le premier", () => {
  assert.equal(isAllowed("https://docs.example.net/guide", DOMAINS), true);
});

test("liste blanche : un sous-domaine d'un domaine autorisé passe", () => {
  assert.equal(isAllowed("https://blog.example.org/post", DOMAINS), true);
});

test("liste blanche : une adresse http est refusée, même sur un domaine autorisé", () => {
  assert.equal(isAllowed("http://example.org/a", DOMAINS), false);
});

test("liste blanche : un texte qui n'est pas une adresse est refusé", () => {
  for (const input of ["", "example.org/a", "pas une adresse", "https://"]) assert.equal(isAllowed(input, DOMAINS), false, input);
});

test("liste blanche : un autre hôte est refusé", () => {
  assert.equal(isAllowed("https://evil.com/a", DOMAINS), false);
});

test("liste blanche : un domaine autorisé utilisé comme préfixe d'un autre hôte est refusé", () => {
  assert.equal(isAllowed("https://example.org.evil.com/a", DOMAINS), false);
});

test("liste blanche : un hôte qui se termine par le domaine sans en être un sous-domaine est refusé", () => {
  assert.equal(isAllowed("https://notexample.org/a", DOMAINS), false);
});

test("liste blanche : un domaine autorisé placé avant un @ ne trompe pas le contrôle de l'hôte", () => {
  assert.equal(isAllowed("https://example.org@evil.com/a", DOMAINS), false);
});

test("liste blanche : le domaine parent d'un domaine autorisé est refusé", () => {
  assert.equal(isAllowed("https://example.net/a", DOMAINS), false);
});

test("liste blanche : tout est refusé quand la liste est vide", () => {
  assert.equal(isAllowed(A, []), false);
});

// --- Règle 2 : entrée invalide

test("entrée invalide : tout ce qui n'est pas un objet avec une adresse en chaîne est refusé avec « invalid input »", async () => {
  const { tool } = setup();
  for (const input of [null, undefined, "https://example.org/a", 42, {}, { url: 42 }, { url: null }]) {
    await assert.rejects(tool(input), /invalid input/, JSON.stringify(input));
  }
});

test("entrée invalide : rien n'est téléchargé", async () => {
  const { tool, fetched } = setup();
  await assert.rejects(tool({ link: A }));
  assert.deepEqual(fetched, []);
});

// --- Règle 3 : adresse hors liste blanche

test("adresse hors liste : refusée avec « not allowed »", async () => {
  const { tool } = setup();
  await assert.rejects(tool({ url: "https://evil.com/a" }), /not allowed/);
});

test("adresse hors liste : rien n'est téléchargé", async () => {
  const { tool, fetched } = setup();
  await assert.rejects(tool({ url: "http://example.org/a" }));
  assert.deepEqual(fetched, []);
});

test("adresse hors liste : rien n'est gardé dans les pages", async () => {
  const { tool, pages } = setup();
  await assert.rejects(tool({ url: "https://evil.com/a" }));
  assert.equal(pages.size, 0);
});

// --- Règle 4 : adresse autorisée

test("adresse autorisée : elle est téléchargée", async () => {
  const { tool, fetched } = setup();
  await tool({ url: A });
  assert.deepEqual(fetched, [A]);
});

test("adresse autorisée : le texte rendu est celui de htmlToText, sans balises ni scripts", async () => {
  const { tool } = setup();
  assert.equal(await tool({ url: A }), htmlToText(HTML));
});

test("adresse autorisée : le texte rendu est coupé à maxChars", async () => {
  const { tool } = setup({ maxChars: 12 });
  assert.equal(await tool({ url: A }), htmlToText(HTML).slice(0, 12));
});

test("adresse autorisée : le texte gardé dans les pages est exactement le texte rendu, coupe comprise", async () => {
  const { tool, pages } = setup({ maxChars: 12 });
  const text = await tool({ url: A });
  assert.equal(pages.get(A), text);
});

test("adresse autorisée : la page est gardée sous son adresse normalisée", async () => {
  const { tool, pages } = setup();
  await tool({ url: "https://EXAMPLE.org" });
  assert.deepEqual([...pages.keys()], ["https://example.org/"]);
});

test("adresse autorisée : chaque page lue garde son propre texte", async () => {
  const { tool, pages } = setup({ fetchText: async (url) => `<p>page ${url}</p>` });
  await tool({ url: A });
  await tool({ url: B });
  assert.deepEqual([...pages], [[A, `page ${A}`], [B, `page ${B}`]]);
});

// --- Règle 5 : nombre de téléchargements

test("limite : au-delà de maxFetches adresses autorisées, la demande est refusée avec « fetch limit »", async () => {
  const { tool } = setup({ maxFetches: 2 });
  await tool({ url: A });
  await tool({ url: B });
  await assert.rejects(tool({ url: C }), /fetch limit/);
});

test("limite : une demande refusée pour dépassement ne télécharge rien", async () => {
  const { tool, fetched } = setup({ maxFetches: 2 });
  await tool({ url: A });
  await tool({ url: B });
  await assert.rejects(tool({ url: C }));
  assert.deepEqual(fetched, [A, B]);
});

test("limite : une entrée invalide ne consomme pas de téléchargement", async () => {
  const { tool } = setup({ maxFetches: 1 });
  await assert.rejects(tool({}));
  assert.equal(await tool({ url: A }), htmlToText(HTML));
});

test("limite : une adresse hors liste ne consomme pas de téléchargement", async () => {
  const { tool } = setup({ maxFetches: 1 });
  await assert.rejects(tool({ url: "https://evil.com/a" }));
  assert.equal(await tool({ url: A }), htmlToText(HTML));
});

test("limite : une adresse autorisée dont le téléchargement échoue consomme un téléchargement", async () => {
  const { tool } = setup({ maxFetches: 1, fetchText: down });
  await assert.rejects(tool({ url: A }), /HTTP 500/);
  await assert.rejects(tool({ url: B }), /fetch limit/);
});

// --- Règle 6 : téléchargement en échec

test("téléchargement en échec : l'outil échoue avec le message de l'erreur d'origine", async () => {
  const { tool } = setup({ fetchText: down });
  await assert.rejects(tool({ url: A }), { message: "HTTP 500" });
});

test("téléchargement en échec : rien n'est gardé pour cette adresse", async () => {
  const { tool, pages } = setup({ fetchText: down });
  await assert.rejects(tool({ url: A }));
  assert.equal(pages.has(A), false);
});

// --- Chemins : sur un hôte partagé (github.com, huggingface.co), le domaine ne suffit pas.

test("chemins : une adresse sous un préfixe autorisé passe", () => {
  assert.equal(isAllowed("https://github.com/anthropics/claude-code/releases/tag/v1", ["github.com"], ["/anthropics/claude-code/"]), true);
});

test("chemins : une adresse du même domaine hors des préfixes est refusée", () => {
  assert.equal(isAllowed("https://github.com/someone/else", ["github.com"], ["/anthropics/claude-code/"]), false);
});

test("chemins : sans préfixe déclaré, tout le domaine reste lisible", () => {
  assert.equal(isAllowed("https://github.com/someone/else", ["github.com"]), true);
  assert.equal(isAllowed("https://github.com/someone/else", ["github.com"], []), true);
});

test("chemins : l'outil refuse une page hors préfixe sans la télécharger", async () => {
  const asked: string[] = [];
  const { tool } = makeFetchTool({
    domains: ["github.com"],
    paths: ["/anthropics/claude-code/"],
    maxFetches: 3,
    maxChars: 1000,
    fetchText: async (url) => (asked.push(url), "<p>x</p>"),
  });
  await assert.rejects(tool({ url: "https://github.com/someone/else" }), /not allowed/);
  assert.deepEqual(asked, []);
});
