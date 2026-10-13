#!/usr/bin/env bash
# Usage : tdd/gate.sh red|green|refactor
# Décide si une phase TDD peut être commitée. Les agents proposent, ce script tranche.
#   red      : seuls des fichiers *.test.ts ont changé, et la suite échoue.
#   green    : aucun fichier de test n'a changé, la suite et les types passent.
#   refactor : comme green.
set -u
phase=${1:?phase manquante : red, green ou refactor}
changed=$(git status --porcelain -uall | awk '{print $NF}')
tests_changed=$(echo "$changed" | grep -E '\.test\.ts$' || true)
other_changed=$(echo "$changed" | grep -vE '\.test\.ts$' || true)
fail() { echo "PORTE $phase : REFUS — $1"; exit 1; }

npm test >/dev/null 2>&1
suite=$?

case "$phase" in
  red)
    [ -n "$tests_changed" ] || fail "aucun test écrit"
    [ -z "$other_changed" ] || fail "fichiers hors tests modifiés : $(echo $other_changed)"
    [ $suite -ne 0 ] || fail "la suite passe déjà : le test ne prouve rien"
    ;;
  green|refactor)
    [ -z "$tests_changed" ] || fail "tests modifiés : $(echo $tests_changed)"
    [ $suite -eq 0 ] || fail "la suite échoue"
    npm run -s typecheck >/dev/null 2>&1 || fail "les types ne passent pas"
    ;;
  *) fail "phase inconnue" ;;
esac
echo "PORTE $phase : OK"
