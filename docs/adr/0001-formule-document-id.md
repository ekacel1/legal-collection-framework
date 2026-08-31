# ADR-0001 — Formule de `document_id` : séparateur 0x1F

**Statut** : Proposé · **Date** : 2026-08-30 · **Portée** : noyau (Vol. IX, 1.2)

## Contexte

Deux volumes de la spécification donnent deux formules différentes pour la même
identité :

| Volume | Formule |
|---|---|
| III, 3.2 | `sha256(sourceId + " " + nativeId)` |
| IV, 2.3 | `sha256(source_id ‖ 0x1F ‖ native_id)` |

La formule de `document_id` appartient au noyau au sens du Volume IX, 1.2 : elle
ne peut pas exister en deux exemplaires. Une divergence entre deux
implémentations produirait deux corpus dont les identités ne se recoupent pas,
et la divergence ne lèverait aucune erreur — elle produirait des doublons.

## Décision

La formule retenue est celle du **Volume IV** :

```
document_id = sha256( source_id ‖ 0x1F ‖ native_id )
```

Le Volume III doit être corrigé pour s'y aligner.

## Justification

L'espace (`0x20`) est un caractère licite dans un `native_id`. Avec un espace
comme séparateur, `("ab c", "d")` et `("ab", "c d")` produisent le même
identifiant. Le séparateur `0x1F` (Unit Separator) est interdit dans un
`native_id` — le Kernel le refuse explicitement à la construction — ce qui rend
la collision structurellement impossible plutôt qu'improbable.

Le Volume IV justifie par ailleurs ce choix en toutes lettres, alors que le
Volume III ne motive pas le sien : entre deux textes contradictoires, celui qui
argumente l'emporte.

## Conséquences

- Toute implémentation du Framework doit rejeter un `native_id` contenant `0x1F`.
- Un corpus construit avec la formule du Volume III ne serait pas ré-identifiable
  sans recalcul complet ; aucun corpus de ce type n'existe à ce jour.
- Le Volume III, 3.2 doit être corrigé avant publication de la version 1.0.

## Objections consignées

Aucune objection à ce jour. La décision est prise en l'absence de mainteneurs
supplémentaires ; elle devra être confirmée dès que le projet en comptera trois
(Vol. IX, 1.3).
