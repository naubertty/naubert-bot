import json

import pytest

from greeplus.crypto import CipherV1, CipherV2
from greeplus.packets import (
    Packet,
    build_bind,
    build_command,
    build_envelope,
    build_scan,
    build_status,
    canonical_mac,
    command_to_dict,
    decode_packet,
    decrypt_packet,
    format_mac,
    parse_envelope,
    status_to_dict,
)


def test_canonical_mac():
    assert canonical_mac("50:2C:C6:AA:BB:CC") == "502cc6aabbcc"
    assert canonical_mac("502cc6aabbcc") == "502cc6aabbcc"
    assert canonical_mac("502CC6AABBCC") == "502cc6aabbcc"
    assert canonical_mac("nao-e-mac") is None
    assert canonical_mac(None) is None
    assert format_mac("502cc6aabbcc") == "50:2C:C6:AA:BB:CC"


def test_scan_packet_is_plain_json():
    assert build_scan() == {"t": "scan"}


def test_bind_envelope_v1_structure():
    cipher = CipherV1()
    envelope = build_bind("502cc6aabbcc", cipher)
    assert envelope["t"] == "pack"
    assert envelope["cid"] == "app"
    assert envelope["i"] == 1
    assert envelope["tcid"] == "502cc6aabbcc"
    assert envelope["tag"] if "tag" in envelope else True
    inner = cipher.decrypt(envelope["pack"])
    assert inner == {"mac": "502cc6aabbcc", "t": "bind", "uid": 0}


def test_bind_envelope_v2_has_tag():
    cipher = CipherV2()
    envelope = build_bind("502cc6aabbcc", cipher)
    assert "tag" in envelope and envelope["tag"]
    assert cipher.decrypt(envelope["pack"], envelope["tag"])["t"] == "bind"


def test_status_envelope_roundtrip():
    cipher = CipherV1(b"UnitKey123456789")
    envelope = build_status("502cc6aabbcc", cipher, columns=["Pow", "Mod"])
    inner = cipher.decrypt(envelope["pack"])
    assert inner["t"] == "status"
    assert inner["cols"] == ["Pow", "Mod"]
    assert inner["mac"] == "502cc6aabbcc"


def test_command_envelope_roundtrip():
    cipher = CipherV2(b"UnitKey123456789")
    envelope = build_command("502cc6aabbcc", cipher, {"Pow": 1, "SetTem": 22})
    inner = cipher.decrypt(envelope["pack"], envelope["tag"])
    assert inner["t"] == "cmd"
    assert inner["opt"] == ["Pow", "SetTem"]
    assert inner["p"] == [1, 22]


def test_build_envelope_keeps_index():
    cipher = CipherV1()
    assert build_envelope(cipher, "502cc6aabbcc", {"t": "bind"}, index=1)["i"] == 1
    assert build_envelope(cipher, "502cc6aabbcc", {"t": "status"}, index=0)["i"] == 0


def test_decode_packet_falls_back_to_v2():
    payload = {"t": "dev", "mac": "502cc6aabbcc", "name": "Sala"}
    envelope = build_envelope(CipherV2(), "502cc6aabbcc", payload)
    raw = json.dumps(envelope).encode()
    packet = decode_packet(raw, CipherV1(), allow_key=CipherV2())
    assert packet.payload == payload
    assert packet.protocol == "v2"


def test_decode_packet_v1():
    payload = {"t": "dat", "cols": ["Pow"], "dat": [1]}
    raw = json.dumps(build_envelope(CipherV1(), "502cc6aabbcc", payload)).encode()
    packet = decode_packet(raw, CipherV1())
    assert packet.payload == payload
    assert packet.kind == "dat"


def test_decode_packet_rejects_garbage():
    from greeplus.packets import ProtocolError

    with pytest.raises(ProtocolError):
        decode_packet(b"not json", CipherV1())
    with pytest.raises(Exception):
        decode_packet(json.dumps({"t": "pack", "pack": "AAAA"}).encode(), CipherV1())


def test_status_and_command_dicts():
    assert status_to_dict({"cols": ["Pow", "Mod"], "dat": [1, 2]}) == {"Pow": 1, "Mod": 2}
    assert status_to_dict({"cols": ["Pow"], "dat": 1}) == {"Pow": 1}
    assert status_to_dict({"cols": [], "dat": None}) == {}
    assert command_to_dict({"opt": ["Pow"], "val": [1]}) == {"Pow": 1}
    assert command_to_dict({"opt": ["Pow"], "p": [1]}) == {"Pow": 1}


def test_decrypt_packet_requires_pack():
    packet = Packet(parse_envelope(b'{"t":"pack"}'))
    with pytest.raises(Exception):
        decrypt_packet(packet, CipherV1())
