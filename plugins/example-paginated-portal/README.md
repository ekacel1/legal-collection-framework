# Archétype A — portail d'index paginé

Plugin **modèle**, publié hors du noyau. Il ne vise aucune institution réelle :
`portal.example` n'existe pas (Volume I, chapitre 9).

Il sert trois usages :

1. référence d'implémentation pour un auteur de plugin ;
2. sujet des tests d'acceptation du Palier 0 ;
3. démonstration que le contrat à quatre méthodes suffit.

## Ce qu'il illustre

| Obligation | Où |
|---|---|
| `nativeId` stable, dérivé du chemin | `stableId()` |
| Le plugin ne télécharge pas | `resolve()` retourne un `FetchPlan` |
| Provenance de chaque métadonnée | `describe()` |
| Échec bruyant sur changement de structure | `parsePage()` → `SourceStructureChanged` |
| Découverte incrémentale optionnelle | `checkpoint()` / `restore()` |
