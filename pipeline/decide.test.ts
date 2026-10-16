import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import { decide, pickTopics, toStatements, withSecondSource } from "./decide.ts";
import type { Claim, Item, Radar, State, VerifyOut, WriteOut } from "./schema.ts";

type Draft = z.infer<typeof WriteOut>;
type Input = Parameters<typeof decide>[0];

const DATE = "2026-10-13";

/** Texte bilingue : les deux versions diffèrent toujours, pour qu'un test puisse les distinguer. */
type Text = { fr: string; en: string };
const t = (fr: string, en: string): Text => ({ fr, en });

// --- Fabriques : tout est valide par défaut, chaque test ne dérègle qu'une chose.

const claim = (id: string): Claim => ({
  id,
  text: t(`Fait ${id}`, `Fact ${id}`),
  quote: `Citation littérale du fait ${id}`,
  url: `https://example.org/${id}`,
});
const claimsOf = (...ids: string[]) => new Map(ids.map((id) => [id, claim(id)]));
const item = (id: string): Item => ({ id, url: `https://example.org/${id}`, title: `Source ${id}`, source: "Exemple", summary: "" });

const briefItem = (claimIds = ["c1"], itemId = "i1"): Draft["items"][number] => ({
  itemId,
  title: t("Un modèle", "A model"),
  summary: t("Il atteint 91 %.", "It reaches 91 percent."),
  why: t("Utile en production.", "Useful in production."),
  claimIds,
});
const radarEntry = (name = "Modèle X", ring: Draft["radar"][number]["ring"] = "essayer", claimIds = ["c1"]): Draft["radar"][number] => ({
  name,
  ring,
  rationale: t("91 % sur le benchmark.", "91 percent on the benchmark."),
  claimIds,
});
const statePoint = (claimIds = ["c1"], text = t("91 % est atteint.", "91 percent is reached.")): Draft["state"][number] => ({ sectionId: "modeles", text, claimIds });
const draftOf = (over: Partial<Draft> = {}): Draft => ({
  headline: t("Édition test", "Test edition"),
  items: [briefItem()],
  radar: [radarEntry()],
  state: [statePoint()],
  ...over,
});

const statementIds = (draft: Draft) => [
  ...draft.items.map((_, i) => `item:${i}`),
  ...draft.radar.map((_, i) => `radar:${i}`),
  ...draft.state.map((_, i) => `state:${i}`),
];

/** Le vérificateur valide tous les faits et tous les énoncés, sauf ceux nommés dans `refused`. */
const verdictOf = (draft: Draft, claims: Map<string, Claim>, refused: string[] = []): VerifyOut => ({
  claims: [...claims.keys()].map((id) => ({ id, supported: !refused.includes(id), reason: "" })),
  statements: statementIds(draft).map((id) => ({ id, supported: !refused.includes(id), reason: "" })),
});

function input(over: Partial<Input> = {}): Input {
  const draft = over.draft ?? draftOf();
  const claims = over.claims ?? claimsOf("c1");
  return {
    date: DATE,
    draft,
    claims,
    items: new Map([["i1", item("i1")]]),
    verdict: verdictOf(draft, claims),
    radar: { entries: [] },
    state: { points: [] },
    spentUsd: 1,
    budgetUsd: 2,
    ...over,
  };
}

const gate = (result: ReturnType<typeof decide>, name: string) => result.gates.find((g) => g.name === name);

/** 4 brèves + 3 entrées radar + 3 points = 10 énoncés, dont `refusedCount` refusés par le vérificateur. */
function tenStatements(refusedCount: number): Input {
  const draft = draftOf({
    items: [briefItem(), briefItem(), briefItem(), briefItem()],
    radar: [radarEntry("A"), radarEntry("B"), radarEntry("C")],
    state: [statePoint(), statePoint(), statePoint()],
  });
  const claims = claimsOf("c1");
  return input({ draft, claims, verdict: verdictOf(draft, claims, statementIds(draft).slice(0, refusedCount)) });
}

const existingRadar = (): Radar => ({
  entries: [
    {
      name: "Modèle X",
      ring: "evaluer",
      rationale: t("Ancienne justification.", "Former rationale."),
      evidence: [claim("c0")],
      since: "2026-09-01",
      history: [{ date: "2026-09-01", ring: "evaluer" }],
    },
  ],
});
const existingState = (): State => ({
  points: [{ date: "2026-09-01", sectionId: "agents", text: t("Point ancien.", "Former point."), evidence: [claim("c0")] }],
});

// --- Règle 1 : toStatements

test("énoncés : les brèves, puis le radar, puis l'état de l'art, numérotés à partir de zéro", () => {
  const draft = draftOf({ items: [briefItem(), briefItem()], radar: [radarEntry("A"), radarEntry("B")], state: [statePoint(), statePoint()] });
  assert.deepEqual(
    toStatements(draft).map((s) => s.id),
    ["item:0", "item:1", "radar:0", "radar:1", "state:0", "state:1"],
  );
});

test("énoncés : chacun porte les faits cités par son élément", () => {
  const draft = draftOf({ items: [briefItem(["c1", "c2"])], radar: [radarEntry("A", "essayer", ["c3"])], state: [statePoint(["c4"])] });
  assert.deepEqual(
    toStatements(draft).map((s) => s.claimIds),
    [["c1", "c2"], ["c3"], ["c4"]],
  );
});

test("énoncés : chacun a un texte non vide", () => {
  for (const s of toStatements(draftOf())) assert.ok(s.text.trim().length > 0, `texte vide pour ${s.id}`);
});

test("énoncés : le texte soumis au vérificateur est une chaîne, pas un objet bilingue", () => {
  for (const s of toStatements(draftOf())) assert.equal(typeof s.text, "string", `texte non textuel pour ${s.id}`);
});

const statementText = (id: string) => toStatements(draftOf()).find((s) => s.id === id)!.text;
const assertContainsBoth = (text: string, ...proses: Text[]) => {
  for (const prose of proses) for (const version of [prose.fr, prose.en]) assert.ok(String(text).includes(version), `« ${version} » absent de « ${text} »`);
};

test("énoncés : une brève soumet son titre, son résumé et son intérêt dans les deux langues", () => {
  const { title, summary, why } = briefItem();
  assertContainsBoth(statementText("item:0"), title, summary, why);
});

test("énoncés : une entrée radar soumet sa justification dans les deux langues", () => {
  assertContainsBoth(statementText("radar:0"), radarEntry().rationale);
});

test("énoncés : un point d'état de l'art soumet son texte dans les deux langues", () => {
  assertContainsBoth(statementText("state:0"), statePoint().text);
});

// --- Règle 2 : énoncé publiable

test("publiable : un brouillon entièrement validé est publié en entier, sans rejet", () => {
  const result = decide(input());
  assert.equal(result.published, 3);
  assert.deepEqual(result.rejected, []);
});

// Chaque cas refuse le seul point d'état de l'art d'un brouillon de 4 énoncés : 3/4 reste au-dessus du seuil.
const fourWith = (point: Draft["state"][number]) => draftOf({ items: [briefItem(), briefItem()], state: [point] });
const assertOneRefusal = (result: ReturnType<typeof decide>, reason: string) => {
  assert.equal(result.published, 3);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, reason);
  assert.deepEqual(result.state.points, []);
};

test("publiable : un énoncé qui ne cite aucun fait est refusé", () => {
  assertOneRefusal(decide(input({ draft: fourWith(statePoint([])) })), "no_claim_cited");
});

test("publiable : un énoncé qui cite un fait absent des fiches est refusé", () => {
  const draft = fourWith(statePoint(["c1", "inventé"]));
  const claims = claimsOf("c1");
  const verdict = verdictOf(draft, claims);
  verdict.claims.push({ id: "inventé", supported: true, reason: "" });
  assertOneRefusal(decide(input({ draft, claims, verdict })), "unknown_claim");
});

test("publiable : un énoncé qui cite un fait refusé par le vérificateur est refusé", () => {
  const draft = fourWith(statePoint(["c1", "c2"]));
  const claims = claimsOf("c1", "c2");
  assertOneRefusal(decide(input({ draft, claims, verdict: verdictOf(draft, claims, ["c2"]) })), "claim_unsupported");
});

test("publiable : un fait sans verdict vaut un refus", () => {
  const draft = fourWith(statePoint(["c2"]));
  const claims = claimsOf("c1", "c2");
  const verdict = verdictOf(draft, claims);
  verdict.claims = verdict.claims.filter((c) => c.id !== "c2");
  assertOneRefusal(decide(input({ draft, claims, verdict })), "claim_unsupported");
});

test("publiable : un énoncé refusé par le vérificateur est refusé", () => {
  const draft = fourWith(statePoint());
  const claims = claimsOf("c1");
  assertOneRefusal(decide(input({ draft, claims, verdict: verdictOf(draft, claims, ["state:0"]) })), "statement_unsupported");
});

test("publiable : un énoncé sans verdict vaut un refus", () => {
  const draft = fourWith(statePoint());
  const claims = claimsOf("c1");
  const verdict = verdictOf(draft, claims);
  verdict.statements = verdict.statements.filter((s) => s.id !== "state:0");
  assertOneRefusal(decide(input({ draft, claims, verdict })), "statement_unsupported");
});

test("publiable : un énoncé refusé porte en détail la raison du vérificateur", () => {
  const draft = fourWith(statePoint());
  const claims = claimsOf("c1");
  const verdict = verdictOf(draft, claims, ["state:0"]);
  verdict.statements.find((s) => s.id === "state:0")!.reason = "dit plus que les faits";
  const { rejected } = decide(input({ draft, claims, verdict }));
  assert.deepEqual([rejected[0].reason, rejected[0].detail], ["statement_unsupported", "dit plus que les faits"]);
});

test("publiable : un énoncé sans verdict est refusé sans détail", () => {
  const draft = fourWith(statePoint());
  const claims = claimsOf("c1");
  const verdict = verdictOf(draft, claims);
  verdict.statements = verdict.statements.filter((s) => s.id !== "state:0");
  assert.equal("detail" in decide(input({ draft, claims, verdict })).rejected[0], false);
});

test("publiable : chaque énoncé refusé ajoute une entrée aux rejets, avec sa raison", () => {
  const result = decide(tenStatements(3));
  assert.equal(result.rejected.length, 3);
  for (const r of result.rejected) assert.ok(r.what && r.reason);
});

test("rejets : une brève refusée est désignée par son titre bilingue", () => {
  const refused = { ...briefItem([]), title: t("Brève refusée", "Refused item") };
  const { rejected } = decide(input({ draft: draftOf({ items: [briefItem(), refused, briefItem(), briefItem()] }) }));
  assert.deepEqual(rejected.map((r) => r.what), [t("Brève refusée", "Refused item")]);
});

test("rejets : une entrée radar refusée est désignée par son nom, identique dans les deux langues", () => {
  const draft = draftOf({ items: [briefItem(), briefItem()], radar: [radarEntry("Outil Y", "essayer", [])] });
  assert.deepEqual(decide(input({ draft })).rejected.map((r) => r.what), [t("Outil Y", "Outil Y")]);
});

test("rejets : un point d'état de l'art refusé est désigné par son texte bilingue", () => {
  const text = t("Point refusé.", "Refused point.");
  const { rejected } = decide(input({ draft: fourWith(statePoint([], text)) }));
  assert.deepEqual(rejected.map((r) => r.what), [text]);
});

// Plafond : ce qui désigne un rejet tient en 200 caractères par langue.
const whatOfRefusedPoint = (text: Text) => decide(input({ draft: fourWith(statePoint([], text)) })).rejected.map((r) => r.what);

test("rejets : un texte de plus de 200 caractères est coupé à ses 200 premiers, dans chaque langue", () => {
  const long = t(`${"F".repeat(200)} suite coupée`, `${"E".repeat(200)} dropped tail`);
  assert.deepEqual(whatOfRefusedPoint(long), [t("F".repeat(200), "E".repeat(200))]);
});

test("rejets : un texte de 200 caractères exactement reste entier", () => {
  const exact = t("F".repeat(200), "E".repeat(200));
  assert.deepEqual(whatOfRefusedPoint(exact), [exact]);
});

test("rejets : une version courte reste entière quand l'autre langue est coupée", () => {
  assert.deepEqual(whatOfRefusedPoint(t("F".repeat(250), "Short.")), [t("F".repeat(200), "Short.")]);
});

test("rejets : le titre d'une brève refusée est coupé à 200 caractères par langue", () => {
  const refused = { ...briefItem([]), title: t("F".repeat(250), "E".repeat(250)) };
  const { rejected } = decide(input({ draft: draftOf({ items: [briefItem(), refused, briefItem(), briefItem()] }) }));
  assert.deepEqual(rejected.map((r) => r.what), [t("F".repeat(200), "E".repeat(200))]);
});

test("rejets : le nom d'une entrée radar refusée est coupé à 200 caractères", () => {
  const draft = draftOf({ items: [briefItem(), briefItem()], radar: [radarEntry("N".repeat(250), "essayer", [])] });
  assert.deepEqual(decide(input({ draft })).rejected.map((r) => r.what), [t("N".repeat(200), "N".repeat(200))]);
});

// --- Règle 3 : les trois portes

test("portes : les trois portes sont rapportées quand le run est publié", () => {
  assert.deepEqual(decide(input()).gates.map((g) => g.name).sort(), ["budget", "verifier", "volume"]);
});

test("portes : les trois portes sont rapportées quand le run est rejeté", () => {
  assert.deepEqual(decide(input({ spentUsd: 3 })).gates.map((g) => g.name).sort(), ["budget", "verifier", "volume"]);
});

// Chaque énoncé est déjà vérifié un par un : la porte ne sert qu'à détecter un rédacteur qui déraille.
test("porte verifier : passe à exactement la moitié d'énoncés publiables", () => {
  const result = decide(tenStatements(5));
  assert.equal(result.published, 5);
  assert.equal(gate(result, "verifier")?.pass, true);
});

test("porte verifier : échoue sous la moitié d'énoncés publiables", () => {
  assert.equal(gate(decide(tenStatements(6)), "verifier")?.pass, false);
});

test("porte volume : passe avec 3 entrées radar et 3 points d'état de l'art", () => {
  assert.equal(gate(decide(tenStatements(0)), "volume")?.pass, true);
});

test("porte volume : échoue avec 4 entrées radar", () => {
  const draft = draftOf({ radar: [radarEntry("A"), radarEntry("B"), radarEntry("C"), radarEntry("D")] });
  assert.equal(gate(decide(input({ draft })), "volume")?.pass, false);
});

test("porte volume : échoue avec 4 points d'état de l'art", () => {
  const draft = draftOf({ state: [statePoint(), statePoint(), statePoint(), statePoint()] });
  assert.equal(gate(decide(input({ draft })), "volume")?.pass, false);
});

test("porte budget : passe quand la dépense atteint exactement le budget", () => {
  assert.equal(gate(decide(input({ spentUsd: 2, budgetUsd: 2 })), "budget")?.pass, true);
});

test("porte budget : échoue quand la dépense dépasse le budget", () => {
  assert.equal(gate(decide(input({ spentUsd: 2.01, budgetUsd: 2 })), "budget")?.pass, false);
});

// Le détail d'une porte est lu dans les deux langues : chiffres, symboles et quelques mots neutres seulement.
const NEUTRAL_WORDS = new Set(["radar", "state", "USD", "max"]);
function assertNeutralDetail(detail: string | undefined) {
  assert.equal(typeof detail, "string");
  assert.doesNotMatch(detail!, /[\u00C0-\u024F]/, "caractère accentué");
  assert.doesNotMatch(detail!, /citations|énoncés|validés|seuil|retrouvées/i, "mot français");
  assert.deepEqual((detail!.match(/\p{L}+/gu) ?? []).filter((word) => !NEUTRAL_WORDS.has(word)), [], "mot hors vocabulaire neutre");
}

test("porte verifier : son détail est neutre en langue", () => {
  assertNeutralDetail(gate(decide(tenStatements(3)), "verifier")?.detail);
});

test("porte volume : son détail est neutre en langue", () => {
  assertNeutralDetail(gate(decide(tenStatements(0)), "volume")?.detail);
});

test("porte budget : son détail est neutre en langue", () => {
  assertNeutralDetail(gate(decide(input({ spentUsd: 0.012, budgetUsd: 2 })), "budget")?.detail);
});

// --- Règle 4 : une porte échoue

test("rejet : le vérificateur sous le seuil rejette le run", () => {
  assert.equal(decide(tenStatements(6)).status, "rejected");
});

test("rejet : un volume excessif rejette le run, même entièrement validé", () => {
  const draft = draftOf({ radar: [radarEntry("A"), radarEntry("B"), radarEntry("C"), radarEntry("D")] });
  assert.equal(decide(input({ draft })).status, "rejected");
});

test("rejet : un budget dépassé rejette le run, même entièrement validé", () => {
  assert.equal(decide(input({ spentUsd: 3 })).status, "rejected");
});

test("rejet : aucune brève n'est produite", () => {
  assert.equal(decide(input({ spentUsd: 3 })).brief, undefined);
});

test("rejet : le radar rendu est celui reçu", () => {
  assert.deepEqual(decide(input({ spentUsd: 3, radar: existingRadar() })).radar, existingRadar());
});

test("rejet : l'état de l'art rendu est celui reçu", () => {
  assert.deepEqual(decide(input({ spentUsd: 3, state: existingState() })).state, existingState());
});

// --- Règle 5 : toutes les portes passent

test("publication : le run est publié quand les trois portes passent", () => {
  assert.equal(decide(input()).status, "published");
});

test("brève : porte la date du run, et son titre est fait des titres des brèves publiées, pas d'un texte libre", () => {
  const { brief } = decide(input());
  const titles = brief!.items.map((x) => x.title);
  assert.equal(brief?.date, DATE);
  assert.equal(brief?.headline.fr, titles.map((x) => x.fr).join(" ; "));
  assert.equal(brief?.headline.en, titles.map((x) => x.en).join("; "));
});

test("brève : le titre libre du brouillon n'est jamais publié, faute d'être vérifié", () => {
  const { brief } = decide(input());
  assert.notEqual(brief?.headline.fr, "Édition test");
});

test("brève : le titre, le résumé et l'intérêt viennent du brouillon", () => {
  const [entry] = decide(input()).brief!.items;
  assert.deepEqual(
    [entry.title, entry.summary, entry.why],
    [t("Un modèle", "A model"), t("Il atteint 91 %.", "It reaches 91 percent."), t("Utile en production.", "Useful in production.")],
  );
});

test("brève : l'adresse et la source viennent de l'article collecté", () => {
  const [entry] = decide(input()).brief!.items;
  assert.deepEqual([entry.url, entry.source], ["https://example.org/i1", "Exemple"]);
});

test("brève : les faits cités sont rendus en entier", () => {
  const draft = draftOf({ items: [briefItem(["c1", "c2"])] });
  const [entry] = decide(input({ draft, claims: claimsOf("c1", "c2") })).brief!.items;
  assert.deepEqual(entry.claims, [claim("c1"), claim("c2")]);
});

test("brève : une brève refusée n'y figure pas", () => {
  const draft = draftOf({ items: [briefItem(), briefItem([]), briefItem(), briefItem()] });
  assert.equal(decide(input({ draft })).brief!.items.length, 3);
});

test("brève : une brève dont l'article est inconnu est laissée de côté", () => {
  const draft = draftOf({ items: [briefItem(), briefItem(["c1"], "inconnu")] });
  assert.deepEqual(decide(input({ draft })).brief!.items.map((i) => i.url), ["https://example.org/i1"]);
});

test("brève : absente quand il ne reste aucune brève, sans empêcher la publication", () => {
  const result = decide(input({ draft: draftOf({ items: [briefItem(["c1"], "inconnu")] }) }));
  assert.deepEqual([result.status, result.brief], ["published", undefined]);
});

test("radar : un nouveau nom entre avec son anneau, sa justification, ses preuves et son historique", () => {
  assert.deepEqual(decide(input()).radar.entries, [
    {
      name: "Modèle X",
      ring: "essayer",
      rationale: t("91 % sur le benchmark.", "91 percent on the benchmark."),
      evidence: [claim("c1")],
      since: DATE,
      history: [{ date: DATE, ring: "essayer" }],
    },
  ]);
});

test("radar : un nom déjà présent, écrit dans une autre casse, ne crée pas de doublon", () => {
  const draft = draftOf({ radar: [radarEntry("MODÈLE x", "adopter")] });
  assert.equal(decide(input({ draft, radar: existingRadar() })).radar.entries.length, 1);
});

test("radar : un mouvement remplace l'anneau, la justification et les preuves", () => {
  const draft = draftOf({ radar: [radarEntry("MODÈLE x", "adopter")] });
  const [entry] = decide(input({ draft, radar: existingRadar() })).radar.entries;
  assert.deepEqual([entry.ring, entry.rationale, entry.evidence], ["adopter", t("91 % sur le benchmark.", "91 percent on the benchmark."), [claim("c1")]]);
});

test("radar : un mouvement garde la date d'entrée d'origine", () => {
  const draft = draftOf({ radar: [radarEntry("MODÈLE x", "adopter")] });
  assert.equal(decide(input({ draft, radar: existingRadar() })).radar.entries[0].since, "2026-09-01");
});

test("radar : un mouvement s'ajoute à la fin de l'historique", () => {
  const draft = draftOf({ radar: [radarEntry("MODÈLE x", "adopter")] });
  assert.deepEqual(decide(input({ draft, radar: existingRadar() })).radar.entries[0].history, [
    { date: "2026-09-01", ring: "evaluer" },
    { date: DATE, ring: "adopter" },
  ]);
});

test("radar : les entrées non concernées par le run sont conservées", () => {
  const draft = draftOf({ radar: [radarEntry("Autre outil")] });
  const { entries } = decide(input({ draft, radar: existingRadar() })).radar;
  assert.deepEqual(entries.find((e) => e.name === "Modèle X"), existingRadar().entries[0]);
});

test("radar : une entrée refusée n'y entre pas", () => {
  const draft = draftOf({ items: [briefItem(), briefItem()], radar: [radarEntry("Modèle X", "essayer", [])] });
  assert.deepEqual(decide(input({ draft })).radar.entries, []);
});

test("état de l'art : un point publiable est ajouté avec sa date, sa section, son texte et ses preuves", () => {
  assert.deepEqual(decide(input()).state.points, [
    { date: DATE, sectionId: "modeles", text: t("91 % est atteint.", "91 percent is reached."), evidence: [claim("c1")] },
  ]);
});

test("état de l'art : les nouveaux points s'ajoutent après les anciens", () => {
  const { points } = decide(input({ state: existingState() })).state;
  assert.deepEqual(points.map((p) => p.text), [t("Point ancien.", "Former point."), t("91 % est atteint.", "91 percent is reached.")]);
});

// --- Règle 6 : pureté

const publishedRun = () => input({ radar: existingRadar(), state: existingState(), draft: draftOf({ radar: [radarEntry("modèle x", "adopter")] }) });

test("pureté : le radar reçu n'est pas modifié par un run publié", () => {
  const given = publishedRun();
  assert.equal(decide(given).status, "published");
  assert.deepEqual(given.radar, existingRadar());
});

test("pureté : l'état de l'art reçu n'est pas modifié par un run publié", () => {
  const given = publishedRun();
  assert.equal(decide(given).status, "published");
  assert.deepEqual(given.state, existingState());
});

test("pureté : le brouillon reçu n'est pas modifié par un run publié", () => {
  const given = publishedRun();
  const before = structuredClone(given.draft);
  assert.equal(decide(given).status, "published");
  assert.deepEqual(given.draft, before);
});

test("pureté : les faits et les articles reçus ne sont pas modifiés par un run publié", () => {
  const given = publishedRun();
  const before = structuredClone([given.claims, given.items]);
  assert.equal(decide(given).status, "published");
  assert.deepEqual([given.claims, given.items], before);
});

// --- Choix des sujets : la diversité des sources est une règle, pas un espoir.

const topic = (id: string, source: string) => ({ id, url: `https://example.org/${id}`, title: id, source, summary: "" });
const topics = new Map(
  [topic("a1", "A"), topic("a2", "A"), topic("a3", "A"), topic("b1", "B"), topic("c1", "C")].map((i) => [i.id, i]),
);
const scored = (...ids: string[]) => ids.map((id, i) => ({ id, score: 10 - i, reason: "" }));
const capOf = (caps: Record<string, number>) => (source: string) => caps[source] ?? 2;

test("sujets : une source ne peut pas dépasser son plafond, même avec les meilleurs scores", () => {
  const picked = pickTopics(scored("a1", "a2", "a3", "b1", "c1"), topics, capOf({}), 6);
  assert.deepEqual(picked.map((i) => i.id), ["a1", "a2", "b1", "c1"]);
});

test("sujets : le plafond se règle source par source", () => {
  const picked = pickTopics(scored("a1", "a2", "b1"), topics, capOf({ A: 1 }), 6);
  assert.deepEqual(picked.map((i) => i.id), ["a1", "b1"]);
});

test("sujets : les mieux notés passent d'abord, quel que soit l'ordre reçu", () => {
  const picks = [{ id: "c1", score: 3, reason: "" }, { id: "b1", score: 9, reason: "" }, { id: "a1", score: 6, reason: "" }];
  assert.deepEqual(pickTopics(picks, topics, capOf({}), 2).map((i) => i.id), ["b1", "a1"]);
});

test("sujets : un identifiant inconnu est ignoré", () => {
  assert.deepEqual(pickTopics(scored("zz", "b1"), topics, capOf({}), 6).map((i) => i.id), ["b1"]);
});

// --- Second source : un sujet recoupé par une source indépendante passe avant les autres, qui restent publiables

const from = (id: string, source: string): Item => ({ ...item(id), source });
const world = (...items: Item[]) => new Map(items.map((i) => [i.id, i]));
const groupOf = (source: string) => (source.startsWith("Google") ? "google" : source);
const viaOf = (picks: Parameters<typeof withSecondSource>[0], items: ReturnType<typeof world>) => withSecondSource(picks, items, groupOf).map((p) => [p.id, p.via?.id]);

test("second source : un sujet sans autre source sur la même histoire reste, sans second item", () => {
  const items = world(from("a", "A"), from("b", "B"));
  assert.deepEqual(viaOf([{ id: "a", score: 9 }, { id: "b", score: 8, sameStory: [] }], items), [["a", undefined], ["b", undefined]]);
});

test("second source : le sujet reçoit l'item de l'autre source, qui n'est plus un sujet à part", () => {
  const items = world(from("a", "A"), from("b", "B"));
  assert.deepEqual(viaOf([{ id: "a", score: 9, sameStory: ["b"] }, { id: "b", score: 8 }], items), [["a", "b"]]);
});

test("second source : deux sources du même groupe ne se recoupent pas", () => {
  const items = world(from("a", "Google AI"), from("b", "Google DeepMind"));
  assert.deepEqual(viaOf([{ id: "a", score: 9, sameStory: ["b"] }], items), [["a", undefined]]);
});

test("second source : un identifiant inconnu ou l'item lui-même ne recoupe rien", () => {
  const items = world(from("a", "A"));
  assert.deepEqual(viaOf([{ id: "a", score: 9, sameStory: ["a", "inconnu"] }], items), [["a", undefined]]);
});

test("second source : un item ne recoupe qu'un sujet, le suivant reste sans second item", () => {
  const items = world(from("a", "A"), from("b", "B"), from("c", "C"));
  const picks = [
    { id: "a", score: 9, sameStory: ["b"] },
    { id: "b", score: 8, sameStory: ["a"] },
    { id: "c", score: 7, sameStory: ["b"] },
  ];
  assert.deepEqual(viaOf(picks, items), [["a", "b"], ["c", undefined]]);
});

test("second source : un sujet mieux noté mais seul laisse la place à celui qui le recoupe", () => {
  const items = world(from("a", "A"), from("b", "B"));
  assert.deepEqual(viaOf([{ id: "a", score: 9 }, { id: "b", score: 5, sameStory: ["a"] }], items), [["b", "a"]]);
});

test("sujets : ceux qu'une seconde source recoupe passent avant les mieux notés", () => {
  const topics = world(from("a", "A"), from("b", "B"));
  const picked = pickTopics([{ id: "a", score: 9 }, { id: "b", score: 5, via: {} }], topics, () => 5, 1);
  assert.deepEqual(picked.map((i) => i.id), ["b"]);
});

test("brève : le sujet recoupé nomme sa seconde source et passe en tête, l'autre reste sans", () => {
  const draft = draftOf({ items: [briefItem(["c1"], "i1"), briefItem(["c1"], "i2")], radar: [], state: [] });
  const claims = claimsOf("c1");
  const result = decide(input({ draft, claims, verdict: verdictOf(draft, claims), items: world(item("i1"), item("i2")), via: world(from("v", "Autre")).has("v") ? new Map([["i2", from("v", "Autre")]]) : undefined }));
  assert.deepEqual(result.brief?.items.map((x) => x.confirmedBy?.source), ["Autre", undefined]);
});
