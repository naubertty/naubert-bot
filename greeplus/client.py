"""UDP client for Gree / EWPE air conditioners.

Flow used by the official app and reproduced here:

1. ``scan``   - broadcast a plain ``{"t": "scan"}``; units answer with a
                ``pack`` envelope encrypted under the generic V1 (or V2) key.
2. ``bind``   - ask the unit for its own session key; the reply is still
                encrypted under the generic key.
3. ``status`` - poll properties; encrypted with the unit key.
4. ``cmd``    - change properties; encrypted with the unit key.
"""

from __future__ import annotations

import json
import logging
import socket
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .crypto import GENERIC_KEY_V1, GENERIC_KEY_V2, CipherV1, CipherV2, make_cipher
from .packets import (
    DEFAULT_STATUS_COLUMNS,
    PORT,
    DeviceInfo,
    Packet,
    build_envelope,
    build_scan,
    canonical_mac,
    command_to_dict,
    decode_packet,
    key_bytes,
    status_to_dict,
)

_LOGGER = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 4.0
DEFAULT_PROBE_TIMEOUT = 1.5


class GreeError(RuntimeError):
    """Base error for local Gree communication."""


class GreeTimeout(GreeError):
    """The unit did not answer in time."""


class BindError(GreeError):
    """The unit rejected the bind request or returned an invalid key."""


# ---------------------------------------------------------------------------
# Network helpers
# ---------------------------------------------------------------------------


def local_ip() -> Optional[str]:
    """Best-effort discovery of the LAN address used for outbound traffic."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 53))
        address = sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()
    return None if address.startswith("127.") else address


def broadcast_targets() -> List[str]:
    """Global broadcast plus the local /24 broadcast (works on most home LANs)."""
    targets = ["255.255.255.255"]
    address = local_ip()
    if address:
        parts = address.split(".")
        if len(parts) == 4:
            targets.append(".".join(parts[:3] + ["255"]))
    return targets


def _open_socket(timeout: float) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(timeout)
    try:
        sock.bind(("", 0))
    except OSError:
        pass
    return sock


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _device_from_packet(packet: Packet, address: Tuple[str, int]) -> Optional[DeviceInfo]:
    payload = packet.payload
    mac = canonical_mac(payload.get("mac") or payload.get("cid") or packet.envelope.get("cid"))
    if mac is None:
        return None
    if payload.get("t") not in (None, "dev") and "name" not in payload and "model" not in payload:
        # Not a discovery answer (could be a stray status reply).
        return None
    return DeviceInfo(
        ip=address[0],
        port=address[1] or PORT,
        mac=mac,
        name=payload.get("name"),
        brand=payload.get("brand"),
        model=payload.get("model"),
        version=payload.get("ver"),
        mid=str(payload["mid"]) if payload.get("mid") is not None else None,
        protocol=packet.protocol,
    )


def scan(
    targets: Optional[Sequence[str]] = None,
    timeout: float = 3.0,
    port: int = PORT,
) -> List[DeviceInfo]:
    """Discover units on the LAN.

    Args:
        targets: IPs or broadcast addresses to probe. Defaults to the global
            broadcast plus the local /24 broadcast.
        timeout: How long to wait for answers.
        port: Device UDP port (always 7000 in practice).
    """
    destinations = list(targets) if targets else broadcast_targets()
    deadline = time.monotonic() + timeout
    found: Dict[str, DeviceInfo] = {}
    request = json.dumps(build_scan()).encode()

    sock = _open_socket(min(0.5, timeout))
    try:
        for destination in destinations:
            try:
                sock.sendto(request, (destination, port))
                _LOGGER.debug("scan -> %s:%s", destination, port)
            except OSError as exc:
                _LOGGER.debug("scan to %s failed: %s", destination, exc)

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, address = sock.recvfrom(65535)
            except socket.timeout:
                break
            except OSError as exc:
                _LOGGER.debug("scan receive failed: %s", exc)
                break
            try:
                packet = decode_packet(data, CipherV1(GENERIC_KEY_V1), allow_key=CipherV2(GENERIC_KEY_V2))
            except Exception as exc:  # noqa: BLE001 - stray traffic is expected
                _LOGGER.debug("ignoring undecodable scan reply from %s: %s", address, exc)
                continue
            info = _device_from_packet(packet, address)
            if info and info.mac not in found:
                found[info.mac] = info
                _LOGGER.debug("found %s at %s", info.mac, info.ip)
    finally:
        sock.close()

    return list(found.values())


def discover(ip: str, timeout: float = 3.0, attempts: int = 2, port: int = PORT) -> Optional[DeviceInfo]:
    """Unicast scan of a single address (works across VLANs and on loopback)."""
    for attempt in range(attempts):
        devices = scan([ip], timeout=timeout, port=port)
        if devices:
            return devices[0]
        if attempt + 1 < attempts:
            time.sleep(0.2)
    return None


# ---------------------------------------------------------------------------
# Device client
# ---------------------------------------------------------------------------


class GreeClient:
    """Talks to one unit. Reuse the instance for status/cmd after binding."""

    def __init__(
        self,
        ip: str,
        port: int = PORT,
        mac: Optional[str] = None,
        key: Optional[str] = None,
        name: Optional[str] = None,
        model: Optional[str] = None,
        version: Optional[str] = None,
        mid: Optional[str] = None,
        protocol: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        probe_timeout: float = DEFAULT_PROBE_TIMEOUT,
        retries: int = 2,
    ) -> None:
        self.info = DeviceInfo(
            ip=ip,
            port=port,
            mac=canonical_mac(mac),
            name=name,
            model=model,
            version=version,
            mid=mid,
            protocol=protocol if protocol in ("v1", "v2") else None,
        )
        self.timeout = timeout
        self.probe_timeout = probe_timeout
        self.retries = max(1, retries)
        self.key: Optional[bytes] = key_bytes(key) if key else None
        self.protocol = protocol if protocol in ("v1", "v2") else None
        self._bound = bool(key and self.info.mac)

    # -- helpers ---------------------------------------------------------

    @property
    def mac(self) -> Optional[str]:
        return self.info.mac

    @property
    def ip(self) -> str:
        return self.info.ip

    def _cipher_for(self, version: str, use_device_key: bool = True):
        cipher = make_cipher(version)
        if use_device_key and self.key:
            cipher.key = self.key
        return cipher

    def _exchange(
        self,
        build_inner,
        expected: Iterable[str],
        index: int = 0,
        versions: Optional[Sequence[str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        use_device_key: bool = True,
    ) -> Tuple[Dict[str, Any], str]:
        """Send a request and return (payload, protocol_version)."""
        expected_kinds = {kind.lower() for kind in expected}
        candidates = list(versions or ([self.protocol] if self.protocol else ["v1", "v2"]))
        attempts = retries or self.retries
        last_error: Optional[Exception] = None

        for attempt in range(attempts):
            for version in candidates:
                cipher = self._cipher_for(version, use_device_key)
                envelope = build_envelope(cipher, self.info.mac, build_inner(), index=index)
                data = json.dumps(envelope).encode()
                wait = timeout if timeout is not None else self.timeout
                sock = _open_socket(min(wait, 2.0))
                try:
                    sock.sendto(data, (self.info.ip, self.info.port))
                    _LOGGER.debug("-> %s:%s %s", self.info.ip, self.info.port, envelope)
                    deadline = time.monotonic() + wait
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        sock.settimeout(remaining)
                        try:
                            reply, address = sock.recvfrom(65535)
                        except socket.timeout:
                            break
                        try:
                            packet = decode_packet(reply, cipher, allow_key=self._fallback_cipher(version))
                        except Exception as exc:  # noqa: BLE001
                            _LOGGER.debug("ignoring packet from %s: %s", address, exc)
                            continue
                        if packet.kind in expected_kinds:
                            _LOGGER.debug("<- %s:%s %s", address[0], address[1], packet.payload)
                            return packet.payload, packet.protocol or version
                        _LOGGER.debug("ignoring unexpected packet type %r", packet.kind)
                finally:
                    sock.close()
                last_error = GreeTimeout(f"no {sorted(expected_kinds)} reply from {self.info.ip}")
            if attempt + 1 < attempts:
                time.sleep(0.25)
        raise GreeTimeout(
            f"sem resposta de {self.info.ip}:{self.info.port} "
            f"(tentado {', '.join(candidates)}; verifique Wi-Fi/porta 7000)"
        ) from last_error

    def _fallback_cipher(self, version: str):
        """Allow replies encrypted with the other protocol generation."""
        other = "v2" if version == "v1" else "v1"
        return make_cipher(other, self.key)

    # -- public API ------------------------------------------------------

    def discover(self, timeout: Optional[float] = None) -> DeviceInfo:
        info = discover(self.info.ip, timeout=timeout or max(self.timeout, 3.0), port=self.info.port)
        if info is None:
            raise GreeTimeout(f"nenhum aparelho Gree respondeu em {self.info.ip}")
        self.info.mac = self.info.mac or info.mac
        self.info.name = info.name or self.info.name
        self.info.model = info.model or self.info.model
        self.info.version = info.version or self.info.version
        self.info.mid = info.mid or self.info.mid
        if not self.protocol:
            self.info.protocol = info.protocol
        return info

    def bind(self, mac: Optional[str] = None, protocol: Optional[str] = None) -> str:
        """Ask the unit for its session key (the app calls this "pairing")."""
        if mac:
            self.info.mac = canonical_mac(mac)
        if protocol in ("v1", "v2"):
            self.protocol = protocol
        if not self.info.mac:
            info = self.discover()
            self.info.mac = info.mac
            self.protocol = self.protocol or info.protocol
        if not self.info.mac:
            raise BindError("não foi possível descobrir o MAC do aparelho")

        candidates = [self.protocol] if self.protocol else ["v1", "v2"]
        payload, version = self._exchange(
            lambda: {"mac": self.info.mac, "t": "bind", "uid": 0},
            expected={"bindok"},
            index=1,
            versions=candidates,
            timeout=self.probe_timeout if len(candidates) > 1 else self.timeout,
            retries=2,
            use_device_key=False,
        )
        key = payload.get("key")
        result = payload.get("r")
        if result not in (None, 200):
            raise BindError(f"aparelho recusou o bind (r={result})")
        try:
            raw_key = key_bytes(key)
        except (TypeError, UnicodeEncodeError) as exc:
            raise BindError("aparelho devolveu uma chave inválida") from exc
        if len(raw_key) not in (16, 24, 32):
            raise BindError(f"tamanho de chave inesperado: {len(raw_key)} bytes")

        self.key = raw_key
        self.protocol = version
        self.info.protocol = version
        self.info.mac = canonical_mac(payload.get("mac")) or self.info.mac
        self._bound = True
        _LOGGER.info("bound to %s with %s key", self.info.mac, version)
        return raw_key.decode("ascii", "replace")

    def ensure_bound(self) -> None:
        if not self._bound or not self.key:
            self.bind()

    def status(self, columns: Optional[Iterable[str]] = None) -> Dict[str, Any]:
        """Poll the unit and return the raw property dictionary."""
        self.ensure_bound()
        payload, version = self._exchange(
            lambda: {"cols": list(columns or DEFAULT_STATUS_COLUMNS), "mac": self.info.mac, "t": "status"},
            expected={"dat"},
            index=0,
        )
        self.protocol = version
        return status_to_dict(payload)

    def command(self, properties: Dict[str, Any], buzzer: bool = True) -> Dict[str, Any]:
        """Send properties to the unit (``Pow``, ``SetTem``, ...)."""
        if not properties:
            return {}
        self.ensure_bound()
        outgoing = dict(properties)
        # The app always sends this field; newer firmware uses it to silence
        # the unit's beep. Harmless on older firmware.
        outgoing.setdefault("BuzzerCtrl", 1 if buzzer else 0)
        payload, version = self._exchange(
            lambda: {"opt": list(outgoing.keys()), "p": list(outgoing.values()), "mac": self.info.mac, "t": "cmd"},
            expected={"res"},
            index=0,
        )
        self.protocol = version
        result = command_to_dict(payload)
        code = payload.get("r")
        if code not in (None, 200) and not result:
            raise GreeError(f"aparelho recusou o comando (r={code})")
        return result

    def close(self) -> None:
        """Kept for API symmetry; sockets are opened per request."""

    def __enter__(self) -> "GreeClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()
