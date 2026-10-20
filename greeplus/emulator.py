"""A small in-process Gree unit emulator.

It implements the same UDP exchange as the real hardware (scan, bind, status,
cmd) and is used by the test suite and by ``gree.py web --demo`` so the UI can
be tried without an air conditioner on the network.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
import time
from typing import Any, Dict, Optional

from .crypto import GENERIC_KEY_V1, GENERIC_KEY_V2, CipherV1, CipherV2
from .packets import PORT, canonical_mac, parse_envelope

_LOGGER = logging.getLogger(__name__)

DEFAULT_STATE: Dict[str, Any] = {
    "Pow": 0,
    "Mod": 1,
    "SetTem": 24,
    "TemSen": 66,  # 26 C with the usual +40 offset
    "TemUn": 0,
    "TemRec": 0,
    "WdSpd": 0,
    "Air": 0,
    "Blo": 0,
    "Health": 0,
    "SwhSlp": 0,
    "SlpMod": 0,
    "Lig": 1,
    "SwingLfRig": 0,
    "SwUpDn": 0,
    "Quiet": 0,
    "Tur": 0,
    "StHt": 0,
    "SvSt": 0,
    "HeatCoolType": 0,
    "DwatSen": 0,
    "Dfltr": 0,
    "DwatFul": 0,
    "Dmod": 0,
    "Dwet": 0,
}


class GreeEmulator:
    """Fake unit listening on UDP 7000."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = PORT,
        mac: str = "502cc6aabbcc",
        name: str = "Sala (emulador)",
        model: str = "Gree Emulator",
        firmware: str = "V1.1.13",
        protocol: str = "v1",
        key: str = "TestKey123456789",
        state: Optional[Dict[str, Any]] = None,
        require_scan: bool = False,
    ) -> None:
        self.host = host
        self.port = port
        self.mac = canonical_mac(mac) or mac
        self.name = name
        self.model = model
        self.firmware = firmware
        self.protocol = protocol if protocol in ("v1", "v2") else "v1"
        self.key = key.encode() if isinstance(key, str) else key
        self.state = dict(DEFAULT_STATE)
        if state:
            self.state.update(state)
        self.requests = 0
        # Alguns firmwares só aceitam o bind vindo da mesma porta que fez o scan.
        self.require_scan = require_scan
        self._scanned: set = set()
        self._sock: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # -- lifecycle -------------------------------------------------------

    def start(self) -> "GreeEmulator":
        if self._thread and self._thread.is_alive():
            return self
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.host, self.port))
        self._sock.settimeout(0.4)
        self._stop.clear()
        self._thread = threading.Thread(target=self._serve, name="gree-emulator", daemon=True)
        self._thread.start()
        _LOGGER.info("emulator listening on %s:%s (%s)", self.host, self.port, self.protocol)
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None
        if self._sock:
            try:
                self._sock.close()
            finally:
                self._sock = None

    def __enter__(self) -> "GreeEmulator":
        return self.start()

    def __exit__(self, *exc_info) -> None:
        self.stop()

    # -- protocol --------------------------------------------------------

    def _generic_cipher(self):
        return CipherV1(GENERIC_KEY_V1) if self.protocol == "v1" else CipherV2(GENERIC_KEY_V2)

    def _device_cipher(self):
        return CipherV1(self.key) if self.protocol == "v1" else CipherV2(self.key)

    def _seal(self, inner: Dict[str, Any], cipher) -> Dict[str, Any]:
        envelope: Dict[str, Any] = {
            "cid": self.mac,
            "t": "pack",
            "i": inner.get("i", 0),
            "uid": 0,
            "tcid": "app",
        }
        if isinstance(cipher, CipherV2):
            pack, tag = cipher.encrypt(inner)
            envelope["pack"] = pack
            envelope["tag"] = tag
        else:
            envelope["pack"] = cipher.encrypt(inner)
        return envelope

    def _dev_payload(self) -> Dict[str, Any]:
        return {
            "t": "dev",
            "cid": self.mac,
            "mac": self.mac,
            "bc": "gree",
            "brand": "gree",
            "catalog": "gree",
            "mid": "10001",
            "model": self.model,
            "name": self.name,
            "series": "gree",
            "vender": "1",
            "ver": self.firmware,
            "lock": 0,
        }

    def handle(self, data: bytes, address) -> Optional[Dict[str, Any]]:
        """Process one datagram; returns the reply envelope (or None)."""
        try:
            obj = parse_envelope(data)
        except Exception:
            return None

        if obj.get("t") == "scan":
            self._scanned.add(address)
            return self._seal(self._dev_payload(), self._generic_cipher())

        encrypted = obj.get("pack")
        if not isinstance(encrypted, str):
            return None

        tag = obj.get("tag")
        inner = None
        cipher_used = None
        # The unit accepts its session key once bound; before that (and for
        # repeated pairing attempts) the generic key is used.
        for cipher in (self._device_cipher(), self._generic_cipher()):
            try:
                inner = cipher.decrypt(encrypted, tag) if isinstance(cipher, CipherV2) else cipher.decrypt(encrypted)
                cipher_used = cipher
                break
            except Exception:
                continue
        if not isinstance(inner, dict):
            return None

        kind = str(inner.get("t", "")).lower()

        if kind == "bind" and self.require_scan and address not in self._scanned:
            _LOGGER.debug("bind de %s ignorado (sem scan na mesma sessão)", address)
            return None

        self.requests += 1

        if kind == "bind":
            reply = {"t": "bindok", "mac": self.mac, "key": self.key.decode(), "r": 200}
            # Bind replies travel under the generic key.
            return self._seal(reply, self._generic_cipher())

        if kind == "status":
            with self._lock:
                cols = inner.get("cols") or []
                dat = [self.state[c] for c in cols if c in self.state]
                cols = [c for c in cols if c in self.state]
            reply = {"t": "dat", "mac": self.mac, "cols": cols, "dat": dat}
            return self._seal(reply, cipher_used or self._device_cipher())

        if kind == "cmd":
            opts = inner.get("opt") or []
            values = inner.get("p") or []
            with self._lock:
                for name, value in zip(opts, values):
                    if name == "BuzzerCtrl":
                        continue
                    self.state[name] = value
                echoed = [self.state.get(name) for name in opts if name in self.state]
                names = [name for name in opts if name in self.state]
            reply = {"t": "res", "mac": self.mac, "opt": names, "val": echoed, "r": 200}
            return self._seal(reply, cipher_used or self._device_cipher())

        return None

    def _serve(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data, address = self._sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                reply = self.handle(data, address)
                if reply is not None:
                    self._sock.sendto(json.dumps(reply).encode(), address)
            except Exception as exc:  # noqa: BLE001 - the emulator must keep serving
                _LOGGER.warning("emulator error: %s", exc)


def run_emulator(host: str = "0.0.0.0", port: int = PORT, protocol: str = "v1") -> None:
    emulator = GreeEmulator(host=host, port=port, protocol=protocol).start()
    print(f"Emulador Gree escutando em udp://{host}:{port} (protocolo {protocol.upper()})")
    print("Pare com Ctrl+C.")
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        emulator.stop()
        print("\nEmulador encerrado.")
