@TITLE: Legal Collection Framework
@SUBTITLE: Software Architecture Specification
@VOLUME: VOLUME VI — Security, Compliance & Trust Chain
@VERSION: 0.6 (Draft)

# Préambule du Volume VI

Un collecteur documentaire présente un profil de risque singulier. Il ingère en continu des données arbitraires provenant de serveurs qu'il ne contrôle pas, il exécute du code de plugins écrits par des tiers, et il constitue un corpus dont la valeur repose entièrement sur la confiance qu'on peut lui accorder.

Trois surfaces de risque, trois natures différentes :

| Surface | Risque | Réponse architecturale |
|---|---|---|
| Contenu entrant | Charge malveillante, épuisement de ressources | Traitement défensif, isolement |
| Code de plugin | Exécution non maîtrisée, exfiltration | Capacités, bac à sable, signature |
| Corpus produit | Altération indétectable, contestation | Chaîne de confiance vérifiable |

> Une remarque de méthode avant d'entrer dans le détail. Ce volume est un document d'architecture technique. Les sections relatives aux aspects juridiques décrivent les **mécanismes que le système doit fournir** pour se conformer à des exigences légales ; elles ne constituent pas un avis juridique et ne dispensent pas d'une analyse par un juriste compétent pour chaque juridiction de déploiement.

---

# Chapitre 1 — Modèle de menaces

## 1.1 Frontières de confiance

```
   +====================================================================+
   |                     ZONE NON FIABLE (Internet)                     |
   |   Serveurs sources - contenu arbitraire - reponses hostiles        |
   +====================================================================+
              |  HTTP/HTTPS  -- FRONTIERE 1 --
              v
   +--------------------------------------------------------------------+
   |  ZONE SEMI-FIABLE : plugins + Download Manager                     |
   |  Code tiers, contenu non valide, capacites restreintes             |
   +--------------------------------------------------------------------+
              |  FetchPlan / DocumentRef  -- FRONTIERE 2 --
              v
   +--------------------------------------------------------------------+
   |  ZONE FIABLE : Kernel, Storage, Integrity                          |
   |  Code audite, invariants imposes                                   |
   +--------------------------------------------------------------------+
              |  Content Store en lecture seule  -- FRONTIERE 3 --
              v
   +--------------------------------------------------------------------+
   |  ZONE DE TRAITEMENT : pipeline, extracteurs, OCR                   |
   |  Traite des octets hostiles, isole du corpus                       |
   +--------------------------------------------------------------------+
              |  API en lecture seule  -- FRONTIERE 4 --
              v
   +--------------------------------------------------------------------+
   |  CONSOMMATEURS : recherche, IA, exports                            |
   +--------------------------------------------------------------------+
```

Chaque frontière impose une validation. Une donnée qui franchit une frontière sans être validée annule l'intérêt de la frontière.

## 1.2 Analyse STRIDE

| Catégorie | Menace concrète | Contre-mesure | Vol. |
|---|---|---|---|
| **S**poofing | Une source usurpée sert du faux contenu | TLS obligatoire, épinglage optionnel, URL canonique enregistrée | VI-2 |
| **T**ampering | Altération d'un fichier du magasin | Adressage par contenu, vérification périodique, journal en ajout seul | IV-7 |
| **R**epudiation | « Ce document n'a jamais été publié ainsi » | Journal d'audit inaltérable, horodatage, provenance complète | VI-8 |
| **I**nformation disclosure | Fuite de secrets par les journaux | Masquage systématique, secrets jamais sérialisés | VI-4 |
| **D**enial of service | Bombe de décompression, PDF pathologique | Plafonds durs, délais, isolement mémoire | VI-3 |
| **E**levation of privilege | Un plugin s'échappe de son bac à sable | Modèle de capacités, isolement L1–L3, signature | III-5 |

## 1.3 Ce qui est explicitement hors périmètre

Un modèle de menaces honnête énonce ce qu'il ne couvre pas.

- La compromission de l'hôte lui-même (le système d'exploitation est supposé sain).
- Un adversaire disposant d'un accès physique aux disques.
- Un attaquant étatique interceptant et modifiant le trafic TLS avec des certificats valides.
- La malveillance d'un opérateur disposant légitimement des droits d'administration.

Pour ces scénarios, le Framework fournit de la **détection** — la vérification d'intégrité révélera l'altération — mais pas de la prévention.

---

# Chapitre 2 — Sécurité du réseau

## 2.1 Politique TLS

| Règle | Valeur | Dérogation |
|---|---|---|
| TLS obligatoire | Oui | Autorisation explicite par source, journalisée à chaque requête |
| Version minimale | TLS 1.2 | Aucune |
| Vérification du certificat | Toujours | Aucune, sans exception |
| Épinglage de certificat | Optionnel, par source | Recommandé pour les sources critiques |
| Redirections | Maximum 5 sauts | Jamais de HTTPS vers HTTP |

La dérogation HTTP existe parce que certains portails officiels ne servent encore qu'en clair, et qu'un refus catégorique reviendrait à ne pas collecter le document. Le compromis retenu : la collecte est possible, mais chaque document ainsi obtenu porte une marque `insecure_transport` dans ses métadonnées de provenance — l'information est conservée avec sa réserve, plutôt que perdue ou blanchie.

## 2.2 Prévention de la falsification de requête côté serveur

Un `FetchPlan` contient une URL fournie par un plugin, elle-même souvent dérivée du contenu d'une page distante. C'est un vecteur direct de SSRF.

```
export function validateFetchTarget(url: string, caps: NetworkCapability): void {
  const u = new URL(url);

  if (!["http:", "https:"].includes(u.protocol))
    throw new PolicyViolation("protocole interdit", u.protocol);

  if (!caps.allowedHosts.includes(u.hostname))
    throw new CapabilityViolation("network.host", u.hostname);

  // Resolution DNS puis controle des adresses : bloque le rebinding
  const addresses = resolveAll(u.hostname);
  for (const addr of addresses) {
    if (isPrivate(addr) || isLoopback(addr) || isLinkLocal(addr) ||
        isMulticast(addr) || isCloudMetadata(addr))
      throw new PolicyViolation("adresse interne interdite", addr);
  }

  // La connexion utilise l'adresse validee, pas une nouvelle resolution
  return connectTo(addresses[0], u);
}
```

Le dernier commentaire est le point décisif. Valider le nom d'hôte puis laisser le client HTTP résoudre à nouveau ouvre une fenêtre de *DNS rebinding* : la seconde résolution peut renvoyer `169.254.169.254`. La connexion doit donc utiliser l'adresse déjà validée.

Plages systématiquement refusées : `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, ainsi que les points d'accès de métadonnées des principaux fournisseurs d'infrastructure.

## 2.3 Bornes de requête

| Contrôle | Défaut | Motif |
|---|---|---|
| Délai de connexion | 10 s | |
| Délai total de requête | 300 s | Certains PDF officiels sont volumineux |
| Taille maximale de réponse | 200 Mio | Configurable par source |
| Débit minimal | 1 Kio/s sur 60 s | Contre l'attaque par ralentissement délibéré |
| En-têtes maximum | 100, 8 Kio au total | |

Le contrôle de débit minimal est important : un serveur hostile qui envoie un octet toutes les trente secondes immobiliserait indéfiniment un travailleur sans jamais déclencher un délai d'inactivité classique.

---

# Chapitre 3 — Traitement défensif du contenu

## 3.1 Principe

Tout octet entrant est hostile jusqu'à preuve du contraire. Le Framework ne fait aucune hypothèse sur la bienveillance d'une source, y compris officielle : une source légitime peut avoir été compromise, ou servir un fichier corrompu sans malveillance.

## 3.2 Archives

| Menace | Contre-mesure |
|---|---|
| Bombe de décompression | Ratio maximal 100:1, taille décompressée plafonnée à 1 Gio |
| Zip-slip (`../../etc/passwd`) | Normalisation du chemin, rejet de tout `..` et de tout chemin absolu |
| Imbrication profonde | Profondeur maximale 1 : aucune archive dans une archive |
| Bombe par nombre d'entrées | Maximum 10 000 membres |
| Liens symboliques | Ignorés systématiquement |

```
function safeExtractMember(archive: ArchiveHandle, member: string): Buffer {
  const norm = path.normalize(member);
  if (norm.startsWith("..") || path.isAbsolute(norm))
    throw new SecurityViolation("chemin d'archive invalide", member);

  const entry = archive.entry(norm);
  if (entry.uncompressedSize > MAX_MEMBER_BYTES)
    throw new SecurityViolation("membre trop volumineux", norm);
  if (entry.uncompressedSize / Math.max(entry.compressedSize, 1) > MAX_RATIO)
    throw new SecurityViolation("ratio de compression suspect", norm);

  return archive.readWithLimit(norm, MAX_MEMBER_BYTES);   // plafond a la lecture
}
```

Le plafond est appliqué à la lecture et non seulement d'après l'en-tête déclaré : une archive malveillante annonce une petite taille et en délivre une énorme.

## 3.3 XML

```
Configuration obligatoire de tout analyseur XML du Framework :

  resolution des entites externes ...... DESACTIVEE
  chargement de DTD .................... DESACTIVE
  expansion des entites ................ DESACTIVEE
  XInclude ............................. DESACTIVE
  profondeur maximale .................. 100
  taille maximale ...................... 50 Mio
```

Ces réglages neutralisent XXE et l'expansion exponentielle d'entités (*billion laughs*). Ils sont vérifiés par un test de sécurité automatisé exécuté à chaque intégration continue, plutôt que laissés à la vigilance individuelle.

## 3.4 PDF

Le PDF est un format exécutable déguisé en format documentaire.

| Menace | Contre-mesure |
|---|---|
| JavaScript embarqué | Jamais exécuté ; l'extracteur n'a pas de moteur de script |
| Fichiers embarqués | Non extraits par défaut ; traités comme documents distincts si autorisé |
| Références récursives | Détection de cycles, profondeur plafonnée |
| Explosion de rendu | Délai par page, plafond mémoire, processus isolé |
| Chiffrement | Aucune tentative de contournement ; échec déterministe déclaré |

L'extraction PDF s'exécute dans un processus séparé, avec plafond mémoire et délai durs. Un PDF pathologique fait tomber ce processus, pas le pipeline.

## 3.5 Chemins et noms de fichiers

Le Content Store étant adressé par empreinte, aucun nom fourni par une source n'atteint jamais le système de fichiers. C'est une propriété de sécurité, pas seulement de conception : toute une classe de vulnérabilités de traversée de répertoire est structurellement éliminée.

Les noms d'origine sont conservés comme **métadonnées**, jamais comme chemins.

---

# Chapitre 4 — Gestion des secrets

## 4.1 Règles

| # | Règle |
|---|---|
| 1 | Aucun secret dans un manifeste, une configuration versionnée ou un dépôt de code |
| 2 | Un secret n'est jamais journalisé, même en niveau de trace |
| 3 | Un secret n'est jamais sérialisé dans un événement, une trace ou un rapport d'erreur |
| 4 | Un plugin n'accède qu'aux secrets qu'il a déclarés dans son manifeste |
| 5 | La résolution est paresseuse : un secret non utilisé n'est jamais lu |

## 4.2 Fournisseurs

```
export interface SecretProvider {
  readonly name: string;
  get(key: string): Promise<SecretValue | null>;
}
```

| Fournisseur | Usage | Remarque |
|---|---|---|
| Variables d'environnement | Défaut | Simple ; visible dans la table des processus |
| Fichier chiffré | Poste isolé | Clé maître fournie au démarrage |
| Gestionnaire du système | Poste de développement | Trousseau du système d'exploitation |
| Coffre externe | Production | Rotation, audit, révocation |

## 4.3 Le type SecretValue

Un secret n'est pas une chaîne de caractères. C'est un type dédié dont la conversion en texte est piégée.

```
export class SecretValue {
  #value: string;

  /** Seul point d'usage legitime. */
  use<T>(fn: (plain: string) => T): T { return fn(this.#value); }

  toString(): string   { return "[REDACTED]"; }
  toJSON(): string     { return "[REDACTED]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "[REDACTED]"; }
}
```

Cette conception rend la fuite accidentelle très difficile : une interpolation dans un message de journal, une sérialisation JSON, un affichage de débogage produisent tous `[REDACTED]`. Le secret ne s'obtient qu'en appelant explicitement `use()`, ce qui est visible en revue de code et détectable par analyse statique.

## 4.4 Filtrage de sortie

En complément, un filtre s'applique à tout ce qui sort du système — journaux, messages d'erreur, traces :

```
const PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,                     // jetons opaques
  /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /https?:\/\/[^:]+:[^@]+@/g,                    // identifiants dans une URL
];
```

Défense en profondeur assumée : le typage empêche la fuite par conception, le filtre rattrape ce qui aurait échappé au typage.

---

# Chapitre 5 — Chaîne d'approvisionnement

## 5.1 Le risque

Un plugin est du code arbitraire s'exécutant avec les droits du Framework. C'est le vecteur d'attaque le plus direct du système.

## 5.2 Niveaux de confiance

| Niveau | Origine | Exigences | Isolement |
|---|---|---|---|
| T0 — Interne | Développé et audité par l'équipe | Revue de code | L1 |
| T1 — Vérifié | Tiers, audité, signé | Signature + rapport de conformité | L1 ou L2 |
| T2 — Communautaire | Registre public | Signature + conformité + isolement | L2 |
| T3 — Inconnu | Source arbitraire | Refusé par défaut | L3 si forcé |

Le niveau exigé est une décision d'exploitation :

```
plugins:
  minimumTrustLevel: T1
  requireSignature: true
  requireConformanceReport: true
  isolation: worker            # L2
  allowUnsignedInDevelopment: true
```

## 5.3 Signature de paquet

```
mon-plugin.lcfp
  ├── lcf-plugin.json
  ├── dist/
  ├── conformance-report.json
  └── SIGNATURE
        algorithm : ed25519
        publicKey : <cle publique du signataire>
        signature : <signature de sha256 du contenu du paquet>
        signedAt  : 2026-08-01T12:00:00Z
```

Vérification au chargement : recalcul de l'empreinte du paquet, vérification de la signature, contrôle de la clé publique contre le magasin de confiance configuré. Un échec produit un `PluginRejected` avant toute évaluation de code.

## 5.4 Dépendances

| Contrôle | Application |
|---|---|
| Fichier de verrouillage obligatoire | Aucune installation sans versions figées |
| Analyse de vulnérabilités | En intégration continue, blocage sur sévérité élevée |
| Nomenclature logicielle (SBOM) | Générée à chaque publication, format CycloneDX |
| Budget de dépendances du noyau | Objectif : moins de 20 dépendances directes |
| Aucun script d'installation | `--ignore-scripts` imposé |

Le budget de dépendances du noyau est une décision d'architecture à part entière : sur quinze ans, chaque dépendance est un engagement de maintenance et une surface d'attaque. Le noyau privilégie la bibliothèque standard, même au prix de davantage de code écrit.

---

# Chapitre 6 — Contrôle d'accès

## 6.1 Modèle

Le Framework ne gère pas d'utilisateurs. Il gère des **jetons** portant des portées. L'authentification des personnes, quand elle est nécessaire, relève d'un mandataire en amont.

```
export type Scope =
  | "sources:read"   | "sources:write"
  | "runs:read"      | "runs:trigger"
  | "documents:read" | "documents:content"
  | "events:subscribe"
  | "admin";
```

| Rôle type | Portées | Usage |
|---|---|---|
| Lecteur | `documents:read`, `sources:read` | Interface de consultation |
| Consommateur | + `documents:content`, `events:subscribe` | Pipeline aval, indexation |
| Opérateur | + `runs:trigger`, `runs:read` | Exploitation |
| Administrateur | `admin` | Configuration, purge |

## 6.2 Règles imposées

- L'API HTTP est **par défaut liée à `127.0.0.1`**. L'exposer publiquement est une action délibérée de configuration.
- Aucune écriture sur le corpus par l'API, quelle que soit la portée : le corpus n'est modifiable que par une collecte.
- La portée `admin` ne peut pas être accordée à un jeton à longue durée de vie ; durée maximale : 24 heures.
- Toute opération destructive (`purge`, `prune`, `gc --confirm`) est refusée via HTTP, et n'existe qu'en ligne de commande, sur la machine hôte.

> Ce dernier point est une contrainte volontairement inconfortable. Une opération irréversible ne doit pas être accessible à distance derrière un jeton qui peut fuir. Le coût — devoir se connecter à la machine — est exactement la friction souhaitée.

---

# Chapitre 7 — Collecte responsable

## 7.1 Position

Le Framework est conçu pour collecter des documents publics auprès de sources officielles. Sa conception doit rendre le comportement respectueux plus simple que le comportement agressif.

## 7.2 Mesures imposées par défaut

| Mesure | Défaut | Modifiable |
|---|---|---|
| Respect de `robots.txt` | Activé | Par source, décision journalisée |
| Délai de politesse | 1 000 ms entre requêtes vers un même hôte | Oui, plancher 100 ms |
| Requêtes simultanées par hôte | 2 | Oui, plafond 10 |
| En-tête `User-Agent` identifiant | Obligatoire | Contenu configurable, présence non |
| Adresse de contact | Obligatoire en configuration | Non |
| Respect de `Retry-After` | Toujours | Non |
| Repli exponentiel sur 429/503 | Toujours | Non |

```
User-Agent: LCF/1.0 (Legal Collection Framework; +https://exemple.org/lcf; contact@exemple.org)
```

L'obligation d'une adresse de contact n'est pas cosmétique : elle permet à l'administrateur d'une source de signaler un problème plutôt que de bloquer aveuglément une plage d'adresses. Un collecteur anonyme finit toujours par être bloqué.

## 7.3 Fenêtres de collecte

```
schedule:
  defaultCron: "0 3 * * *"
  timezone: "UTC"
  blackoutWindows:
    - { days: ["mon-fri"], from: "08:00", to: "18:00", tz: "local" }
```

Les fenêtres d'exclusion permettent d'éviter les heures ouvrables de la source, période où la charge sur ses serveurs importe le plus.

## 7.4 Ce que le Framework ne fera pas

Ces exclusions sont des décisions d'architecture, pas des options manquantes :

- aucun contournement de CAPTCHA ;
- aucune rotation d'identité destinée à échapper à une limitation ;
- aucun contournement d'authentification ou de paywall ;
- aucune usurpation d'agent utilisateur visant à dissimuler la nature du collecteur ;
- aucune collecte distribuée destinée à masquer un volume de requêtes.

Un système capable de collecter agressivement finit par être utilisé agressivement. L'absence de ces capacités est la garantie.

---

# Chapitre 8 — Chaîne de confiance et preuve

## 8.1 Le problème

Un corpus documentaire n'a de valeur que si l'on peut établir, des années plus tard, que le document conservé est bien celui qui a été publié, et qu'il n'a pas été altéré depuis.

## 8.2 Éléments de la chaîne

```
   Publication par la source
        |
        v
   Collecte  -> horodatage, URL, en-tetes HTTP, empreinte du contenu
        |
        v
   Stockage  -> adressage par contenu, descripteur auto-portant
        |
        v
   Journal d'audit en ajout seul  -> chainage cryptographique
        |
        v
   Horodatage externe (optionnel)  -> ancrage temporel independant
        |
        v
   Verification a la demande, a tout moment
```

## 8.3 Journal en ajout seul

```
CREATE TABLE audit_log (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at    TEXT NOT NULL,
  actor          TEXT NOT NULL,      -- 'system' | 'run:<id>' | 'user:<id>'
  action         TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  details_json   TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,      -- empreinte de l'entree precedente
  entry_hash     TEXT NOT NULL       -- sha256 de cette entree + prev_hash
);
```

```
entry_hash = sha256( seq ‖ occurred_at ‖ actor ‖ action ‖
                     subject_type ‖ subject_id ‖ details_json ‖ prev_hash )
```

Le chaînage rend toute modification rétroactive détectable : altérer une entrée invalide toutes les empreintes suivantes. Un attaquant devrait recalculer l'intégralité de la chaîne — et si la chaîne est ancrée périodiquement à l'extérieur (8.4), même cela ne suffit pas.

```
lcf audit verify

Entrees        : 4 291 887
Chaine         : intacte de seq=1 a seq=4291887
Ancres         : 412 (derniere : 2026-08-30T00:00:00Z)
Anomalies      : aucune
```

## 8.4 Ancrage externe

Optionnel, activé pour les déploiements où la valeur probante importe. À intervalle régulier, l'empreinte de tête du journal est publiée dans un support indépendant : autorité d'horodatage RFC 3161, dépôt public, ou tout registre inaltérable.

L'effet est net : à partir de l'instant de l'ancrage, il devient impossible de réécrire l'histoire du corpus sans que la divergence soit démontrable par un tiers.

## 8.5 Attestation de document

```
lcf attest --document 9f2c...ab71 --version 3

ATTESTATION DE COLLECTE
-----------------------------------------------------------------
Document      : 9f2c...ab71
Source        : xx.gazette.official
Identifiant   : 2024/118
Version       : 3 sur 3
Collecte le   : 2026-08-30T03:14:05.882Z
URL d'origine : https://gazette.example/acts/2024-118.pdf
Statut HTTP   : 200
ETag serveur  : "a1b2c3"
Empreinte     : sha256:6b1d4e0f8a2c...f31
Taille        : 482 911 octets
Type          : application/pdf

Verification a l'instant : 2027-04-11T09:02:33Z
  fichier present ......... oui
  empreinte recalculee .... identique
  entree d'audit .......... seq=1284991, chaine intacte
  ancre externe ........... 2026-08-30T00:00:00Z (RFC 3161)

VERDICT : contenu inchange depuis la collecte
-----------------------------------------------------------------
```

Ce que cette attestation établit : le fichier n'a pas changé depuis sa collecte, et la date de collecte est vérifiable. Ce qu'elle n'établit pas : que la source elle-même publiait un contenu authentique. Le Framework atteste de sa propre chaîne, pas de la véracité de la source — distinction qu'il serait malhonnête de laisser dans l'ombre.

---

# Chapitre 9 — Journalisation d'audit

## 9.1 Ce qui est journalisé

| Catégorie | Exemples |
|---|---|
| Cycle de vie des documents | Découverte, stockage, nouvelle version, échec, retrait |
| Opérations sur les sources | Ajout, modification de configuration, quarantaine, réactivation |
| Opérations sensibles | Purge, élagage, ramasse-miettes, migration, restauration |
| Sécurité | Violation de capacité, rejet de plugin, échec d'authentification |
| Intégrité | Anomalie détectée, réparation effectuée |
| Accès | Requêtes sur le contenu, quand l'audit d'accès est activé |

## 9.2 Ce qui n'est jamais journalisé

- Le contenu des secrets, sous quelque forme que ce soit.
- Le contenu intégral des documents (seules les empreintes le sont).
- Les données personnelles présentes dans les documents.
- Les adresses IP des consommateurs de l'API, sauf activation explicite.

## 9.3 Rétention

| Journal | Rétention | Motif |
|---|---|---|
| Journal d'audit | Illimitée | C'est la chaîne de confiance |
| Journal applicatif | 90 jours | Diagnostic |
| Journal d'accès | 30 jours | Minimisation |
| Journal de tentatives | 1 an | Analyse de fiabilité des sources |

---

# Chapitre 10 — Conformité et considérations juridiques

Cette section décrit les **fonctions techniques** que le Framework fournit pour permettre la conformité. Le paramétrage relève d'une analyse juridique propre à chaque déploiement.

## 10.1 Données personnelles

Un corpus juridique contient inévitablement des données personnelles : noms de parties, adresses, situations individuelles.

| Fonction fournie | Mécanisme | Volume |
|---|---|---|
| Localisation d'un document | Recherche par identifiant, source, contenu | III |
| Suppression tracée | `lcf purge --reason legal`, avec pierre tombale | IV-8 |
| Restriction d'accès | Marquage `restricted`, filtrage à l'API | VI-6 |
| Journal de traitement | Journal d'audit, provenance complète | VI-9 |
| Export d'un dossier | Export ciblé par document | IV-12 |
| Minimisation | Aucune donnée non nécessaire n'est collectée | I |

Point d'architecture important : le Framework ne collecte **que** ce que la source publie ; il n'enrichit pas, ne croise pas, ne profile pas. Cette absence délibérée de fonctions réduit considérablement la surface de conformité.

## 10.2 Droits sur les contenus

Le Framework est neutre quant au statut juridique des documents collectés. Il fournit les moyens d'appliquer une politique, il n'en décide pas.

| Fonction | Description |
|---|---|
| Champ de licence par source | Statut déclaré, propagé à tous les documents de la source |
| Conservation des mentions | Les métadonnées de la source sont conservées intégralement |
| Marquage de restriction de redistribution | Filtre les exports |
| Traçabilité de provenance | Chaque document conserve son URL et sa date d'origine |

## 10.3 Localisation et souveraineté

| Fonction | Description |
|---|---|
| Stockage entièrement local | Aucune dépendance à un service externe (contrainte du Volume I) |
| Aucune télémétrie sortante | Aucune donnée n'est émise vers l'extérieur par défaut |
| Chiffrement au repos | Délégué au système de fichiers ou au volume, sur décision d'exploitation |
| Portabilité complète | Export BagIt, aucun format propriétaire |

L'absence totale de télémétrie est une décision d'architecture. Un framework destiné à des administrations et à des institutions ne doit rien émettre vers l'extérieur que son opérateur n'ait explicitement configuré.

---

# Chapitre 11 — Réponse à incident

## 11.1 Classification

| Niveau | Définition | Délai de réaction |
|---|---|---|
| S1 | Corruption ou perte de corpus | Immédiat |
| S2 | Compromission d'un plugin ou d'un secret | 1 heure |
| S3 | Anomalie d'intégrité isolée | 24 heures |
| S4 | Panne de source, quarantaine | 72 heures |

## 11.2 Procédures

```
S1 — Corruption de corpus
  1. Arreter toute collecte           lcf stop --all
  2. Passer le magasin en lecture seule
  3. Determiner l'etendue             lcf verify --all --report
  4. Identifier l'origine             lcf audit query --since <date>
  5. Restaurer                        lcf restore --from <backup> --objects-only
  6. Verifier                         lcf verify --all
  7. Consigner l'incident dans le journal d'audit

S2 — Secret compromis
  1. Revoquer le secret aupres de son emetteur
  2. Faire tourner la valeur dans le coffre
  3. Redemarrer les sources concernees
  4. Chercher un usage anormal        lcf audit query --actor <plugin>
  5. Verifier l'absence de fuite dans les journaux conserves

S2 — Plugin compromis
  1. Desactiver                       lcf source disable <id>
  2. Mettre en quarantaine le paquet
  3. Auditer les documents collectes depuis la version suspecte
  4. Verifier les empreintes contre la source d'origine
  5. Revoquer la cle de signature si necessaire
```

## 11.3 Ce que le système garantit pendant un incident

- Le Content Store est immuable : une collecte compromise ajoute, elle ne réécrit pas.
- Le journal d'audit est chaîné : l'effacement de traces est détectable.
- Chaque document est rattaché à une exécution, à un plugin et à une version : le périmètre d'un incident est déterminable exactement.
- Rien n'est supprimé automatiquement : la matière de l'enquête est toujours présente.

---

# Chapitre 12 — Critères d'acceptation du Volume VI

## AC-6.1 — Protection SSRF

```
ETANT DONNE un plugin retournant un FetchPlan vers http://169.254.169.254/
QUAND le Download Manager le traite
ALORS la requete est refusee avant toute connexion
  ET aucun paquet n'est emis vers cette adresse
  ET l'incident est consigne dans le journal d'audit
```

## AC-6.2 — Bombe de décompression

```
ETANT DONNE une archive de 1 Mio se decompressant en 10 Gio
QUAND un plugin en demande un membre
ALORS l'extraction est interrompue au depassement du ratio
  ET la memoire utilisee reste bornee
  ET le processus ne tombe pas
```

## AC-6.3 — Non-fuite des secrets

```
ETANT DONNE un plugin configure avec un jeton secret
QUAND il declenche une erreur dont le message contient le jeton
ALORS le journal affiche [REDACTED]
  ET la trace d'exception ne contient pas la valeur
  ET l'evenement emis ne la contient pas
```

## AC-6.4 — Intégrité du journal d'audit

```
ETANT DONNE un journal d'audit de 100 000 entrees
QUAND une entree intermediaire est modifiee directement en base
ALORS `lcf audit verify` detecte la rupture de chaine
  ET nomme le numero de sequence de la premiere divergence
```

## AC-6.5 — Refus d'un plugin non signé

```
ETANT DONNE requireSignature = true
QUAND un plugin sans signature valide est presente
ALORS il est rejete au chargement
  ET aucune ligne de son code n'a ete evaluee
  ET le rejet figure au journal d'audit
```

## AC-6.6 — Respect de robots.txt

```
ETANT DONNE une source dont robots.txt interdit /prive/
QUAND un plugin tente de recuperer /prive/doc.pdf
ALORS la requete est refusee
  ET le refus est journalise avec la regle appliquee
```

## AC-6.7 — Opérations destructives hors réseau

```
ETANT DONNE un jeton de portee admin
QUAND une purge est demandee via l'API HTTP
ALORS la requete est refusee avec 405
  ET la reponse indique que l'operation n'existe qu'en ligne de commande
```

## AC-6.8 — Isolement du traitement

```
ETANT DONNE un PDF concu pour epuiser la memoire
QUAND le pipeline le traite
ALORS le processus d'extraction est termine au plafond memoire
  ET la tache passe en echec deterministe
  ET les autres travailleurs continuent
  ET aucune collecte n'est affectee
```

---

# Chapitre 13 — Décisions d'architecture du Volume VI

## ADR-601 — Refus par défaut sur toutes les frontières

**Statut** : Accepté · **Contexte** : Une liste de refus est toujours incomplète ; une liste d'autorisation est vérifiable.
**Décision** : Hôtes, capacités, portées et protocoles fonctionnent tous en liste blanche.
**Conséquences** : + Surface d'attaque bornée et énumérable. − Configuration plus verbeuse, friction assumée à l'ajout d'une source.

## ADR-602 — Secrets typés plutôt que chaînes

**Statut** : Accepté · **Contexte** : La quasi-totalité des fuites de secrets provient d'une journalisation accidentelle.
**Décision** : `SecretValue`, avec `toString`/`toJSON` piégés et accès explicite par `use()`.
**Conséquences** : + La fuite accidentelle devient très improbable. − Un peu plus verbeux à l'usage, ce qui est le but.

## ADR-603 — Journal d'audit chaîné cryptographiquement

**Statut** : Accepté · **Contexte** : Un corpus documentaire doit pouvoir prouver son intégrité, pas seulement l'affirmer.
**Décision** : Chaque entrée intègre l'empreinte de la précédente ; ancrage externe optionnel.
**Conséquences** : + Toute réécriture rétroactive est détectable. − Écritures strictement sérialisées, coût faible et mesuré.

## ADR-604 — Absence de capacités de contournement

**Statut** : Accepté · **Contexte** : Un outil capable de contourner CAPTCHA, authentification et limitation de débit sera utilisé pour cela.
**Décision** : Ces capacités ne sont pas implémentées, et ne le seront pas.
**Conséquences** : + Le Framework reste défendable auprès des sources et des institutions qui l'emploient. − Certaines sources restent hors de portée, ce qui est accepté.

## ADR-605 — API locale par défaut, opérations destructives hors réseau

**Statut** : Accepté · **Contexte** : Une API exposée par défaut est une API exposée par accident.
**Décision** : Liaison sur `127.0.0.1` par défaut ; purge, élagage et ramasse-miettes uniquement en ligne de commande locale.
**Conséquences** : + Aucune opération irréversible ne dépend d'un jeton qui pourrait fuir. − Exploitation à distance moins commode, friction délibérée.

---

# Synthèse du Volume VI

Le Volume VI a traité les trois risques propres à un collecteur documentaire, chacun par un mécanisme structurel plutôt que par une règle de vigilance.

Le contenu entrant est traité comme hostile par défaut : bornes dures, analyseurs désarmés, extraction isolée dans un processus sacrifiable, et un magasin adressé par empreinte qui élimine par construction toute une classe de vulnérabilités de chemin.

Le code des plugins est encadré par des capacités en liste blanche, une signature vérifiée avant toute évaluation, et trois niveaux d'isolement choisis à l'exploitation sans réécriture.

Le corpus produit repose sur une chaîne de confiance vérifiable : adressage par contenu, journal d'audit chaîné, ancrage externe optionnel, attestation de document à la demande — qui affirme exactement ce qu'elle peut affirmer, et rien de plus.

Enfin, ce volume définit ce que le Framework refuse de savoir faire. Cette liste d'absences est un choix d'architecture au même titre que les fonctions présentes : un outil qui ne peut pas contourner une protection ne pourra jamais être utilisé pour la contourner.

**Volume VII — Observability, Operations & Deployment** traitera de la conduite du système en production : journalisation structurée, métriques, traces, tableaux de bord, alertes utiles, profils de déploiement, procédures d'exploitation, et le manuel d'astreinte.
