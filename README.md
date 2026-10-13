# Veille IA

Un site de veille sur l'IA écrit, vérifié et publié chaque jour par un pipeline de modèles, sans relecture humaine. Le contenu est généré en français et en anglais ; le site sert le français à la racine et l'anglais sous `/en/`.

## Principe

L'orchestration est du code ; les modèles n'ont aucun outil.

1. **Collecte** (code) — flux RSS/Atom de `sources.json`, liste blanche de domaines, déduplication.
2. **Tri** (Haiku 5.5) — garde au plus six sujets.
3. **Recherche** (Sonnet 5.5, en parallèle) — extrait des faits, chacun avec une citation exacte.
4. **Porte** (code) — la citation doit figurer mot pour mot dans la page.
5. **Rédaction** (Opus 5.5) — écrit en français et en anglais à partir des seuls faits vérifiés.
6. **Vérification** (Sonnet 5.5, contexte neuf) — juge chaque fait et chaque phrase, dans les deux langues.
7. **Portes et publication** (code) — seuil du vérificateur, volume, budget ; un échec et aucun contenu n'est écrit. La trace du run l'est toujours.

Les portes prouvent qu'une phrase est sourcée, pas que la source dit vrai : `sources.json` est tenu à la main.

## Architecture

Règle de dépendance, sans cérémonie : les règles ne connaissent ni le réseau, ni les fichiers, ni le SDK.

| Fichier | Rôle | E/S |
|---|---|---|
| `pipeline/schema.ts` | formes des données et codes (raisons de rejet, portes) | non |
| `pipeline/gates.ts` | citation mot pour mot, énoncé publiable | non |
| `pipeline/decide.ts` | ce qui est publié à partir d'un brouillon et des verdicts | non |
| `pipeline/run.ts` | orchestration des étapes, lecture et écriture des fichiers | oui |
| `pipeline/agents.ts` | seul point de contact avec les modèles | oui |
| `pipeline/collect.ts` | flux et pages web | oui |

La trace d'un run ne contient aucune phrase : des codes et des chiffres, traduits à l'affichage par `site/src/lib/i18n.ts`.

## Développement en TDD

Chaque comportement passe par un cycle à un agent par phase, lancé par `/tdd` dans Claude Code :

| Phase | Agent | Porte (`tdd/gate.sh`) | Commit |
|---|---|---|---|
| Red | `tdd-red` écrit des tests | seuls des `*.test.ts` ont changé et la suite échoue | `test(...)` |
| Green | `tdd-green` écrit le code minimal | aucun test modifié, suite et types verts | `feat(...)` |
| Refactor | `tdd-refactor` restructure, ou ne fait rien | aucun test modifié, suite et types verts | `refactor(...)` |

Un agent ne voit que les fichiers, pas le raisonnement du précédent, et c'est le script qui décide si la phase est commitée. L'historique git montre les cycles.

## Commandes

| Commande | Effet | Appelle l'API |
|---|---|---|
| `npm test` | portes et pipeline complet avec de faux modèles | non |
| `npm run typecheck` | types | non |
| `npm run pipeline -- --collect-only` | lit les vrais flux, liste les items nouveaux | non |
| `npm run pipeline -- --dry-run` | run complet, n'écrit rien, affiche la trace et l'édition | oui |
| `npm run pipeline` | run complet, écrit `content/`, `runs/`, `data/` | oui |
| `npm run evals` | faits piégés soumis au vrai vérificateur, écrit `evals/last.json` | oui |
| `npm run dev` / `npm run build` | site Astro (`site/dist`) | non |

`ANTHROPIC_API_KEY` doit être défini pour les commandes qui appellent l'API. `RUN_BUDGET_USD` plafonne un run (2 $ par défaut).

## Mise en ligne

- GitHub : secret `ANTHROPIC_API_KEY` ; `.github/workflows/daily.yml` lance le run et committe le résultat.
- Cloudflare Pages : commande de build `npm run build`, dossier de sortie `site/dist`.
