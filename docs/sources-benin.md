# Sources documentaires — Bénin

> Ce document est de la **documentation d'exploitation**, pas du code du noyau.
> La règle absolue du Volume I, chapitre 9 reste entière : le noyau ne contient
> aucune URL, aucune source. Tout ce qui figure ici se matérialise en plugins,
> hors du noyau.

État au 30 août 2026. Structures vérifiées en ligne, sauf mention contraire.

---

## Ordre de priorité

| Rang | Source | Pourquoi ce rang |
|---|---|---|
| **1** | **SGG — Secrétariat Général du Gouvernement** | Dépôt officiel du gouvernement, ~35 000 documents, structure paginée régulière, `robots.txt` entièrement permissif. C'est la source la plus large et la plus mécanisable. |
| 2 | Journal Officiel | Publication de référence, valeur juridique de la publication elle-même. Structure à évaluer. |
| 3 | LEGIS / CDIJ | Corpus législatif consolidé 1960→, complémentaire du SGG sur l'historique ancien. |
| 4 | Cour constitutionnelle | Jurisprudence constitutionnelle — corpus distinct, forte valeur. |
| 5 | Cour suprême | Jurisprudence administrative, judiciaire et des comptes. |
| 6 | Assemblée nationale | Travaux parlementaires, lois votées avant promulgation. |

---

## 1. SGG — Secrétariat Général du Gouvernement — **source principale**

- Racine : `https://sgg.gouv.bj`
- `robots.txt` : `User-agent: *` / `Disallow:` — **aucune restriction** (vérifié)
- Volume annoncé : **35 008 documents** toutes catégories

### Catégories

| Catégorie | Chemin |
|---|---|
| Lois promulguées | `/documentheque/lois/` — 1 622 documents |
| Décrets | `/documentheque/decrets/` |
| Ordonnances | `/documentheque/ordonnances/` |
| Arrêtés présidentiels | `/documentheque/arretes/` |
| Accords | `/documentheque/accords/` |
| Décisions | `/documentheque/decisions/` |
| Comptes rendus du Conseil des ministres | `/comptes-rendus-conseils-ministres/` |

### Structure — archétype A, index paginé

```
/documentheque/lois/           page 1
/documentheque/lois/2/         page 2, puis /3/, /4/ ...
   -> entrée : numéro, date, taille, titre, boutons Lire / Télécharger
   -> page de détail :  /doc/loi-2026-14/
   -> contenu binaire :  /doc/loi-2026-14/download
```

Exemple réel vérifié : *« Loi N° 2026-14 du 14 juillet 2026 »* → `/doc/loi-2026-14/`
→ téléchargement `/doc/loi-2026-14/download`.

### Ce qui en fait une bonne première source

- Pagination par chemin, régulière et prévisible.
- Le slug de la page de détail (`loi-2026-14`) est un **identifiant naturellement
  stable** : il ne contient ni numéro de page, ni horodatage, ni jeton de session.
- Séparation nette entre page de détail et contenu binaire — exactement la forme
  que le contrat `resolve()` attend.

### Points de vigilance

- Le type et la taille du fichier ne sont pas exposés sur la page de détail :
  il faudra vérifier la signature du fichier à la réception (le Download Manager
  le fait déjà).
- 35 000 documents à 1 200 ms de politesse ≈ **12 heures** pour un balayage
  complet. Prévoir un premier passage limité, puis un balayage nocturne.
- **Aucun `ETag`, aucun `Last-Modified`** sur les téléchargements (vérifié sur
  19 documents collectés). Les niveaux N1 et N2 de détection de changement
  (Vol. IV, 6.2) sont donc inopérants : seule la comparaison d'empreinte permet
  de savoir si un texte a changé, et elle exige de retélécharger le fichier.
  C'est ce qui rend l'arrêt anticipé de la collecte incrémentale décisif, et ce
  qui motive le point B7 de la checklist.
- Les documents vont de 90 Ko à **37 Mo**. Le plus gros a échoué trois fois sur
  le délai de transfert : voir le point B6.

---

## 2. Journal Officiel

- Racine : `https://journalofficiel.gouv.bj`
- **Structure non évaluée** : la page n'a pas pu être analysée automatiquement,
  ce qui laisse penser à un rendu JavaScript. À inspecter manuellement avant de
  décider entre archétype A et archétype D (navigateur).
- Intérêt : la publication au Journal Officiel est ce qui donne sa force
  exécutoire à un texte. La date de publication y fait foi.

## 3. LEGIS / CDIJ

- Racine : `https://legis.cdij.bj`
- Corpus annoncé : plus de 1 000 lois de 1960 à 2018, versions numériques jointes.
- Intérêt : **profondeur historique**, là où le SGG couvre surtout la période
  récente. Complémentaire, pas redondant.

## 4. Cour constitutionnelle

- Jurisprudence constitutionnelle (décisions DCC).
- Site institutionnel refondu récemment ; structure à vérifier.
- Corpus de nature différente : décisions, pas textes normatifs.

## 5. Cour suprême

- Racine : `https://www.coursupreme.bj`
- Trois chambres (administrative, judiciaire, comptes) — corpus jurisprudentiel.

## 6. Assemblée nationale

- Travaux parlementaires, propositions et projets de loi, comptes rendus.
- Intérêt : l'amont du processus législatif, absent des autres sources.

---

## Règles de collecte communes

Elles s'appliquent quelle que soit la source, et sont déjà appliquées par le
Kernel — aucun plugin n'a à les réimplémenter (Vol. VI, chapitre 7) :

- `robots.txt` respecté, décision journalisée ;
- délai de politesse d'au moins 1 200 ms entre deux requêtes vers le même hôte ;
- deux requêtes simultanées au maximum par hôte ;
- en-tête `User-Agent` identifiant avec adresse de contact réelle ;
- collecte de nuit de préférence, hors heures ouvrables de l'administration.

> Un collecteur anonyme et impoli finit toujours par être bloqué. L'adresse de
> contact permet à l'administrateur d'un site de signaler un problème plutôt que
> de bannir une plage d'adresses.

---

## Sources de cette page

- [Secrétariat général du Gouvernement du Bénin](https://sgg.gouv.bj/)
- [Lois promulguées — SGG](https://sgg.gouv.bj/documentheque/lois/)
- [Journal Officiel du Bénin](https://journalofficiel.gouv.bj/)
- [Cour suprême du Bénin](https://www.coursupreme.bj/)
- [Les textes de loi en République du Bénin accessibles en ligne — PNUD](https://www.undp.org/fr/benin/communiques/les-textes-de-loi-en-republique-du-benin-accessibles-en-ligne)
