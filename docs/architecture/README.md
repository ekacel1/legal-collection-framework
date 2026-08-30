# Legal Collection Framework — Software Architecture Specification

Série complète, 9 volumes. Les sources markdown des Volumes III à IX sont dans `src/` et permettent de les régénérer.

| Vol. | Titre | Fichier |
|---|---|---|
| I | Vision, Product Definition, Core Architecture | `LCF_Volume_I_Software_Architecture_Specification.docx` |
| II | Kernel Architecture | `LCF_Volume_II_Kernel_Architecture.docx` |
| III | Plugin Contracts & Public API | `LCF_Volume_III_Plugin_Contracts_and_Public_API.docx` |
| IV | Data Model, Storage & Versioning | `LCF_Volume_IV_Data_Model_Storage_and_Versioning.docx` |
| V | Processing Pipeline & Extraction Layer | `LCF_Volume_V_Processing_Pipeline_and_Extraction.docx` |
| VI | Security, Compliance & Trust Chain | `LCF_Volume_VI_Security_Compliance_and_Trust_Chain.docx` |
| VII | Observability, Operations & Deployment | `LCF_Volume_VII_Observability_Operations_and_Deployment.docx` |
| VIII | Testing Strategy & Quality Assurance | `LCF_Volume_VIII_Testing_Strategy_and_QA.docx` |
| IX | Governance, Roadmap & Decision Records | `LCF_Volume_IX_Governance_Roadmap_and_ADR.docx` |

## Contenu transversal

- **53 critères d'acceptation** (AC-3.1 → AC-9.6), format Given/When/Then, directement traduisibles en tests.
- **36 ADR** (301 → 904), registre consolidé en Volume IX, chapitre 5.
- **11 invariants** nommés (I-1 → I-7 stockage, R-1 → R-4 pipeline), index en Volume IX, annexe B.
- Glossaire en Volume IX, annexe C.

## Régénération

Les sources markdown sont dans `src/`. Pour reconstruire un volume :

```
python src/build_docx.py src/vol4.md "LCF_Volume_IV_Data_Model_Storage_and_Versioning.docx"
```

Dépendance : `python-docx` (`pip install python-docx`).

Le générateur applique une charte unique à tous les volumes : page de garde, titres hiérarchisés,
blocs de code monospacés sur fond gris, encadrés de note, tableaux à en-tête coloré, pied de page.

Balises supportées dans les sources : `@TITLE/@SUBTITLE/@VOLUME/@VERSION`, `#`..`####`,
blocs de code délimités par triples accents graves, `>` pour les encadrés, `-`/`1.` pour les listes,
`|a|b|` pour les tableaux, `---` pour un saut de page, `**gras**` et code inline entre accents graves.
