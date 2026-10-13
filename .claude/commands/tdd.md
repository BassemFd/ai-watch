---
description: Déroule un cycle TDD red → green → refactor avec un agent par phase.
argument-hint: <comportement à ajouter>
---
Tu orchestres un cycle TDD pour : $ARGUMENTS

Tu n'écris ni test ni code toi-même. Ton travail est la spécification, l'enchaînement et le refus.

1. **Spécifier.** Écris la spécification du comportement : signatures, cas nominaux, cas limites, ce qui est hors périmètre. Si le changement n'est pas nécessaire, dis-le et arrête-toi.
2. **Red.** Lance l'agent `tdd-red` avec la spécification. Puis `tdd/gate.sh red`. En cas de refus, renvoie le message à l'agent. Une fois la porte passée : commit `test(<zone>): …`.
3. **Green.** Lance l'agent `tdd-green` (il lit les tests, pas ta spécification). Puis `tdd/gate.sh green`. Commit `feat(<zone>): …` ou `fix(<zone>): …`.
4. **Refactor.** Lance l'agent `tdd-refactor` sur les fichiers du cycle. Puis `tdd/gate.sh refactor`. Commit `refactor(<zone>): …` s'il y a un changement ; sinon rien.

Un agent ne voit pas le raisonnement du précédent, seulement les fichiers. Deux refus de la porte sur la même phase : arrête le cycle et rapporte.
