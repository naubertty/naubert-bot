"""Packet construction/parsing for the Gree local protocol (UDP 7000).

Every exchange is a JSON envelope. Requests look like::

    {"cid": "app", "i": 0, "t": "pack", "uid": 0, "tcid": "<mac>",
     "pack": "<base64 ciphertext>"}

and the ciphertext contains the actual command::

    {"t": "status", "mac": "<mac>", "cols": ["Pow", "Mod", ...]}

The reply uses the same shape, with the decrypted payload carrying the answer.
Protocol V2 adds a ``tag`` field next to ``pack`` (AES-GCM authentication tag).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Optional

from .crypto import GENERIC_KEY_V1, GENERIC_KEY_V2, CipherV2, make_cipher

PORT = 7000

# Properties requested on every status poll. Not every unit knows all of them;
# unknown columns are simply left out of the reply.
DEFAULT_STATUS_COLUMNS = [
    "Pow",
    "Mod",
    "SetTem",
    "TemSen",
    "TemUn",
    "TemRec",
    "WdSpd",
    "Air",
    "Blo",
    "Health",
    "SwhSlp",
    "SlpMod",
    "Lig",
    "SwingLfRig",
    "SwUpDn",
    "Quiet",
    "Tur",
    "StHt",
    "SvSt",
    "HeatCoolType",
    "DwatSen",
    "Dfltr",
    "DwatFul",
    "Dmod",
    "Dwet",
]


class ProtocolError(Exception):
    """Raised when a device reply cannot be understood."""


def canonical_mac(value: Optional[str]) -> Optional[str]:
    """Normalise a MAC to 12 lowercase hex digits, or return None."""
    if not value:
        return None
    digits = re.sub(r"[^0-9a-fA-F]", "", str(value)).lower()
    if len(digits) != 12:
        return None
    return digits


def format_mac(mac: str) -> str:
    mac = canonical_mac(mac) or mac
    return ":".join(mac[i : i + 2] for i in range(0, 12, 2)).upper()


def key_bytes(key: Any) -> bytes:
    """Accept str/bytes keys and return the raw AES key bytes."""
    if isinstance(key, bytes):
        return key
    if not isinstance(key, str):
        raise TypeError("key must be str or bytes")
    return key.encode("ascii")


@dataclass
class DeviceInfo:
    """A unit found on the network (or reconstructed from a saved config)."""

    ip: str
    port: int = PORT
    mac: Optional[str] = None
    name: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    version: Optional[str] = None
    mid: Optional[str] = None
    protocol: Optional[str] = None  # "v1" or "v2" when known

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ip": self.ip,
            "port": self.port,
            "mac": self.mac,
            "name": self.name,
            "brand": self.brand,
            "model": self.model,
            "version": self.version,
            "mid": self.mid,
            "protocol": self.protocol,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DeviceInfo":
        allowed = {f: data.get(f) for f in cls.__dataclass_fields__ if f in data}
        return cls(**allowed)

    @property
    def display_name(self) -> str:
        return self.name or (f"Gree {self.model}" if self.model else f"Gree {self.mac or self.ip}")


@dataclass
class Packet:
    """A decoded envelope plus its decrypted payload."""

    envelope: Dict[str, Any]
    payload: Dict[str, Any] = field(default_factory=dict)
    protocol: Optional[str] = None

    @property
    def kind(self) -> Optional[str]:
        value = self.payload.get("t")
        return value.lower() if isinstance(value, str) else None


def build_envelope(cipher, mac: Optional[str], inner: Dict[str, Any], index: int = 0) -> Dict[str, Any]:
    """Encrypt `inner` and wrap it in the transport envelope."""
    envelope: Dict[str, Any] = {
        "cid": "app",
        "i": index,
        "t": "pack",
        "uid": 0,
        "tcid": mac or "",
    }
    if isinstance(cipher, CipherV2):
        pack, tag = cipher.encrypt(inner)
        envelope["pack"] = pack
        envelope["tag"] = tag
    else:
        envelope["pack"] = cipher.encrypt(inner)
    return envelope


def build_scan() -> Dict[str, Any]:
    return {"t": "scan"}


def build_bind(mac: str, cipher=None) -> Dict[str, Any]:
    inner = {"mac": mac, "t": "bind", "uid": 0}
    return build_envelope(cipher or make_cipher("v1", GENERIC_KEY_V1), mac, inner, index=1)


def build_status(mac: str, cipher, columns: Optional[Iterable[str]] = None) -> Dict[str, Any]:
    inner = {
        "cols": list(columns or DEFAULT_STATUS_COLUMNS),
        "mac": mac,
        "t": "status",
    }
    return build_envelope(cipher, mac, inner, index=0)


def build_command(mac: str, cipher, properties: Dict[str, Any]) -> Dict[str, Any]:
    inner = {
        "opt": list(properties.keys()),
        "p": list(properties.values()),
        "mac": mac,
        "t": "cmd",
    }
    return build_envelope(cipher, mac, inner, index=0)


def parse_envelope(data: bytes) -> Dict[str, Any]:
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid JSON from device: {exc}") from exc
    if not isinstance(obj, dict):
        raise ProtocolError("device sent a non-object JSON payload")
    return obj


def decrypt_packet(packet: Packet, cipher) -> Packet:
    """Decrypt ``pack`` in place using `cipher` (raises on failure)."""
    encrypted = packet.envelope.get("pack")
    if not isinstance(encrypted, str):
        raise ProtocolError("envelope has no encrypted pack")
    tag = packet.envelope.get("tag")
    if isinstance(cipher, CipherV2):
        packet.payload = cipher.decrypt(encrypted, tag)
    else:
        packet.payload = cipher.decrypt(encrypted)
    packet.protocol = cipher.version
    if not isinstance(packet.payload, dict):
        raise ProtocolError("decrypted pack is not an object")
    return packet


def decode_packet(data: bytes, cipher, allow_key=None) -> Packet:
    packet = Packet(parse_envelope(data))
    try:
        decrypt_packet(packet, cipher)
        return packet
    except Exception:
        if allow_key is None:
            raise
    # Used during discovery: a reply may be V1 or V2 encrypted.
    if isinstance(cipher, CipherV2):
        raise ProtocolError("could not decrypt packet")
    fallback = CipherV2(GENERIC_KEY_V2)
    return decrypt_packet(packet, fallback)


def status_to_dict(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Turn a ``dat`` reply into an ordered property dictionary."""
    columns = payload.get("cols") or []
    values = payload.get("dat")
    if values is None:
        values = []
    if not isinstance(values, list):
        values = [values]
    return dict(zip(columns, values))


def command_to_dict(payload: Dict[str, Any]) -> Dict[str, Any]:
    keys = payload.get("opt") or payload.get("p") or []
    values = payload.get("val")
    if values is None:
        values = payload.get("p") or []
    return dict(zip(keys, values if isinstance(values, list) else [values]))
