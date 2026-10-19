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
import select
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
    normalize_ip,
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


def local_addresses() -> List[str]:
    """IPv4 addresses of this machine (best effort, sem dependências)."""
    addresses: List[str] = []
    address = local_ip()
    if address:
        addresses.append(address)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidate = info[4][0]
            if candidate not in addresses and not candidate.startswith("169.254."):
                addresses.append(candidate)
    except OSError:
        pass
    return addresses


def subnet_prefix(address: Optional[str] = None) -> Optional[str]:
    """Primeiros três octetos da rede local (ex.: "192.168.1")."""
    address = address or local_ip()
    if not address:
        return None
    parts = address.split(".")
    if len(parts) != 4:
        return None
    return ".".join(parts[:3])


def icmp_ping(ip: str, timeout: float = 1.5) -> Optional[bool]:
    """Ping simples via sistema. None quando não foi possível testar."""
    import platform
    import subprocess

    if platform.system() == "Windows":
        command = ["ping", "-n", "1", "-w", str(int(timeout * 1000)), ip]
    else:
        command = ["ping", "-c", "1", "-W", str(max(1, int(timeout))), ip]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout + 2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.returncode == 0


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
    sweep: bool = False,
    sweep_timeout: float = 2.0,
    stats: Optional[Dict[str, int]] = None,
) -> List[DeviceInfo]:
    """Discover units on the LAN.

    Args:
        targets: IPs or broadcast addresses to probe. Defaults to the global
            broadcast plus the local /24 broadcast.
        timeout: How long to wait for answers.
        port: Device UDP port (always 7000 in practice).
        sweep: When the broadcast finds nothing, probe every host of the local
            /24 with unicast (some routers drop broadcast between Wi-Fi/LAN).
        sweep_timeout: How long the unicast sweep listens for answers.
        stats: Optional counter dict updated with received/decoded packet counts.
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
            if stats is not None:
                stats["received"] = stats.get("received", 0) + 1
            try:
                packet = decode_packet(data, CipherV1(GENERIC_KEY_V1), allow_key=CipherV2(GENERIC_KEY_V2))
            except Exception as exc:  # noqa: BLE001 - stray traffic is expected
                _LOGGER.debug("ignoring undecodable scan reply from %s: %s", address, exc)
                continue
            if stats is not None:
                stats["decoded"] = stats.get("decoded", 0) + 1
            info = _device_from_packet(packet, address)
            if info and info.mac not in found:
                found[info.mac] = info
                _LOGGER.debug("found %s at %s", info.mac, info.ip)
    finally:
        sock.close()

    if not found and sweep and not targets:
        _LOGGER.info("broadcast sem resposta; varrendo a rede local em unicast")
        return scan_subnet(timeout=sweep_timeout, port=port)

    return list(found.values())


def scan_subnet(
    subnet: Optional[str] = None,
    timeout: float = 2.0,
    port: int = PORT,
    local: Optional[str] = None,
    stats: Optional[Dict[str, int]] = None,
) -> List[DeviceInfo]:
    """Varre a rede /24 em unicast (1..254) à procura de aparelhos.

    Funciona quando o roteador bloqueia broadcast entre Wi-Fi e cabo, e também
    encontra aparelhos cujo IP mudou no DHCP.
    """
    prefix = subnet or subnet_prefix(local)
    if not prefix:
        return []
    prefix = prefix.strip().rstrip("/").split("/")[0].rstrip(".")
    if prefix.count(".") == 3:  # veio um IP completo
        prefix = ".".join(prefix.split(".")[:3])

    # Inclui o próprio endereço: um emulador local também deve ser encontrado.
    hosts = [f"{prefix}.{index}" for index in range(1, 255)]

    request = json.dumps(build_scan()).encode()
    deadline = time.monotonic() + timeout + 0.5
    found: Dict[str, DeviceInfo] = {}

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("", 0))
    except OSError:
        pass
    sock.setblocking(False)
    try:
        for host in hosts:
            try:
                sock.sendto(request, (host, port))
            except OSError as exc:
                _LOGGER.debug("sweep para %s falhou: %s", host, exc)
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                ready, _, _ = select.select([sock], [], [], min(remaining, 0.2))
            except (OSError, ValueError):
                break
            if not ready:
                continue
            try:
                data, address = sock.recvfrom(65535)
            except (BlockingIOError, OSError):
                continue
            if stats is not None:
                stats["received"] = stats.get("received", 0) + 1
            try:
                packet = decode_packet(data, CipherV1(GENERIC_KEY_V1), allow_key=CipherV2(GENERIC_KEY_V2))
            except Exception as exc:  # noqa: BLE001
                _LOGGER.debug("sweep: resposta ilegível de %s: %s", address, exc)
                continue
            if stats is not None:
                stats["decoded"] = stats.get("decoded", 0) + 1
            info = _device_from_packet(packet, address)
            if info and info.mac not in found:
                found[info.mac] = info
                _LOGGER.debug("sweep encontrou %s em %s", info.mac, info.ip)
    finally:
        sock.close()

    return list(found.values())


def scan_raw(
    targets: Optional[Sequence[str]] = None,
    timeout: float = 3.0,
    port: int = PORT,
    repeats: int = 3,
) -> List[Tuple[Tuple[str, int], bytes]]:
    """Envia scans e devolve **todo** datagrama recebido, sem tentar decifrar.

    Serve para separar "o aparelho não está na rede" de "as respostas estão
    sendo bloqueadas/ignoradas": se nada chega aqui, o problema é de rede ou
    firewall, não do protocolo.
    """
    destinations = list(targets) if targets else broadcast_targets()
    request = json.dumps(build_scan()).encode()
    replies: List[Tuple[Tuple[str, int], bytes]] = []

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("", 0))
    except OSError:
        pass
    try:
        deadline = time.monotonic() + timeout
        interval = max(0.4, timeout / (repeats + 1))
        next_send = 0.0
        sent = 0
        while time.monotonic() < deadline:
            now = time.monotonic()
            if sent < repeats and now >= next_send:
                for destination in destinations:
                    try:
                        sock.sendto(request, (destination, port))
                    except OSError as exc:
                        _LOGGER.debug("scan_raw para %s falhou: %s", destination, exc)
                sent += 1
                next_send = now + interval
            sock.settimeout(0.2)
            try:
                data, address = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            replies.append((address, data))
            if len(replies) >= 50:
                break
        return replies
    finally:
        sock.close()


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
            ip=normalize_ip(ip),
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
        """Descobre o aparelho em `ip` (unicast) ou, se ele ignorar unicast,
        procura no broadcast e casa pelo IP/MAC."""
        wait = timeout or max(self.timeout, 3.0)
        info = discover(self.info.ip, timeout=wait, port=self.info.port)
        if info is None:
            # Vários firmwares (ex.: V3.4.M) só respondem ao scan em broadcast.
            for candidate in scan(None, timeout=wait, port=self.info.port):
                if candidate.ip == self.info.ip or (self.info.mac and candidate.mac == self.info.mac):
                    info = candidate
                    break
        if info is None:
            raise GreeTimeout(f"nenhum aparelho Gree respondeu em {self.info.ip}")
        self._absorb(info)
        return info

    def _absorb(self, info: DeviceInfo) -> None:
        self.info.mac = self.info.mac or info.mac
        self.info.name = info.name or self.info.name
        self.info.model = info.model or self.info.model
        self.info.version = info.version or self.info.version
        self.info.mid = info.mid or self.info.mid
        if info.protocol in ("v1", "v2"):
            self.protocol = info.protocol
            self.info.protocol = info.protocol

    def bind(self, mac: Optional[str] = None, protocol: Optional[str] = None) -> str:
        """Pareia com o aparelho e devolve a chave local dele.

        O bind roda em **uma única sessão UDP**, precedido de um scan enviado
        pelo mesmo socket: firmwares recentes (ex.: V3.4.M) ignoram o bind que
        chega de outra porta e podem ignorar o scan em unicast.
        """
        if mac:
            self.info.mac = canonical_mac(mac)
        if protocol in ("v1", "v2"):
            self.protocol = protocol
        if not self.info.mac:
            info = self.discover()
            self._absorb(info)
        if not self.info.mac:
            raise BindError("não foi possível descobrir o MAC do aparelho")

        sock = _open_socket(2.0)
        try:
            self._prime_session(sock)
            if not self.info.mac:
                raise BindError("o aparelho não informou o MAC durante a descoberta")
            payload, version = self._bind_on_socket(sock)
        finally:
            sock.close()

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

    def _prime_session(self, sock: socket.socket) -> None:
        """Envia scan pelo mesmo socket e confirma MAC/IP/protocolo.

        Alguns firmwares (ex.: V3.4.M) só respondem ao scan em **broadcast** e
        recusam o bind que não venha da mesma sessão UDP. Por isso mandamos o
        scan para o IP do aparelho e também para os endereços de broadcast.
        """
        request = json.dumps(build_scan()).encode()
        destinations = [self.info.ip] + [addr for addr in broadcast_targets() if addr != self.info.ip]
        for destination in destinations:
            try:
                sock.sendto(request, (destination, self.info.port))
                _LOGGER.debug("session prime: scan -> %s:%s", destination, self.info.port)
            except OSError as exc:
                _LOGGER.debug("session prime para %s falhou: %s", destination, exc)

        expected_mac = self.info.mac
        seen: List[DeviceInfo] = []
        deadline = time.monotonic() + max(self.probe_timeout, 2.0)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                reply, address = sock.recvfrom(65535)
            except socket.timeout:
                break
            except OSError:
                break
            try:
                packet = decode_packet(reply, CipherV1(GENERIC_KEY_V1), allow_key=CipherV2(GENERIC_KEY_V2))
            except Exception:  # noqa: BLE001 - pacotes alheios são esperados
                continue
            info = _device_from_packet(packet, address)
            if not info:
                continue
            seen.append(info)
            if expected_mac and info.mac != expected_mac:
                continue
            self._absorb(info)
            # O aparelho respondeu deste endereço: é para cá que o bind vai.
            self.info.ip = info.ip
            _LOGGER.debug("session prime: %s respondeu de %s (%s)", info.mac, info.ip, info.protocol)
            return

        if seen and not expected_mac:
            self._absorb(seen[0])
            self.info.ip = seen[0].ip

    def _bind_on_socket(self, sock: socket.socket) -> Tuple[Dict[str, Any], str]:
        preferred = self.protocol if self.protocol in ("v1", "v2") else "v1"
        candidates = [preferred, "v2" if preferred == "v1" else "v1"]
        last_error: Optional[Exception] = None

        for attempt in range(2):
            for version in candidates:
                cipher = make_cipher(version)  # chave genérica, nunca a do aparelho
                inner = {"mac": self.info.mac, "t": "bind", "uid": 0}
                envelope = build_envelope(cipher, self.info.mac, inner, index=1)
                data = json.dumps(envelope).encode()
                wait = self.probe_timeout + attempt
                try:
                    sock.sendto(data, (self.info.ip, self.info.port))
                except OSError as exc:
                    last_error = exc
                    continue
                _LOGGER.debug("bind (%s) -> %s:%s", version, self.info.ip, self.info.port)

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
                    except OSError as exc:
                        last_error = exc
                        break
                    try:
                        packet = decode_packet(
                            reply, cipher, allow_key=make_cipher("v2" if version == "v1" else "v1")
                        )
                    except Exception:  # noqa: BLE001
                        continue
                    if packet.kind == "bindok":
                        _LOGGER.debug("bind ok (%s) de %s", packet.protocol, address[0])
                        return packet.payload, packet.protocol or version
                last_error = GreeTimeout(f"bind sem resposta ({version})")

        raise BindError(
            f"o aparelho {self.info.ip} não aceitou o pareamento. "
            "Confirme que ele está ligado e conectado ao Wi-Fi, e tente de novo; "
            "se persistir, use --protocol v2."
        ) from last_error

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
