# Présentation HTML + retour caméra du téléphone en direct

Une présentation HTML (slides 1, 2, 3 → **caméra de ton téléphone en plein écran** → slides 4, 5 → fin)
où la slide « caméra » affiche en direct ce que filme ton téléphone, avec une latence minimale et la meilleure
qualité possible. Pour connecter le téléphone : **un seul scan de QR code**.

```bash
python3 server.py
```

C'est tout : aucune installation (Python 3 + `openssl`, déjà présents sur ta Fedora). Le navigateur s'ouvre sur la
présentation, tu scannes le QR code avec le téléphone, tu appuies sur `→`.

---

## Déroulé

1. `python3 server.py` sur le PC → la présentation s'ouvre, avec un **QR code** (slide 0).
2. Sur le téléphone (même Wi-Fi) : scanner le QR code avec l'appareil photo. Le navigateur s'ouvre, tu **acceptes l'avertissement de certificat** (« Avancé → Continuer »), tu **autorises la caméra**.
3. Sur le PC, le QR code est remplacé par un aperçu vert et « Caméra en direct — 1920×1080 @ 30 fps ». Appuie sur `F` (plein écran), puis `→`.
4. Slides 1, 2, 3 normales.
5. Slide 4 : le retour caméra, plein écran, **instantané** (le flux tourne déjà en coulisses depuis la connexion).
6. `→` : retour aux slides normales (4, 5, « Merci »).

### Raccourcis (sur le PC)

| Touche | Action |
|---|---|
| `→` `↓` `Espace` `Entrée` `PageDown` | slide suivante (un pointeur/clicker envoie PageDown/PageUp) |
| `←` `↑` `Retour` `PageUp` | slide précédente |
| `Début` / `Fin` | première / dernière slide |
| `F` | plein écran |
| `S` | stats vidéo (résolution, fps, débit, RTT, jitter buffer, décodage) |
| `H` | afficher / masquer la pastille d'état et le compteur de slides |
| `M` | miroir horizontal (utile avec la caméra frontale) |
| `C` | image remplie (`cover`) au lieu de l'image entière (`contain`) |
| `R` | **secours** : force le téléphone à relancer la connexion vidéo |

La pastille d'état est **invisible** pendant la présentation tant que tout va bien ; elle n'apparaît (en rouge/orange)
que si le flux se perd, pour que tu le saches avant le public.

---

## Réglages qualité / latence

```bash
python3 server.py --res 1080p --fps 30 --bitrate 16 --codec h264   # valeurs par défaut
python3 server.py --res 4k --fps 30 --bitrate 30                   # qualité max (selon le téléphone)
python3 server.py --res 720p --fps 60 --bitrate 10                 # plus fluide, moins définie
python3 server.py --codec vp8                                      # si le H.264 pose problème
```

| Option | Rôle |
|---|---|
| `--res` | `720p`, `1080p`, `1440p`, `4k` (demandé au téléphone ; il fournit le plus proche qu'il sait faire) |
| `--fps` | images/seconde demandées |
| `--bitrate` | plafond du débit vidéo en Mb/s. Par défaut Chrome plafonne à ~2,5 Mb/s : ce plafond est relevé |
| `--codec` | `h264` (défaut, encodage matériel sur la plupart des téléphones), `vp8`, `vp9`, `av1`, `auto`. Si le PC ne sait pas décoder le codec demandé, WebRTC retombe automatiquement sur un autre |
| `--ip` | forcer l'IP du PC dans le QR code (si le serveur choisit la mauvaise interface) |
| `--http-port`, `--https-port` | ports (8080 / 8443) |
| `--token` | jeton fixe dans le QR code (par défaut : aléatoire à chaque lancement) |
| `--no-open` | ne pas ouvrir le navigateur tout seul |

**Conseil :** pour le jour J, 1080p/30 est le meilleur compromis. Le 4K n'a de sens que si le téléphone sait
l'encoder en temps réel (les stats `S` sur le PC et « Infos » sur le téléphone montrent ce qui est réellement envoyé
et si l'encodeur est bridé : `bridage cpu` / `bandwidth`).

---

## Comment ça marche

```
   Téléphone (https://IP:8443)                        PC (http://127.0.0.1:8080)
  ┌───────────────────────────┐                      ┌───────────────────────────┐
  │ page caméra (phone.js)    │                      │ présentation (presenter.js)│
  │  getUserMedia → encodeur  │ ═════ WebRTC ═══════►│  <video> décodage → écran │
  └─────────────┬─────────────┘   vidéo directe,     └─────────────┬─────────────┘
                │                 UDP, sans serveur                │
                │   signalisation (offre/réponse/candidats ICE)    │
                └──────────────►  server.py  ◄─────────────────────┘
                              (relais SSE + POST)
```

- **WebRTC en pair-à-pair** : la vidéo va directement du téléphone au navigateur du PC, en UDP, sans passer par le
  serveur ni par internet (aucun serveur STUN/TURN, ça marche **sans connexion internet**). C'est la technologie la
  moins latente qu'un navigateur sache faire.
- **`server.py`** ne fait que trois choses : servir les pages, relayer la « signalisation » WebRTC entre les deux
  pages, et générer le QR code / le certificat. Il ne voit jamais la vidéo. Zéro dépendance Python : la signalisation
  utilise Server-Sent Events + POST (pas besoin de WebSocket).
- **HTTPS avec certificat auto-signé** pour le téléphone : les navigateurs mobiles *refusent* la caméra sur une page
  HTTP. Le certificat est fabriqué par `openssl` au premier lancement (dossier `.certs/`) et couvre l'IP du PC.
  C'est la seule raison de l'avertissement à accepter une fois sur le téléphone.
- **La présentation reste en `http://127.0.0.1`** (pas d'avertissement sur le PC) et n'est **pas** joignable depuis le réseau.

### Ce qui est fait pour la latence

- Le flux est connecté **dès la slide 0** et le `<video>` n'est jamais recréé : la slide caméra ne fait que le rendre visible → pas de temps de démarrage.
- Pas de STUN/TURN, pas de serveur intermédiaire : chemin le plus court possible.
- Côté réception : `jitterBufferTarget = 0` / `playoutDelayHint = 0` (le navigateur ne retarde pas la lecture pour lisser).
- Côté envoi : priorité réseau haute, `maintain-resolution` (si le réseau sature, on perd des images plutôt que de la netteté).
- Aucune manipulation du SDP (pas de bricolage fragile) : tout passe par les API standard.

### Ce qui est fait pour la qualité

- Résolution demandée au téléphone, caméra arrière par défaut, plafond de débit relevé (16 Mb/s par défaut), codec matériel.

### Robustesse

- **F5 sur la présentation** → le téléphone renvoie automatiquement le flux (il ne faut rien rescanner) ; la slide courante est conservée (`#n` dans l'URL).
- **Le téléphone se déconnecte / change de Wi-Fi / verrouille l'écran** → la pastille passe au rouge sur le PC ; dès que la page du téléphone est de retour, le flux reprend seul. L'écran du téléphone est gardé allumé (Wake Lock).
- Appel entrant ou autre appli qui prend la caméra → la caméra est relancée automatiquement au retour.
- Bouton « Changer de caméra » (avant/arrière) sur le téléphone, sans couper la connexion.
- Le QR code contient un **jeton aléatoire** : personne d'autre sur le réseau ne peut envoyer de vidéo à ta présentation.

---

## Fichiers

```
server.py                 serveur (pages + signalisation + certificat + QR)
web/presenter/            la présentation (PC)
  index.html              ← les slides sont ici (<section class="slide">)
  presenter.css           style
  presenter.js            navigation, réception WebRTC, stats
web/phone/                page caméra (téléphone)
  index.html  phone.css  phone.js
web/vendor/qrcode.js      générateur de QR code (qrcode-generator 2.0.4, MIT), embarqué pour fonctionner hors-ligne
.certs/                   certificat HTTPS généré automatiquement (supprimable)
```

### Modifier les slides

Dans `web/presenter/index.html`, chaque slide est un bloc `<section class="slide">…</section>`. Copie / modifie /
réordonne librement. La slide qui a l'attribut **`data-camera`** affiche le retour caméra (tu peux en mettre
plusieurs, ou la déplacer). La slide 0 (QR code) doit rester la première.

---

## Avant le jour J : checklist

1. **Répète avec le matériel et le réseau réels** (l'adresse IP, donc le certificat et le QR code, changent d'un réseau à l'autre).
2. **Le Wi-Fi de l'amphi est le principal risque.** Beaucoup de réseaux d'université / d'entreprise activent l'« isolation des clients » : le téléphone ne peut alors pas joindre le PC, quoi que tu fasses. Solutions fiables :
   - le **partage de connexion (hotspot) du téléphone**, auquel tu connectes le PC (aucun internet requis) ;
   - ou un petit **routeur de voyage** à toi ;
   - ou PC en Ethernet + téléphone sur un Wi-Fi qui n'isole pas.
   Si possible Wi-Fi **5 GHz** (moins de congestion que le 2,4 GHz saturé d'un amphi).
3. Désactive les économies d'énergie du téléphone pour le navigateur, mets-le en mode **paysage** avec la rotation auto **verrouillée**, et branche-le (la caméra + l'encodage chauffent et vident la batterie).
4. Ne quitte pas la page caméra du téléphone pendant la présentation (le navigateur coupe la caméra en arrière-plan). Il n'y a rien à toucher dessus.
5. Prévois le plan B : la touche `R` relance la connexion, et sinon on peut simplement **sauter la slide** (`→`).
6. Navigateur du PC : **Chrome / Chromium recommandé** (c'est celui avec lequel c'est testé). Firefox devrait fonctionner mais n'applique pas le réglage de latence du récepteur.

## Dépannage

| Symptôme | Cause probable / solution |
|---|---|
| Le téléphone n'arrive pas à ouvrir la page | Pas le même réseau, ou **isolation des clients** (voir ci-dessus). Teste l'URL affichée sous le QR code. |
| Le QR code contient la mauvaise IP | Regarde la ligne « Interfaces réseau vues » au lancement, puis `python3 server.py --ip 192.168.x.x`. |
| **VPN Mullvad** actif sur le PC | Il peut bloquer le réseau local : active *Paramètres → VPN settings → Local network sharing*, ou coupe le VPN. (Le serveur ignore déjà l'interface du VPN pour choisir l'IP.) |
| Page OK mais « Connexion à la présentation… » ne finit pas | Pare-feu du PC qui bloque l'UDP entrant. Sous Fedora Workstation les ports ≥ 1025 sont ouverts par défaut ; sinon ouvre-les ou coupe le pare-feu pour la présentation. |
| « Lien refusé… rescanne le QR code » | Le serveur a été relancé (nouveau jeton). Rescanne, ou lance avec `--token` fixe pour répéter. |
| « Accès à la caméra refusé » | Autoriser la caméra pour le site dans les réglages du navigateur du téléphone, puis « Réessayer ». |
| L'image saccade / est floue | Touche `S` : regarde `débit`, `paquets perdus` ; et « Infos » sur le téléphone : `bridage`. Baisse `--res`/`--bitrate`, ou passe `--codec vp8`. |
| Pas d'avertissement de certificat à accepter, mais caméra bloquée | Le navigateur a ouvert l'adresse en `http://` : utilise bien le lien `https://` du QR code. |
| iPhone | Safari fonctionne (caméra et H.264 natifs). L'avertissement de certificat se valide via « Afficher les détails → Visiter ce site web ». |

## Ce qui a été vérifié (et ce qui ne l'a pas été)

Vérifié ici, dans un Chromium avec une caméra simulée 1920×1080 à 30 images/s : génération du certificat et service
HTTPS, jeton refusé si faux, présentation inaccessible depuis le réseau, connexion WebRTC complète (codec H.264,
RTT ≈ 1 ms, jitter buffer ≈ 5 ms, décodage ≈ 2 ms/image, 0 perte), navigation slides 1-2-3 → caméra → 4, reconnexion
après rechargement de la présentation et après fermeture/réouverture de la page téléphone, et décodage du QR code
affiché (il contient bien l'URL attendue).

**Pas testé :** un vrai téléphone sur un vrai Wi-Fi. La latence « verre à verre » réelle (caméra → écran) dépend surtout
de la caméra et de l'encodeur du téléphone ; l'ordre de grandeur attendu est de quelques dixièmes de seconde, mais
**mesure-la à la répétition** (filme un chronomètre affiché sur le PC pour la voir). Le comportement exact de
l'avertissement de certificat varie d'un téléphone à l'autre.
