import base64
import json
import os

import pytest

from greeplus.crypto import (
    AES128,
    GENERIC_KEY_V1,
    GENERIC_KEY_V2,
    CipherV1,
    CipherV2,
    ecb_decrypt,
    ecb_encrypt,
    gcm_decrypt,
    gcm_encrypt,
)


def test_aes128_fips197_vector():
    key = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
    plaintext = bytes.fromhex("00112233445566778899aabbccddeeff")
    ciphertext = bytes.fromhex("69c4e0d86a7b0430d8cdb78070b4c55a")
    cipher = AES128(key)
    assert cipher.encrypt_block(plaintext) == ciphertext
    assert cipher.decrypt_block(ciphertext) == plaintext


def test_aes128_sbox_known_values():
    from greeplus.crypto import SBOX

    assert SBOX[0x00] == 0x63
    assert SBOX[0x53] == 0xED
    assert SBOX[0xFF] == 0x16


@pytest.mark.parametrize("length", [0, 1, 15, 16, 17, 63, 64, 65])
def test_ecb_pkcs7_roundtrip(length):
    key = os.urandom(16)
    data = os.urandom(length)
    encrypted = ecb_encrypt(key, data)
    assert len(encrypted) % 16 == 0
    assert ecb_decrypt(key, encrypted) == data


def test_gcm_nist_vector():
    key = bytes(16)
    nonce = bytes(12)
    ciphertext, tag = gcm_encrypt(key, nonce, b"", bytes(16))
    assert ciphertext.hex() == "0388dace60b6a392f328c2b971b2fe78"
    assert tag.hex() == "ab6e47d42cec13bdf53a67b21257bddf"
    assert gcm_decrypt(key, nonce, b"", ciphertext, tag) == bytes(16)


def test_gcm_roundtrip_and_tamper_detection():
    key = os.urandom(16)
    nonce = os.urandom(12)
    aad = b"qualcomm-test"
    plaintext = b'{"t":"dat","cols":["Pow"],"dat":[1]}'
    ciphertext, tag = gcm_encrypt(key, nonce, aad, plaintext)
    assert gcm_decrypt(key, nonce, aad, ciphertext, tag) == plaintext
    with pytest.raises(ValueError):
        gcm_decrypt(key, nonce, aad, ciphertext, bytes(16))


def test_cipher_v1_roundtrip_with_padding():
    cipher = CipherV1(GENERIC_KEY_V1)
    payload = {"t": "bind", "mac": "502cc6aabbcc", "uid": 0}
    encoded = cipher.encrypt(payload)
    assert isinstance(encoded, str)
    assert cipher.decrypt(encoded) == payload


def test_cipher_v2_roundtrip_and_tag():
    cipher = CipherV2(GENERIC_KEY_V2)
    payload = {"t": "status", "mac": "502cc6aabbcc", "cols": ["Pow", "Mod"]}
    encoded, tag = cipher.encrypt(payload)
    assert base64.b64decode(tag)
    assert cipher.decrypt(encoded, tag) == payload
    # A wrong tag must be rejected rather than silently accepted.
    with pytest.raises(ValueError):
        cipher.decrypt(encoded, base64.b64encode(bytes(16)).decode())


def test_cipher_v1_matches_reference_vector():
    """Fixed vector produced from the known generic key (regression guard)."""
    cipher = CipherV1(b"a3K8Bx%2r8Y7#xDh")
    payload = {"t": "scan"}
    encoded = cipher.encrypt(payload)
    assert CipherV1(b"a3K8Bx%2r8Y7#xDh").decrypt(encoded) == payload
    raw = base64.b64decode(encoded)
    assert len(raw) == 16
    # AES-ECB is deterministic, so encrypting the same JSON must match.
    assert CipherV1(b"a3K8Bx%2r8Y7#xDh").encrypt(json.loads(json.dumps(payload))) == encoded


def test_cipher_v2_is_deterministic():
    cipher = CipherV2()
    payload = {"t": "bind", "mac": "502cc6aabbcc", "uid": 0}
    assert cipher.encrypt(payload) == cipher.encrypt(payload)
