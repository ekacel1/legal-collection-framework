/**
 * Page du tableau de bord — une seule page, sans dependance ni outil de build.
 *
 * Aucun framework, aucun CDN, aucun fichier statique a servir : le Volume I
 * interdit d'ajouter une dependance sans necessite, et une page qui doit durer
 * quinze ans a tout interet a ne dependre de rien. Tout tient dans une chaine.
 */

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LCF — tableau de bord</title>
<style>
  :root {
    color-scheme: light dark;
    --fond: #fbfbfa; --carte: #fff; --trait: #e3e2df; --texte: #1c1b19;
    --doux: #6b6a67; --accent: #0b3d5b; --ok: #1a7f4b; --alerte: #b3261e;
    --attention: #9a6700;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fond: #16171a; --carte: #1e2024; --trait: #2e3136; --texte: #eceef0;
      --doux: #9aa0a6; --accent: #7fb3d5; --ok: #4ade80; --alerte: #f87171;
      --attention: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--fond); color: var(--texte);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em;
       color: var(--doux); margin: 28px 0 10px; font-weight: 600; }
  .entete { display: flex; justify-content: space-between; align-items: flex-start;
            gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .sous { color: var(--doux); font-size: 13px; }
  .grille { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .carte { background: var(--carte); border: 1px solid var(--trait); border-radius: 10px; padding: 14px 16px; }
  .chiffre { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .etiquette { color: var(--doux); font-size: 12px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
       color: var(--doux); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--trait); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--trait); }
  tr:last-child td { border-bottom: 0; }
  .num { text-align: right; }
  .pastille { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; font-weight: 500; }
  .p-ok { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .p-alerte { background: color-mix(in srgb, var(--alerte) 15%, transparent); color: var(--alerte); }
  .p-attention { background: color-mix(in srgb, var(--attention) 18%, transparent); color: var(--attention); }
  .p-neutre { background: color-mix(in srgb, var(--doux) 15%, transparent); color: var(--doux); }
  button { font: inherit; padding: 5px 12px; border-radius: 7px; border: 1px solid var(--trait);
           background: var(--carte); color: var(--texte); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.principal { background: var(--accent); color: #fff; border-color: var(--accent); }
  .barres { display: flex; align-items: flex-end; gap: 3px; height: 90px; padding-top: 8px; }
  .barre { flex: 1; min-width: 4px; background: var(--accent); border-radius: 2px 2px 0 0; opacity: 0.85; }
  .barre:hover { opacity: 1; }
  .axe { display: flex; justify-content: space-between; color: var(--doux); font-size: 11px; margin-top: 6px; }
  .vide { color: var(--doux); padding: 20px; text-align: center; }
  .actions { display: flex; gap: 8px; align-items: center; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: var(--doux); }
</style>
</head>
<body>
<div class="entete">
  <div>
    <h1>Legal Collection Framework</h1>
    <div class="sous" id="magasin"></div>
  </div>
  <div class="actions">
    <span id="demon"></span>
    <button id="stop">Arreter les collectes</button>
    <button id="rafraichir">Rafraichir</button>
  </div>
</div>

<div class="grille" id="totaux"></div>

<h2>Evolution du corpus</h2>
<div class="carte">
  <div class="barres" id="graphique"></div>
  <div class="axe" id="axe"></div>
</div>

<h2>Sources</h2>
<div class="carte"><table id="sources"></table></div>

<h2>Dernieres executions</h2>
<div class="carte"><table id="executions"></table></div>

<script>
const fmt = new Intl.NumberFormat("fr-FR");

function octets(n) {
  if (!n) return "0 o";
  const u = ["o", "Kio", "Mio", "Gio", "Tio"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

function instant(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function pastille(texte, classe) {
  return '<span class="pastille ' + classe + '">' + texte + "</span>";
}

function etatSource(s) {
  if (s.running) return pastille("collecte en cours", "p-attention");
  if (s.state === "quarantined") return pastille("quarantaine", "p-alerte");
  if (s.state === "disabled") return pastille("desactivee", "p-neutre");
  return pastille(s.state, "p-ok");
}

function etatRun(r) {
  if (r.status === "completed") return pastille("terminee", "p-ok");
  if (r.status === "running") return pastille("en cours", "p-attention");
  return pastille(r.status, "p-alerte");
}

async function charger() {
  const etat = await (await fetch("/api/state")).json();

  document.getElementById("magasin").textContent = etat.store;
  document.getElementById("demon").innerHTML = etat.daemon.active
    ? pastille("demon actif (pid " + etat.daemon.pid + ")", "p-ok")
    : pastille("demon arrete", "p-neutre");

  document.getElementById("totaux").innerHTML = [
    ['<div class="chiffre">' + fmt.format(etat.totals.documents) + "</div>", "documents"],
    ['<div class="chiffre">' + octets(etat.totals.bytes) + "</div>", "volume conserve"],
    ['<div class="chiffre">' + fmt.format(etat.totals.objects) + "</div>", "objets distincts"],
    ['<div class="chiffre" style="color:' + (etat.totals.failed ? "var(--alerte)" : "inherit") + '">'
      + fmt.format(etat.totals.failed) + "</div>", "documents en echec"],
  ].map(([v, l]) => '<div class="carte">' + v + '<div class="etiquette">' + l + "</div></div>").join("");

  // Evolution : cumul des documents collectes, jour par jour.
  const jours = etat.daily;
  const max = Math.max(1, ...jours.map((j) => j.documents));
  document.getElementById("graphique").innerHTML = jours.length === 0
    ? '<div class="vide">Aucune collecte enregistree.</div>'
    : jours.map((j) => '<div class="barre" style="height:' + Math.max(3, (j.documents / max) * 100)
        + '%" title="' + j.day + " : " + j.documents + " document(s), " + octets(j.bytes) + '"></div>').join("");
  document.getElementById("axe").innerHTML = jours.length === 0 ? "" :
    "<span>" + jours[0].day + "</span><span>" + jours[jours.length - 1].day + "</span>";

  document.getElementById("sources").innerHTML =
    "<tr><th>Source</th><th>Etat</th><th class='num'>Documents</th><th>Dernier succes</th><th></th></tr>" +
    (etat.sources.length === 0
      ? '<tr><td colspan="5" class="vide">Aucune source enregistree.</td></tr>'
      : etat.sources.map((s) =>
          "<tr><td><code>" + s.sourceId + "</code>" +
          (s.quarantineReason ? '<div class="sous">' + s.quarantineReason + "</div>" : "") +
          "</td><td>" + etatSource(s) + "</td>" +
          "<td class='num'>" + fmt.format(s.documents) + "</td>" +
          "<td>" + instant(s.lastSuccessAt) + "</td>" +
          "<td class='num'><button data-source='" + s.sourceId + "'" +
          (s.running ? " disabled" : "") + ">Collecter</button></td></tr>").join(""));

  document.getElementById("executions").innerHTML =
    "<tr><th>Execution</th><th>Source</th><th>Mode</th><th>Etat</th>" +
    "<th class='num'>Nouveaux</th><th class='num'>Maj</th><th class='num'>Inchanges</th>" +
    "<th class='num'>Echecs</th><th class='num'>Octets</th><th>Debut</th></tr>" +
    (etat.runs.length === 0
      ? '<tr><td colspan="10" class="vide">Aucune execution.</td></tr>'
      : etat.runs.map((r) =>
          "<tr><td><code>" + r.runId.slice(0, 14) + "</code></td>" +
          "<td><code>" + r.sourceId + "</code></td><td>" + r.mode + "</td>" +
          "<td>" + etatRun(r) + "</td>" +
          "<td class='num'>" + r.docsNew + "</td><td class='num'>" + r.docsUpdated + "</td>" +
          "<td class='num'>" + r.docsUnchanged + "</td>" +
          "<td class='num'>" + (r.docsFailed ? '<span style="color:var(--alerte)">' + r.docsFailed + "</span>" : "0") + "</td>" +
          "<td class='num'>" + octets(r.bytes) + "</td>" +
          "<td>" + instant(r.startedAt) + "</td></tr>").join(""));

  for (const bouton of document.querySelectorAll("button[data-source]")) {
    bouton.addEventListener("click", async () => {
      bouton.disabled = true;
      bouton.textContent = "Lancement...";
      const reponse = await (await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: bouton.dataset.source }),
      })).json();
      if (!reponse.started) alert("Collecte non lancee : " + (reponse.reason ?? "motif inconnu"));
      setTimeout(charger, 600);
    });
  }
}

document.getElementById("rafraichir").addEventListener("click", charger);
document.getElementById("stop").addEventListener("click", async () => {
  const reponse = await (await fetch("/api/stop", { method: "POST" })).json();
  alert(reponse.stopping.length === 0
    ? "Aucune collecte en cours."
    : "Arret demande pour : " + reponse.stopping.join(", ") +
      "\\nLa collecte s'arrete entre deux documents, jamais en plein transfert.");
  setTimeout(charger, 600);
});

charger();
// Rafraichissement doux : le tableau de bord observe, il ne sollicite pas.
setInterval(charger, 10000);
</script>
</body>
</html>`;
}
