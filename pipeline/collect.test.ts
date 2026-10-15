import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchText } from "./collect.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Un téléchargement qui aboutit, après redirection, à `finalUrl`. */
function redirectedTo(finalUrl: string) {
  globalThis.fetch = async () => Object.defineProperty(new Response("ok"), "url", { value: finalUrl });
}
const FROM = "https://deepmind.google/blog/x/";

test("redirection : même hôte, la page est lue", async () => {
  redirectedTo("https://deepmind.google/blog/y/");
  assert.equal(await fetchText(FROM), "ok");
});

test("redirection : vers un autre hôte, refusée par défaut", async () => {
  redirectedTo("https://blog.google/innovation-and-ai/x/");
  await assert.rejects(fetchText(FROM), /redirected off-host to blog\.google/);
});

test("redirection : vers un autre domaine de la même source, la page est lue", async () => {
  redirectedTo("https://blog.google/innovation-and-ai/x/");
  assert.equal(await fetchText(FROM, (u) => new URL(u).hostname === "blog.google"), "ok");
});

test("redirection : vers un hôte que la source ne permet pas, refusée même si un prédicat est donné", async () => {
  redirectedTo("https://evil.com/x");
  await assert.rejects(fetchText(FROM, (u) => new URL(u).hostname === "blog.google"), /redirected off-host to evil\.com/);
});
