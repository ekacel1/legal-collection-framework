# Installation sur un serveur Linux

Cible : un VPS Debian ou Ubuntu, avec **Node.js 22.5+** — idéalement **24**, où
`node:sqlite` est stable et où aucun drapeau n'est nécessaire.

Prévoir **70 Go de disque** : environ 33 Go pour le corpus SGG complet, autant
pour la sauvegarde, et une marge.

---

## 1. Utilisateur et répertoires

```bash
sudo useradd --system --home /opt/lcf --shell /usr/sbin/nologin lcf
sudo mkdir -p /opt/lcf /var/lib/lcf/data /var/backups/lcf
sudo chown -R lcf:lcf /opt/lcf /var/lib/lcf /var/backups/lcf
```

Le service n'a besoin d'écrire que dans `/var/lib/lcf` et `/var/backups/lcf` —
l'unité systemd le lui rappelle avec `ProtectSystem=strict`.

## 2. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # doit afficher v24.x
```

## 3. Code et dépendances

```bash
sudo -u lcf git clone <votre-depot> /opt/lcf
cd /opt/lcf
sudo -u lcf npm ci
sudo -u lcf npm run build
sudo -u lcf npm test        # 306 tests doivent passer
```

Aucune dépendance de production n'est installée : `npm ci` ne récupère que
TypeScript et les typages Node, qui servent au build.

## 4. Configuration

```bash
sudo -u lcf cp deploy/lcf.config.vps.json /opt/lcf/lcf.config.json
sudo -u lcf nano /opt/lcf/lcf.config.json
```

Une seule ligne demande vraiment votre attention :

```json
"contact": "tikatokamoney@gmail.com"
```

Elle part dans le `User-Agent` de chaque requête. Elle doit rester une boîte
réellement relevée — c'est ce qui permet à l'administrateur d'une source de
vous écrire plutôt que de bloquer votre serveur. **Le démon refuse de démarrer
si elle ressemble à un exemple.**

## 5. Vérification avant mise en service

```bash
cd /opt/lcf
sudo -u lcf node packages/cli/dist/src/bin.js init
sudo -u lcf node packages/cli/dist/src/bin.js daemon --once
```

`daemon --once` fait un seul tour : il valide la configuration, les expressions
cron et les fenêtres d'exclusion, puis sort. S'il refuse de démarrer, il dit
exactement pourquoi.

## 6. Service

```bash
sudo cp deploy/lcf.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lcf
sudo systemctl status lcf
```

Suivre ce qu'il fait :

```bash
sudo journalctl -u lcf -f
sudo -u lcf tail -f /var/lib/lcf/data/logs/lcf-$(date +%Y%m%d).jsonl
```

## 7. Tableau de bord

Il écoute **uniquement sur 127.0.0.1** : c'est délibéré, puisqu'il permet de
déclencher des collectes. Depuis votre poste :

```bash
ssh -N -L 7331:127.0.0.1:7331 lcf@votre-serveur
```

puis ouvrez `http://127.0.0.1:7331`. Sur le serveur, lancez-le avec :

```bash
sudo -u lcf node /opt/lcf/packages/cli/dist/src/bin.js serve
```

> Ne l'exposez jamais directement. Si vous y tenez, placez-le derrière un proxy
> authentifié — jamais nu sur l'Internet.

## 8. Première collecte complète

Le démon collecte chaque nuit à partir de 2 h et s'arrête de lui-même à 7 h UTC
(8 h au Bénin). Les 35 000 documents demandent **environ 60 heures**, donc
plusieurs nuits. Rien à faire : chaque nuit reprend là où la précédente s'est
arrêtée.

Pour amorcer plus vite, hors heures ouvrables :

```bash
sudo systemctl stop lcf          # le démon détient le verrou exclusif
sudo -u lcf node packages/cli/dist/src/bin.js run --all
sudo systemctl start lcf
```

## 9. Sauvegarde

Le sous-système de sauvegarde n'est pas encore livré (point C3). En attendant,
une copie en **ajout seul** suffit : le magasin est immuable, un objet
sauvegardé n'a jamais besoin de l'être à nouveau.

```bash
# 3 h 30, quand aucune collecte ne tourne
30 3 * * * rsync -a --ignore-existing /var/lib/lcf/data/objects/ /var/backups/lcf/objects/
```

L'index, lui, est reconstructible : `lcf reindex` le rebâtit depuis le magasin
seul, sans aucun accès réseau.

## 10. Secrets

Aucune source actuelle n'en demande. Le jour où un plugin en exige un :

```bash
sudo install -m 0600 -o root -g lcf /dev/null /etc/lcf/secrets.env
echo 'API_TOKEN=...' | sudo tee -a /etc/lcf/secrets.env
sudo sed -i 's|^# EnvironmentFile|EnvironmentFile|' /etc/systemd/system/lcf.service
sudo systemctl daemon-reload && sudo systemctl restart lcf
```

La configuration référence alors la variable, jamais la valeur :

```json
{ "sourceId": "…", "secretsFromEnv": { "API_TOKEN": "API_TOKEN" } }
```

---

## Exploitation courante

| Besoin | Commande |
|---|---|
| État général | `lcf status` |
| Vérifier tout le magasin | `lcf verify --all` |
| Lever une quarantaine | `lcf source resume <id>` |
| Reconstruire l'index perdu | `lcf reindex` |
| Arrêter proprement | `sudo systemctl stop lcf` |

Le démon détient un **verrou exclusif** sur le magasin : toute commande qui
sollicite une source refusera de tourner tant qu'il est actif, en nommant le
détenteur. C'est ce qui garantit que la source ne reçoit jamais le double de la
charge négociée.
