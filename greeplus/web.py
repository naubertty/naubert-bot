"""Interface web local: controle o ar-condicionado pelo navegador do PC.

O servidor roda na sua máquina, fala UDP 7000 com o aparelho e serve uma página
simples em http://localhost:8080. Nenhum dado sai para a internet.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from .cli import friendly_state, load_config, save_config
from .client import GreeClient, GreeError, GreeTimeout, scan
from .emulator import GreeEmulator
from .packets import PORT, DeviceInfo, normalize_ip

_LOGGER = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent


class DeviceSession:
    """Thread-safe bridge between HTTP requests and the UDP device client."""

    def __init__(self, config_file: Optional[str] = None) -> None:
        self.config_file = config_file
        self.lock = threading.RLock()
        self.client: Optional[GreeClient] = None
        self.info: Optional[DeviceInfo] = None
        self.last_error: Optional[str] = None
        self._state_cache: Optional[Dict[str, Any]] = None
        self._state_time = 0.0
        self._recovering = False

    # -- connection ------------------------------------------------------

    def connect(
        self,
        ip: Optional[str] = None,
        key: Optional[str] = None,
        mac: Optional[str] = None,
        protocol: Optional[str] = None,
        port: int = PORT,
        name: Optional[str] = None,
        model: Optional[str] = None,
        version: Optional[str] = None,
        mid: Optional[str] = None,
        bind_if_needed: bool = True,
    ) -> Dict[str, Any]:
        with self.lock:
            ip = normalize_ip(ip)
            if not ip:
                config = load_config(self.config_file)
                ip = config.get("ip", "")
                key = key or config.get("key")
                mac = mac or config.get("mac")
                protocol = protocol or config.get("protocol")
                port = int(config.get("port") or port)
                name = name or config.get("name")
                model = model or config.get("model")
                version = version or config.get("version")
                mid = mid or config.get("mid")
            if not ip:
                raise GreeError("informe o IP do aparelho")

            client = GreeClient(
                ip=ip,
                port=port,
                mac=mac,
                key=key,
                name=name,
                model=model,
                version=version,
                mid=mid,
                protocol=protocol,
                timeout=4.0,
            )
            self.client = client
            self.info = client.info
            self.last_error = None
            try:
                if bind_if_needed and not (key and mac):
                    self._bind_locked()
                self._state_cache = None
                return self._state_locked()
            except Exception:
                # Do not leave a half-connected session behind: the UI will
                # show the connection screen and the next attempt starts clean.
                self.client = None
                self.info = None
                self._state_cache = None
                raise

    def _bind_locked(self) -> None:
        assert self.client is not None
        # Se a busca já devolveu MAC e protocolo, não refazemos a descoberta:
        # o pareamento usa a sessão UDP dele (scan + bind no mesmo socket).
        if not self.client.info.mac or not self.client.protocol:
            try:
                info = self.client.discover(timeout=2.5)
                self.client.info.name = info.name or self.client.info.name
                self.client.info.model = info.model or self.client.info.model
                self.client.info.version = info.version or self.client.info.version
                self.client.info.mid = info.mid or self.client.info.mid
            except GreeError as exc:
                _LOGGER.debug("descoberta prévia falhou: %s", exc)
        key = self.client.bind(mac=self.client.info.mac)
        data = {
            "ip": self.client.info.ip,
            "port": self.client.info.port,
            "mac": self.client.info.mac,
            "key": key,
            "name": self.client.info.name,
            "model": self.client.info.model,
            "version": self.client.info.version,
            "mid": self.client.info.mid,
            "protocol": self.client.protocol,
        }
        save_config(data, self.config_file)
        self.last_error = None

    def disconnect(self) -> None:
        with self.lock:
            self.client = None
            self.info = None
            self._state_cache = None

    # -- operations ------------------------------------------------------

    def _recover_locked(self) -> None:
        """Re-pair when the app generated a new key for the unit."""
        if self._recovering or self.client is None:
            return
        self._recovering = True
        try:
            self.client.key = None
            self.client.protocol = None
            self.client._bound = False
            self._bind_locked()
        finally:
            self._recovering = False

    def _state_locked(self, force: bool = False) -> Dict[str, Any]:
        if self.client is None:
            return {"connected": False}
        now = time.monotonic()
        if not force and self._state_cache and now - self._state_time < 1.0:
            return self._state_cache

        try:
            raw = self.client.status()
            self.last_error = None
        except GreeTimeout:
            # First try to re-pair once, then poll again: the Gree+ app may
            # have rotated the key.
            try:
                self._recover_locked()
                raw = self.client.status()
                self.last_error = None
            except GreeError as exc:
                self.last_error = str(exc)
                raise
        except GreeError as exc:
            self.last_error = str(exc)
            raise

        info = self.client.info
        state = friendly_state(raw)
        payload = {
            "connected": True,
            "device": {
                "ip": info.ip,
                "port": info.port,
                "mac": info.mac,
                "name": info.name,
                "model": info.model,
                "version": info.version,
                "mid": info.mid,
                "protocol": self.client.protocol,
            },
            "state": state,
        }
        self._state_cache = payload
        self._state_time = now
        return payload

    def state(self, force: bool = False) -> Dict[str, Any]:
        with self.lock:
            return self._state_locked(force)

    def send(self, properties: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            if self.client is None:
                raise GreeError("não conectado")
            self.client.command(properties)
            self._state_cache = None
            return self._state_locked(force=True)


class GreeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_handler(session: DeviceSession):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GreePlus"

        # -- utilities -------------------------------------------------

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            _LOGGER.debug("%s - %s", self.address_string(), fmt % args)

        def _send_json(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, message: str, status: int = 400) -> None:
            self._send_json({"ok": False, "error": message}, status)

        def _read_json(self) -> Dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return {}
            return data if isinstance(data, dict) else {}

        # -- routes ----------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            path = parsed.path
            if path in ("/", "/index.html"):
                self._serve_index()
                return
            if path == "/api/health":
                self._send_json({"ok": True, "uptime": time.time()})
                return
            if path == "/api/config":
                config = load_config(session.config_file)
                self._send_json({
                    "ok": True,
                    "config": {k: config.get(k) for k in ("ip", "mac", "name", "protocol")},
                    "connected": session.client is not None,
                })
                return
            if path == "/api/scan":
                query = parse_qs(parsed.query)
                targets = query.get("target") or None
                try:
                    scan_port = int((query.get("port") or [PORT])[0])
                except ValueError:
                    scan_port = PORT
                try:
                    devices = scan(targets, timeout=2.5, port=scan_port)
                except OSError as exc:
                    self._send_error_json(f"falha na busca: {exc}", 500)
                    return
                self._send_json({"ok": True, "devices": [d.to_dict() for d in devices]})
                return
            if path == "/api/state":
                force = parse_qs(parsed.query).get("force", ["0"])[0] == "1"
                try:
                    state = session.state(force=force)
                except GreeError as exc:
                    self._send_error_json(str(exc), 502)
                    return
                self._send_json({"ok": True, **state})
                return
            self._send_error_json("rota não encontrada", 404)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            body = self._read_json()
            try:
                if parsed.path == "/api/connect":
                    state = session.connect(
                        ip=body.get("ip"),
                        key=body.get("key"),
                        mac=body.get("mac"),
                        protocol=body.get("protocol"),
                        port=int(body.get("port") or PORT),
                        bind_if_needed=not body.get("skip_bind"),
                    )
                    self._send_json({"ok": True, **state})
                    return
                if parsed.path == "/api/disconnect":
                    session.disconnect()
                    self._send_json({"ok": True, "connected": False})
                    return
                if parsed.path == "/api/set":
                    props = body.get("props")
                    if not isinstance(props, dict) or not props:
                        self._send_error_json("envie {'props': {...}}")
                        return
                    state = session.send(props)
                    self._send_json({"ok": True, **state})
                    return
            except GreeTimeout as exc:
                self._send_error_json(f"aparelho não respondeu: {exc}", 504)
                return
            except (GreeError, OSError, ValueError) as exc:
                self._send_error_json(str(exc), 502)
                return
            self._send_error_json("rota não encontrada", 404)

        # -- static ----------------------------------------------------

        def _serve_index(self) -> None:
            file = WEB_DIR / "webui.html"
            if not file.is_file():
                self._send_error_json("webui.html não encontrado", 500)
                return
            body = file.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main(args) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    session = DeviceSession(config_file=getattr(args, "config", None))
    emulator: Optional[GreeEmulator] = None

    if getattr(args, "demo", False):
        emulator = GreeEmulator(
            host="127.0.0.1",
            port=7000,
            protocol=getattr(args, "demo_protocol", "v1"),
            name="Sala (demonstração)",
        ).start()
        demo_config = {
            "ip": "127.0.0.1",
            "port": 7000,
            "mac": emulator.mac,
            "name": emulator.name,
            "protocol": emulator.protocol,
        }
        save_config(demo_config, args.config)
        print("Modo demonstração: aparelho emulado em udp://127.0.0.1:7000")

    handler = make_handler(session)
    try:
        httpd = GreeHTTPServer((args.host, args.http_port), handler)
    except OSError as exc:
        if emulator:
            emulator.stop()
        print(f"Não foi possível abrir a porta {args.http_port}: {exc}")
        return 1

    url_host = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{url_host}:{args.http_port}/"
    print(f"Interface pronta em {url}")
    if getattr(args, "demo", False):
        print("Abra a página e conecte no aparelho de demonstração para testar.")
    else:
        print("Busque o aparelho na página (ou deixe o IP salvo em greeplus.json).")

    if getattr(args, "open_browser", False):
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando...")
    finally:
        httpd.server_close()
        if emulator:
            emulator.stop()
    return 0
