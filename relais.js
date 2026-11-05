// Relais du site : remplace google.script.run (qui n'existe que dans Apps Script) par des appels à l'API.
// L'interface (index.html) ne change pas : elle appelle toujours google.script.run.xxx(...).
// - La clé est demandée une fois par appareil et gardée sur l'appareil (localStorage) ; refusée par l'API
//   (changée avec creerCleApi), elle est oubliée et redemandée.
// - Les écritures partent une à la fois, dans l'ordre, et la file est gardée sur l'appareil : réseau coupé
//   ou app fermée, elles repartent dès que possible. Chacune a un identifiant (req) : renvoyée deux fois,
//   le serveur ne l'applique qu'une fois.
// - Un rechargement (getData) attend que la file soit vide, pour ne pas montrer des données d'avant le geste.
(function () {
  var API = window.SYSTEME_API || '';
  var CLE = 'systeme-cle', FILE = 'systeme-file-v1';
  var LECTURES = ['getData', 'chercherMedia', 'chercherMedias', 'chercherLivres'];

  function lire(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function ecrire(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} }
  function nouvelId() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  var cle = lire(CLE) || '';
  var file = [];
  try { file = JSON.parse(lire(FILE) || '[]') || []; } catch (_) { file = []; }
  var rappels = {};          // req → { ok, ko } (seulement pour les écritures de cette session)
  var lecturesEnAttente = []; // lectures en attente de la clé ou d'une file vide
  var occupe = false, horsLigne = false, essais = 0, minuteur = null;

  function garderFile() { ecrire(FILE, JSON.stringify(file)); }

  // Un appel à l'API. Rend une promesse : { ok, v } / { ok:false, erreur } ; rejette si le réseau manque.
  function appeler(fn, args, req) {
    var corps = { cle: cle, fn: fn, args: args };
    if (req) corps.req = req;
    return fetch(API, {
      method: 'POST', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(corps)
    }).then(function (r) {
      if (!r.ok) throw new Error('réseau ' + r.status);
      return r.text();
    }).then(function (t) {
      try { return JSON.parse(t); } catch (_) { throw new Error('réponse illisible'); }
    });
  }

  function erreur(message) { var e = new Error(message); e.message = message; return e; }
  function rendre(f, v) { if (f) try { f(v); } catch (e) { setTimeout(function () { throw e; }); } }

  // --- Voyant : hors ligne, n écritures en attente --------------------------------------------
  function voyant() {
    var z = document.getElementById('sync');
    if (!z) return;
    if (horsLigne && file.length) {
      z.textContent = '⏳ Hors ligne · ' + file.length + ' en attente';
      z.classList.add('on');
    }
  }

  // --- La file des écritures -------------------------------------------------------------------
  function relancerBientot() {
    clearTimeout(minuteur);
    var attente = Math.min(30000, 1500 * Math.pow(2, Math.min(essais, 5)));
    minuteur = setTimeout(suivante, attente);
  }
  function suivante() {
    clearTimeout(minuteur);
    if (occupe) return;
    if (!cle) { demanderCle(''); return; }
    if (!file.length) {
      // Revenue en ligne après une panne : on recharge (ce qui est parti entre-temps est dans le Sheet)
      var etaitHors = horsLigne; horsLigne = false; lancerLectures();
      if (etaitHors && typeof window.majSync === 'function') window.majSync();
      if (etaitHors && typeof window.charger === 'function') window.charger();
      return;
    }
    occupe = true;
    var x = file[0];
    appeler(x.fn, x.args, x.req).then(function (rep) {
      occupe = false;
      if (rep && rep.erreur === 'cle') { oublierCle(); return; }
      essais = 0;
      file.shift(); garderFile();
      var h = rappels[x.req]; delete rappels[x.req];
      if (rep && rep.ok) rendre(h && h.ok, rep.v);
      else rendre(h && h.ko, erreur((rep && rep.message) || 'Le Sheet a refusé ce changement.'));
      suivante();
    }, function () {
      occupe = false; horsLigne = true; essais++;
      voyant(); relancerBientot();
      lancerLectures();   // hors ligne : un rechargement n'attend pas (il échouera et laissera la copie)
    });
  }

  // --- Les lectures (getData, recherches) ---------------------------------------------------------
  function lancerLectures() {
    if (!cle) return;
    var prets = lecturesEnAttente.filter(function (l) { return l.fn !== 'getData' || !file.length || horsLigne; });
    lecturesEnAttente = lecturesEnAttente.filter(function (l) { return prets.indexOf(l) < 0; });
    prets.forEach(function (l) {
      appeler(l.fn, l.args).then(function (rep) {
        if (rep && rep.erreur === 'cle') { lecturesEnAttente.push(l); oublierCle(); return; }
        if (rep && rep.ok) rendre(l.ok, rep.v);
        else rendre(l.ko, erreur((rep && rep.message) || 'Le Sheet ne répond pas.'));
      }, function () {
        horsLigne = !!file.length || horsLigne;
        rendre(l.ko, erreur('pas de connexion'));
      });
    });
  }

  function appel(fn, args, ok, ko) {
    if (LECTURES.indexOf(fn) >= 0) {
      lecturesEnAttente.push({ fn: fn, args: args, ok: ok, ko: ko });
      if (!cle) demanderCle(''); else lancerLectures();
      return;
    }
    var req = nouvelId();
    rappels[req] = { ok: ok, ko: ko };
    file.push({ req: req, fn: fn, args: args });
    garderFile();
    if (!occupe) suivante();
  }

  // google.script.run.withSuccessHandler(f).withFailureHandler(g).nomFonction(…)
  function chaine(ok, ko) {
    return new Proxy({}, { get: function (_, nom) {
      if (nom === 'withSuccessHandler') return function (f) { return chaine(f, ko); };
      if (nom === 'withFailureHandler') return function (f) { return chaine(ok, f); };
      if (nom === 'withUserObject') return function () { return chaine(ok, ko); };
      if (typeof nom !== 'string') return undefined;
      return function () { appel(nom, Array.prototype.slice.call(arguments).map(function (a) { return a === undefined ? null : a; }), ok, ko); };
    } });
  }
  window.google = { script: {} };
  // La file d'ici remplace celle de l'app (qui ne garde rien si l'app se ferme) : l'app envoie tout de suite
  window.__sansFile = true;
  Object.defineProperty(window.google.script, 'run', { configurable: true, get: function () { return chaine(null, null); } });

  // --- La clé ----------------------------------------------------------------------------------
  // Même style que l'app : fond beige, boîte crème, contour brun, ombre décalée, bouton terracotta
  var STYLE_CLE = '#cle-ecran{position:fixed;inset:0;z-index:9999;background:#EFE6D8;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Poppins,system-ui,sans-serif;color:#2E2622}' +
    '#cle-ecran .cle-boite{background:#FBF5EB;border:1.5px solid #2E2622;border-radius:16px;box-shadow:3px 3px 0 #2E2622;padding:20px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px}' +
    '#cle-ecran .cle-titre{font-weight:700;font-size:18px}' +
    '#cle-ecran input{font:inherit;font-size:16px;padding:10px 12px;border:1.5px solid #2E2622;border-radius:10px;background:#fff;color:#2E2622;width:100%;box-sizing:border-box}' +
    '#cle-ecran .cle-msg{font-size:14px;min-height:0}#cle-ecran .cle-msg:empty{display:none}' +
    '#cle-ecran button{font:inherit;font-weight:600;font-size:16px;padding:10px 16px;border:1.5px solid #2E2622;border-radius:999px;background:#C44B56;color:#FFF8EE;box-shadow:2px 2px 0 #2E2622;cursor:pointer}';
  function oublierCle() {
    var avait = !!cle;
    cle = ''; ecrire(CLE, null);
    demanderCle(avait ? 'Cette clé ne marche pas (ou elle a changé). Colle la nouvelle.' : '');
  }
  function demanderCle(message) {
    var z = document.getElementById('cle-ecran');
    if (!z) {
      if (!document.body) { document.addEventListener('DOMContentLoaded', function () { demanderCle(message); }); return; }
      var st = document.createElement('style');
      st.textContent = STYLE_CLE;
      document.head.appendChild(st);
      z = document.createElement('div');
      z.id = 'cle-ecran';
      z.innerHTML = '<form class="cle-boite" autocomplete="off">' +
        '<div class="cle-titre">🔑 Clé de l\'app</div>' +
        '<input type="password" name="cle" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Clé de l\'app">' +
        '<div class="cle-msg" role="alert"></div>' +
        '<button type="submit">Entrer</button></form>';
      document.body.appendChild(z);
      z.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        var v = z.querySelector('input').value.trim();
        if (v.length < 32) { z.querySelector('.cle-msg').textContent = 'Cette clé est trop courte.'; return; }
        cle = v; ecrire(CLE, v);
        z.remove();
        suivante(); lancerLectures();
      });
    }
    z.querySelector('.cle-msg').textContent = message || '';
    setTimeout(function () { var i = z.querySelector('input'); if (i) i.focus(); }, 50);
  }

  // --- Retour du réseau, retour dans l'app ------------------------------------------------------
  window.addEventListener('online', function () {
    essais = 0;
    if (file.length) suivante();
    else if (typeof window.charger === 'function') window.charger();
  });
  var cacheDepuis = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cacheDepuis = Date.now(); return; }
    if (file.length) { essais = 0; suivante(); }
    // Revenue dans l'app après un moment : données fraîches (un autre appareil a pu écrire)
    if (cacheDepuis && Date.now() - cacheDepuis > 120000 && typeof window.charger === 'function') window.charger();
    cacheDepuis = 0;
  });

  // Structure de l'app en cache (ouverture immédiate, même sans réseau)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  // Le voyant de l'app (« ⏳ Enregistrement… » / « ✓ Enregistré ») tient compte de la file hors ligne
  document.addEventListener('DOMContentLoaded', function () {
    var majApp = window.majSync;
    if (typeof majApp !== 'function') return;
    window.majSync = function () { if (horsLigne && file.length) voyant(); else majApp(); };
  });

  // Écritures restées d'une visite précédente : elles repartent tout de suite
  if (file.length) setTimeout(suivante, 0);

  // Pour les tests
  window.__relais = { file: function () { return file.slice(); }, cle: function () { return cle; } };
})();
