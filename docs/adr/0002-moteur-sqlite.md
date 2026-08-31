# ADR-0002 — `node:sqlite` plutôt qu'une extension native

**Statut** : Accepté · **Date** : 2026-08-30 · **Portée** : périphérie

## Contexte

Le Volume IV, 11.3 fait de SQLite le moteur par défaut. Deux implémentations
étaient possibles en Node.js : `better-sqlite3` (extension native, à compiler ou
à télécharger sous forme de binaire précompilé) et `node:sqlite`, intégré à Node
depuis la version 22.5.

## Décision

Le pilote par défaut repose sur `node:sqlite`, derrière l'interface `SqlDriver`
du Volume IV, 11.1.

## Justification

Le Volume I impose de fonctionner « sans Docker obligatoire, sans API Cloud »,
sur Linux, Windows et macOS. Une extension native ajoute une chaîne de
compilation C sur le poste de l'exploitant, ou une dépendance à des binaires
précompilés pour chaque couple (version de Node, architecture) — sur quinze ans,
c'est une source d'immobilisation certaine.

Le nombre de dépendances de production du Framework reste ainsi à **zéro**.

## Conséquences

- Node 22 exige le drapeau `--experimental-sqlite` au lancement ; il disparaît en
  Node 24, où le module est stable.
- L'API est synchrone ; le contrat `SqlDriver` reste asynchrone pour préserver la
  portabilité vers PostgreSQL, où elle ne peut pas l'être.
- Un pilote `better-sqlite3` reste implémentable sans toucher au domaine, ce qui
  est précisément la propriété que l'interface existe pour garantir.
