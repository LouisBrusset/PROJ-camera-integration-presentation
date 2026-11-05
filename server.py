#!/usr/bin/env python3
"""
Serveur de la présentation avec retour caméra du téléphone.

Rôle du serveur (il ne voit JAMAIS la vidéo, elle passe en WebRTC directement
du téléphone vers le navigateur de la présentation) :
  1. sert la présentation (http://127.0.0.1:8080, réservée à cet ordinateur)
  2. sert la page "caméra" du téléphone (https://<ip-lan>:8443, QR code)
  3. fait la "signalisation" WebRTC : relaie offre / réponse / candidats ICE
     entre les deux pages (Server-Sent Events + POST, sans dépendance).

Aucune dépendance Python : seulement la bibliothèque standard + la commande
`openssl` (pour fabriquer le certificat HTTPS auto-signé).
"""
import argparse
import ipaddress
import json
import mimetypes
import os
import queue
import re
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
CERT_DIR = os.path.join(ROOT, ".certs")

RESOLUTIONS = {
    "720p": (1280, 720),
    "1080p": (1920, 1080),
    "1440p": (2560, 1440),
    "4k": (3840, 2160),
}

# Types de messages que les deux pages ont le droit de s'échanger.
RELAYED = {"offer", "answer", "candidate"}


def log(*args):
    print(time.strftime("[%H:%M:%S]"), *args, flush=True)


# --------------------------------------------------------------------------
# Détection de l'adresse IP du réseau local
# --------------------------------------------------------------------------
IGNORED_IFACES = re.compile(
    r"^(lo|docker|br-|virbr|veth|vmnet|vboxnet|wg|tun|tap|tailscale|ts|zt|mullvad|utun|vEthernetWSL)"
)


def lan_candidates():
    """Retourne [(interface, ip)] triés du plus probable au moins probable.

    On n'utilise pas la route par défaut : avec un VPN (Mullvad...) elle
    pointe vers le VPN, pas vers le Wi-Fi sur lequel est le téléphone.
    """
    found = []
    try:
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"], capture_output=True, text=True, timeout=3
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            found.append((parts[1], parts[3].split("/")[0]))
    except (OSError, subprocess.SubprocessError, IndexError):
        pass

    if not found:  # macOS / Windows : méthodes portables, moins précises
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("192.0.2.1", 9))  # aucune donnée envoyée
            found.append(("?", s.getsockname()[0]))
            s.close()
        except OSError:
            pass
        try:
            for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
                found.append(("?", ip))
        except OSError:
            pass

    result = []
    for name, ip in found:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if not addr.is_private or addr.is_loopback or addr.is_link_local:
            continue
        if IGNORED_IFACES.match(name):
            continue
        rank = 0 if name.startswith(("wl", "wi", "Wi")) else 1 if name.startswith(("en", "eth", "Eth")) else 2
        if (name, ip) not in [(n, i) for _, n, i in result]:
            result.append((rank, name, ip))
    result.sort()
    return [(n, i) for _, n, i in result]


# --------------------------------------------------------------------------
# Certificat HTTPS auto-signé (indispensable : le navigateur du téléphone
# refuse d'ouvrir la caméra sur une page HTTP non sécurisée)
# --------------------------------------------------------------------------
def ensure_cert(ips):
    os.makedirs(CERT_DIR, exist_ok=True)
    key = os.path.join(CERT_DIR, "key.pem")
    crt = os.path.join(CERT_DIR, "cert.pem")
    meta = os.path.join(CERT_DIR, "sans.txt")
    sans = ",".join(["DNS:localhost", "IP:127.0.0.1"] + [f"IP:{ip}" for ip in sorted(set(ips))])

    if all(os.path.exists(p) for p in (key, crt, meta)):
        with open(meta) as f:
            if f.read() == sans:
                return crt, key

    log("Génération d'un certificat HTTPS auto-signé pour", sans)
    try:
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                "-nodes", "-keyout", key, "-out", crt, "-days", "365",
                "-subj", "/CN=camera-presentation", "-addext", f"subjectAltName={sans}",
            ],
            check=True, capture_output=True,
        )
    except FileNotFoundError:
        sys.exit("Erreur : la commande `openssl` est introuvable (sudo dnf install openssl).")
    except subprocess.CalledProcessError as e:
        sys.exit("Erreur openssl : " + e.stderr.decode(errors="replace"))
    os.chmod(key, 0o600)
    with open(meta, "w") as f:
        f.write(sans)
    return crt, key


# --------------------------------------------------------------------------
# Signalisation : un "canal" (file d'événements) par rôle
# --------------------------------------------------------------------------
class Hub:
    def __init__(self, config, phone_url):
        self.lock = threading.Lock()
        self.chan = {"presenter": None, "phone": None}
        self.config = config
        self.phone_url = phone_url

    @staticmethod
    def other(role):
        return "phone" if role == "presenter" else "presenter"

    def attach(self, role):
        q = queue.Queue()
        with self.lock:
            old = self.chan[role]
            self.chan[role] = q
            if old:
                old.put(None)  # un seul client par rôle : le plus récent gagne
            peer = self.chan[self.other(role)]
            if role == "presenter":
                q.put(("init", {"phoneUrl": self.phone_url, "config": self.config, "phone": peer is not None}))
                if peer:
                    peer.put(("peer-ready", {}))  # le téléphone refait une offre
            else:
                q.put(("config", self.config))
                if peer:
                    peer.put(("phone-status", {"connected": True}))
                    q.put(("peer-ready", {}))
        log("Page", "présentation" if role == "presenter" else "téléphone", "connectée")
        return q

    def detach(self, role, q):
        with self.lock:
            if self.chan[role] is not q:
                return  # déjà remplacé par un client plus récent
            self.chan[role] = None
            peer = self.chan[self.other(role)]
            if role == "phone" and peer:
                peer.put(("phone-status", {"connected": False}))
        log("Page", "présentation" if role == "presenter" else "téléphone", "déconnectée")

    def relay(self, role, msg):
        kind = msg.get("type")
        with self.lock:
            peer = self.chan[self.other(role)]
            if not peer:
                return
            if kind in RELAYED:
                peer.put((kind, msg))
            elif kind == "renegotiate" and role == "presenter":
                peer.put(("peer-ready", {}))  # demande au téléphone de refaire une offre


# --------------------------------------------------------------------------
# Serveurs HTTP
# --------------------------------------------------------------------------
class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, role, web_root, hub, ssl_ctx=None, token=None):
        super().__init__(addr, Handler)
        self.role, self.web_root, self.hub, self.ssl_ctx, self.token = role, web_root, hub, ssl_ctx, token

    def process_request_thread(self, request, client_address):
        # Le handshake TLS se fait ici (dans le thread du client) et non dans
        # accept(), pour qu'un client lent ne bloque pas tout le serveur.
        if self.ssl_ctx:
            try:
                request = self.ssl_ctx.wrap_socket(request, server_side=True)
            except (ssl.SSLError, OSError):  # ex. téléphone qui refuse le certificat
                self.shutdown_request(request)
                return
        super().process_request_thread(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CameraPresentation"

    def log_message(self, fmt, *args):
        pass

    # -- utilitaires -------------------------------------------------------
    def _reply(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if code >= 400:  # corps de requête peut-être non lu : on ne réutilise pas la connexion
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _authorized(self):
        s = self.server
        if s.role == "presenter":
            return self.client_address[0] in ("127.0.0.1", "::1")
        token = parse_qs(urlparse(self.path).query).get("t", [""])[0]
        return secrets.compare_digest(token, s.token)

    # -- routes ------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/events":
            return self._events()
        self._static(path)

    do_HEAD = do_GET

    def do_POST(self):
        if urlparse(self.path).path != "/signal" or not self._authorized():
            return self._reply(403, b"forbidden")
        # Content-Type JSON obligatoire : empêche un site tiers d'envoyer des
        # POST "à l'aveugle" vers localhost (cela déclencherait un preflight CORS).
        if "application/json" not in self.headers.get("Content-Type", ""):
            return self._reply(415, b"json only")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 200_000:
                return self._reply(413, b"too large")
            msg = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            return self._reply(400, b"bad json")
        self.server.hub.relay(self.server.role, msg)
        self._reply(204)

    def _events(self):
        if not self._authorized():
            return self._reply(403, b"forbidden")
        hub, role = self.server.hub, self.server.role
        q = hub.attach(role)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(b"retry: 1000\n\n")
            while True:
                try:
                    item = q.get(timeout=3)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")  # détecte aussi les clients partis
                    continue
                if item is None:
                    break
                event, data = item
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
        except (OSError, ssl.SSLError):
            pass
        finally:
            hub.detach(role, q)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        if path.startswith("/vendor/"):
            base, rel = os.path.join(WEB, "vendor"), path[len("/vendor/"):]
        else:
            base, rel = self.server.web_root, path.lstrip("/")
        base = os.path.realpath(base)
        full = os.path.realpath(os.path.join(base, rel))
        if not full.startswith(base + os.sep) or not os.path.isfile(full):
            return self._reply(404, b"not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._reply(200, f.read(), ctype)


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Présentation HTML + retour caméra du téléphone (WebRTC)")
    ap.add_argument("--res", choices=RESOLUTIONS, default="1080p", help="résolution demandée au téléphone (défaut 1080p)")
    ap.add_argument("--fps", type=int, default=30, help="images/seconde demandées (défaut 30)")
    ap.add_argument("--bitrate", type=float, default=16, help="débit vidéo max en Mb/s (défaut 16)")
    ap.add_argument("--codec", choices=["h264", "vp8", "vp9", "av1", "auto"], default="h264",
                    help="codec préféré (défaut h264 : encodage matériel sur la plupart des téléphones)")
    ap.add_argument("--ip", help="forcer l'adresse IP du PC dans le QR code")
    ap.add_argument("--http-port", type=int, default=8080, help="port de la présentation (127.0.0.1 uniquement)")
    ap.add_argument("--https-port", type=int, default=8443, help="port HTTPS pour le téléphone")
    ap.add_argument("--token", help="jeton du QR code (aléatoire par défaut)")
    ap.add_argument("--no-open", action="store_true", help="ne pas ouvrir le navigateur automatiquement")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    candidates = lan_candidates()
    if args.ip:
        ip = args.ip
    elif candidates:
        ip = candidates[0][1]
    else:
        sys.exit("Aucune adresse IP de réseau local trouvée. Connecte le PC au Wi-Fi ou utilise --ip <adresse>.")

    width, height = RESOLUTIONS[args.res]
    config = {"width": width, "height": height, "fps": args.fps, "bitrateMbps": args.bitrate, "codec": args.codec}
    token = args.token or secrets.token_urlsafe(6)
    phone_url = f"https://{ip}:{args.https_port}/?t={token}"
    present_url = f"http://127.0.0.1:{args.http_port}/"

    hub = Hub(config, phone_url)
    crt, key = ensure_cert([i for _, i in candidates] + [ip])
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)

    try:
        presenter = Server(("127.0.0.1", args.http_port), "presenter", os.path.join(WEB, "presenter"), hub)
        phone = Server(("0.0.0.0", args.https_port), "phone", os.path.join(WEB, "phone"), hub, ssl_ctx=ctx, token=token)
    except OSError as e:
        sys.exit(f"Impossible d'ouvrir les ports ({e}). Un autre serveur tourne peut-être déjà ? Essaie --http-port / --https-port.")

    print()
    print("  Présentation (sur ce PC) :", present_url)
    print("  Page téléphone           :", phone_url)
    print(f"  Qualité demandée         : {args.res} @ {args.fps} fps, {args.bitrate:g} Mb/s max, codec {args.codec}")
    if len(candidates) > 1 or args.ip:
        print("  Interfaces réseau vues   :", ", ".join(f"{n}={i}" for n, i in candidates) or "-")
        print("  (mauvaise IP dans le QR code ? relance avec --ip <adresse>)")
    print("\n  Ctrl+C pour arrêter.\n")

    threading.Thread(target=presenter.serve_forever, daemon=True).start()
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(present_url)).start()
    try:
        phone.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")


if __name__ == "__main__":
    main()
