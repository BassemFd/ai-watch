import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import { decide, toStatements } from "./decide.ts";
import type { Claim, Item, Radar, State, VerifyOut, WriteOut } from "./schema.ts";

type Draft = z.infer<typeof WriteOut>;
type Input = Parameters<typeof decide>[0];

const DATE = "2026-10-13";

// --- Fabriques : tout est valide par défaut, chaque test ne dérègle qu'une chose.

const claim = (id: string): Claim => ({
  id,
  text: `Fait ${id}`,
  quote: `Citation littérale du fait ${id}`,
  url: `https://example.org/${id}`,
});
const claimsOf = (...ids: string[]) => new Map(ids.map((id) => [id, claim(id)]));
const item = (id: string): Item => ({ id, url: `https://example.org/${id}`, title: `Source ${id}`, source: "Exemple", summary: "" });

const briefItem = (claimIds = ["c1"], itemId = "i1"): Draft["items"][number] => ({
  itemId,
  title: "Un modèle",
  summary: "91 %.",
  why: "Utile.",
  claimIds,
});
const radarEntry = (name = "Modèle X", ring: Draft["radar"][number]["ring"] = "essayer", claimIds = ["c1"]): Draft["radar"][number] => ({
  name,
  ring,
  rationale: "91 % sur le benchmark.",
  claimIds,
});
const statePoint = (claimIds = ["c1"], text = "91 % est atteint."): Draft["state"][number] => ({ sectionId: "modeles", text, claimIds });
const draftOf = (over: Partial<Draft> = {}): Draft => ({
  headline: "Édition test",
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
      rationale: "Ancienne justification.",
      evidence: [claim("c0")],
      since: "2026-09-01",
      history: [{ date: "2026-09-01", ring: "evaluer" }],
    },
  ],
});
const existingState = (): State => ({
  points: [{ date: "2026-09-01", sectionId: "agents", text: "Point ancien.", evidence: [claim("c0")] }],
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

// --- Règle 2 : énoncé publiable

test("publiable : un brouillon entièrement validé est publié en entier, sans rejet", () => {
  const result = decide(input());
  assert.equal(result.published, 3);
  assert.deepEqual(result.rejected, []);
});

// Chaque cas refuse le seul point d'état de l'art d'un brouillon de 4 énoncés : 3/4 reste au-dessus du seuil.
const fourWith = (point: Draft["state"][number]) => draftOf({ items: [briefItem(), briefItem()], state: [point] });
const assertOneRefusal = (result: ReturnType<typeof decide>) => {
  assert.equal(result.published, 3);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.state.points, []);
};

test("publiable : un énoncé qui ne cite aucun fait est refusé", () => {
  assertOneRefusal(decide(input({ draft: fourWith(statePoint([])) })));
});

test("publiable : un énoncé qui cite un fait absent des fiches est refusé", () => {
  const draft = fourWith(statePoint(["c1", "inventé"]));
  const claims = claimsOf("c1");
  const verdict = verdictOf(draft, claims);
  verdict.claims.push({ id: "inventé", supported: true, reason: "" });
  assertOneRefusal(decide(input({ draft, claims, verdict })));
});

test("publiable : un énoncé qui cite un fait refusé par le vérificateur est refusé", () => {
  const draft = fourWith(statePoint(["c1", "c2"]));
  const claims = claimsOf("c1", "c2");
  assertOneRefusal(decide(input({ draft, claims, verdict: verdictOf(draft, claims, ["c2"]) })));
});

test("publiable : un fait sans verdict vaut un refus", () => {
  const draft = fourWith(statePoint(["c2"]));
  const claims = claimsOf("c1", "c2");
  const verdict = verdictOf(draft, claims);
  verdict.claims = verdict.claims.filter((c) => c.id !== "c2");
  assertOneRefusal(decide(input({ draft, claims, verdict })));
});

test("publiable : un énoncé refusé par le vérificateur est refusé", () => {
  const draft = fourWith(statePoint());
  const claims = claimsOf("c1");
  assertOneRefusal(decide(input({ draft, claims, verdict: verdictOf(draft, claims, ["state:0"]) })));
});

test("publiable : un énoncé sans verdict vaut un refus", () => {
  const draft = fourWith(statePoint());
  const claims = claimsOf("c1");
  const verdict = verdictOf(draft, claims);
  verdict.statements = verdict.statements.filter((s) => s.id !== "state:0");
  assertOneRefusal(decide(input({ draft, claims, verdict })));
});

test("publiable : chaque énoncé refusé ajoute une entrée aux rejets, avec sa raison", () => {
  const result = decide(tenStatements(3));
  assert.equal(result.rejected.length, 3);
  for (const r of result.rejected) assert.ok(r.what && r.reason);
});

// --- Règle 3 : les trois portes

test("portes : les trois portes sont rapportées quand le run est publié", () => {
  assert.deepEqual(decide(input()).gates.map((g) => g.name).sort(), ["budget", "volume", "vérificateur"]);
});

test("portes : les trois portes sont rapportées quand le run est rejeté", () => {
  assert.deepEqual(decide(input({ spentUsd: 3 })).gates.map((g) => g.name).sort(), ["budget", "volume", "vérificateur"]);
});

test("porte vérificateur : passe à exactement 70 % d'énoncés publiables", () => {
  const result = decide(tenStatements(3));
  assert.equal(result.published, 7);
  assert.equal(gate(result, "vérificateur")?.pass, true);
});

test("porte vérificateur : échoue sous 70 % d'énoncés publiables", () => {
  assert.equal(gate(decide(tenStatements(4)), "vérificateur")?.pass, false);
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

// --- Règle 4 : une porte échoue

test("rejet : le vérificateur sous le seuil rejette le run", () => {
  assert.equal(decide(tenStatements(4)).status, "rejected");
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

test("brève : porte la date du run et le titre du brouillon", () => {
  const { brief } = decide(input());
  assert.deepEqual([brief?.date, brief?.headline], [DATE, "Édition test"]);
});

test("brève : le titre, le résumé et l'intérêt viennent du brouillon", () => {
  const [entry] = decide(input()).brief!.items;
  assert.deepEqual([entry.title, entry.summary, entry.why], ["Un modèle", "91 %.", "Utile."]);
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
      rationale: "91 % sur le benchmark.",
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
  assert.deepEqual([entry.ring, entry.rationale, entry.evidence], ["adopter", "91 % sur le benchmark.", [claim("c1")]]);
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
    { date: DATE, sectionId: "modeles", text: "91 % est atteint.", evidence: [claim("c1")] },
  ]);
});

test("état de l'art : les nouveaux points s'ajoutent après les anciens", () => {
  const { points } = decide(input({ state: existingState() })).state;
  assert.deepEqual(points.map((p) => p.text), ["Point ancien.", "91 % est atteint."]);
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
