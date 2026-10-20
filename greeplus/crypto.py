"""Cryptography used by the Gree/EWPE local protocol.

Two generations of the protocol are in use:

* V1 - AES-128-ECB with PKCS#7 padding, keyed with an ASCII key string.
* V2 - AES-128-GCM with a fixed nonce and additional authenticated data,
  used by newer Wi-Fi modules (Qualcomm based).

The implementation is dependency free: AES-128 (encrypt/decrypt) and GCM are
implemented here so the tool runs on a bare Python install.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Optional, Tuple

# Generic ("public") keys shipped inside the mobile apps. They are only used
# for discovery and for the bind exchange; afterwards every unit hands out its
# own key.
GENERIC_KEY_V1 = b"a3K8Bx%2r8Y7#xDh"
GENERIC_KEY_V2 = b"{yxAHAY_Lm6pbC/<"

# Fixed nonce/AAD baked into the V2 firmware and app. Identical on every unit.
GCM_NONCE = bytes.fromhex("5440784449675a516c5e6313")
GCM_AAD = b"qualcomm-test"

BLOCK_SIZE = 16


# ---------------------------------------------------------------------------
# GF(2^8) helpers and AES tables
# ---------------------------------------------------------------------------


def _gf_mul(a: int, b: int) -> int:
    """Multiply two bytes in GF(2^8) modulo x^8 + x^4 + x^3 + x + 1."""
    result = 0
    for _ in range(8):
        if b & 1:
            result ^= a
        high = a & 0x80
        a = (a << 1) & 0xFF
        if high:
            a ^= 0x1B
        b >>= 1
    return result


def _gf_pow(a: int, exponent: int) -> int:
    result = 1
    for _ in range(exponent):
        result = _gf_mul(result, a)
    return result


def _rotl8(value: int, shift: int) -> int:
    return ((value << shift) | (value >> (8 - shift))) & 0xFF


def _build_sbox() -> Tuple[list, list]:
    sbox = [0] * 256
    for value in range(256):
        inverse = _gf_pow(value, 254) if value else 0
        sbox[value] = (
            inverse
            ^ _rotl8(inverse, 1)
            ^ _rotl8(inverse, 2)
            ^ _rotl8(inverse, 3)
            ^ _rotl8(inverse, 4)
            ^ 0x63
        )
    inverse_sbox = [0] * 256
    for index, value in enumerate(sbox):
        inverse_sbox[value] = index
    return sbox, inverse_sbox


SBOX, INV_SBOX = _build_sbox()

RCON = [0x00] + [_gf_pow(2, i - 1) for i in range(1, 11)]


# ---------------------------------------------------------------------------
# AES-128 block cipher
# ---------------------------------------------------------------------------


class AES128:
    """Minimal AES-128 block cipher with precomputed round keys.

    The internal state is a flat 16-byte list in column-major order, which is
    exactly the order AES uses for input blocks.
    """

    rounds = 10

    def __init__(self, key: bytes) -> None:
        if len(key) != 16:
            raise ValueError("AES-128 requires a 16-byte key")
        self._round_keys = self._expand_key(key)

    @staticmethod
    def _expand_key(key: bytes) -> list:
        words = [list(key[i * 4 : i * 4 + 4]) for i in range(4)]
        for index in range(4, 44):
            temp = list(words[index - 1])
            if index % 4 == 0:
                temp = temp[1:] + temp[:1]
                temp = [SBOX[byte] for byte in temp]
                temp[0] ^= RCON[index // 4]
            words.append([words[index - 4][i] ^ temp[i] for i in range(4)])
        return [
            [byte for word in words[round_index * 4 : round_index * 4 + 4] for byte in word]
            for round_index in range(11)
        ]

    def _add_round_key(self, state: list, round_index: int) -> None:
        key = self._round_keys[round_index]
        for index in range(16):
            state[index] ^= key[index]

    @staticmethod
    def _sub_bytes(state: list, table: list) -> None:
        for index in range(16):
            state[index] = table[state[index]]

    @staticmethod
    def _shift_rows(state: list) -> None:
        for row in range(1, 4):
            column = [state[4 * c + row] for c in range(4)]
            for c in range(4):
                state[4 * c + row] = column[(c + row) % 4]

    @staticmethod
    def _inv_shift_rows(state: list) -> None:
        for row in range(1, 4):
            column = [state[4 * c + row] for c in range(4)]
            for c in range(4):
                state[4 * ((c + row) % 4) + row] = column[c]

    @staticmethod
    def _mix_columns(state: list) -> None:
        for c in range(4):
            a0, a1, a2, a3 = state[4 * c : 4 * c + 4]
            state[4 * c + 0] = _gf_mul(a0, 2) ^ _gf_mul(a1, 3) ^ a2 ^ a3
            state[4 * c + 1] = a0 ^ _gf_mul(a1, 2) ^ _gf_mul(a2, 3) ^ a3
            state[4 * c + 2] = a0 ^ a1 ^ _gf_mul(a2, 2) ^ _gf_mul(a3, 3)
            state[4 * c + 3] = _gf_mul(a0, 3) ^ a1 ^ a2 ^ _gf_mul(a3, 2)

    @staticmethod
    def _inv_mix_columns(state: list) -> None:
        for c in range(4):
            a0, a1, a2, a3 = state[4 * c : 4 * c + 4]
            state[4 * c + 0] = _gf_mul(a0, 14) ^ _gf_mul(a1, 11) ^ _gf_mul(a2, 13) ^ _gf_mul(a3, 9)
            state[4 * c + 1] = _gf_mul(a0, 9) ^ _gf_mul(a1, 14) ^ _gf_mul(a2, 11) ^ _gf_mul(a3, 13)
            state[4 * c + 2] = _gf_mul(a0, 13) ^ _gf_mul(a1, 9) ^ _gf_mul(a2, 14) ^ _gf_mul(a3, 11)
            state[4 * c + 3] = _gf_mul(a0, 11) ^ _gf_mul(a1, 13) ^ _gf_mul(a2, 9) ^ _gf_mul(a3, 14)

    def encrypt_block(self, block: bytes) -> bytes:
        state = list(block)
        self._add_round_key(state, 0)
        for round_index in range(1, self.rounds):
            self._sub_bytes(state, SBOX)
            self._shift_rows(state)
            self._mix_columns(state)
            self._add_round_key(state, round_index)
        self._sub_bytes(state, SBOX)
        self._shift_rows(state)
        self._add_round_key(state, self.rounds)
        return bytes(state)

    def decrypt_block(self, block: bytes) -> bytes:
        state = list(block)
        self._add_round_key(state, self.rounds)
        for round_index in range(self.rounds - 1, 0, -1):
            self._inv_shift_rows(state)
            self._sub_bytes(state, INV_SBOX)
            self._add_round_key(state, round_index)
            self._inv_mix_columns(state)
        self._inv_shift_rows(state)
        self._sub_bytes(state, INV_SBOX)
        self._add_round_key(state, 0)
        return bytes(state)


# ---------------------------------------------------------------------------
# AES-ECB with PKCS#7 padding (protocol V1)
# ---------------------------------------------------------------------------


def pkcs7_pad(data: bytes) -> bytes:
    padding = BLOCK_SIZE - len(data) % BLOCK_SIZE
    return data + bytes([padding]) * padding


def pkcs7_unpad(data: bytes) -> bytes:
    if not data:
        return data
    padding = data[-1]
    if 1 <= padding <= BLOCK_SIZE and data.endswith(bytes([padding]) * padding):
        return data[:-padding]
    # Some firmware pads with printable characters instead of raw bytes; the
    # JSON decoder can still cope with trailing garbage after the last "}".
    return data


def ecb_encrypt(key: bytes, plaintext: bytes) -> bytes:
    cipher = AES128(key)
    padded = pkcs7_pad(plaintext)
    return b"".join(cipher.encrypt_block(padded[i : i + BLOCK_SIZE]) for i in range(0, len(padded), BLOCK_SIZE))


def ecb_decrypt(key: bytes, ciphertext: bytes) -> bytes:
    cipher = AES128(key)
    if len(ciphertext) % BLOCK_SIZE:
        raise ValueError("ciphertext length is not a multiple of the AES block size")
    plaintext = b"".join(
        cipher.decrypt_block(ciphertext[i : i + BLOCK_SIZE]) for i in range(0, len(ciphertext), BLOCK_SIZE)
    )
    return pkcs7_unpad(plaintext)


# ---------------------------------------------------------------------------
# AES-GCM (protocol V2)
# ---------------------------------------------------------------------------


def _gf128_mul(x: int, y: int) -> int:
    """Multiply two 128-bit integers in GCM's GF(2^128)."""
    result = 0
    for bit in range(128):
        if (y >> (127 - bit)) & 1:
            result ^= x
        low = x & 1
        x >>= 1
        if low:
            x ^= 0xE1 << 120
    return result


def _ghash(h: int, aad: bytes, ciphertext: bytes) -> int:
    def blocks(data: bytes):
        for index in range(0, len(data), 16):
            yield data[index : index + 16]

    value = 0
    for chunk in blocks(aad):
        value = _gf128_mul(value ^ int.from_bytes(chunk + b"\x00" * (16 - len(chunk)), "big"), h)
    for chunk in blocks(ciphertext):
        value = _gf128_mul(value ^ int.from_bytes(chunk + b"\x00" * (16 - len(chunk)), "big"), h)
    lengths = (len(aad) * 8).to_bytes(8, "big") + (len(ciphertext) * 8).to_bytes(8, "big")
    value = _gf128_mul(value ^ int.from_bytes(lengths, "big"), h)
    return value


def _ctr_xor(cipher: AES128, initial_counter: bytes, data: bytes) -> bytes:
    counter = int.from_bytes(initial_counter, "big")
    output = bytearray()
    for index in range(0, len(data), BLOCK_SIZE):
        stream = cipher.encrypt_block(counter.to_bytes(16, "big"))
        chunk = data[index : index + BLOCK_SIZE]
        output.extend(a ^ b for a, b in zip(chunk, stream))
        counter = (counter + 1) & ((1 << 128) - 1)
    return bytes(output)


def _gcm_setup(key: bytes, nonce: bytes) -> Tuple[AES128, int, bytes]:
    if len(nonce) != 12:
        raise ValueError("this implementation only supports 96-bit GCM nonces")
    cipher = AES128(key)
    h = int.from_bytes(cipher.encrypt_block(b"\x00" * 16), "big")
    j0 = nonce + b"\x00\x00\x00\x01"
    return cipher, h, j0


def gcm_encrypt(key: bytes, nonce: bytes, aad: bytes, plaintext: bytes) -> Tuple[bytes, bytes]:
    cipher, h, j0 = _gcm_setup(key, nonce)
    counter = int.from_bytes(j0, "big") + 1
    ciphertext = _ctr_xor(cipher, counter.to_bytes(16, "big"), plaintext)
    tag_mask = int.from_bytes(cipher.encrypt_block(j0), "big")
    tag = (tag_mask ^ _ghash(h, aad, ciphertext)).to_bytes(16, "big")
    return ciphertext, tag


def gcm_decrypt(key: bytes, nonce: bytes, aad: bytes, ciphertext: bytes, tag: Optional[bytes] = None) -> bytes:
    cipher, h, j0 = _gcm_setup(key, nonce)
    plaintext = _ctr_xor(cipher, (int.from_bytes(j0, "big") + 1).to_bytes(16, "big"), ciphertext)
    if tag is not None:
        expected = (int.from_bytes(cipher.encrypt_block(j0), "big") ^ _ghash(h, aad, ciphertext)).to_bytes(16, "big")
        if expected != tag:
            raise ValueError("GCM authentication tag mismatch")
    return plaintext


# ---------------------------------------------------------------------------
# Protocol ciphers
# ---------------------------------------------------------------------------


def _json_dumps(data: Any) -> bytes:
    # Default separators (", ", ": ") match the byte layout produced by the
    # official app implementations; the device parses JSON, but keeping the
    # same layout makes captures easier to compare.
    return json.dumps(data).encode()


def _json_from_plaintext(plaintext: bytes) -> dict:
    text = plaintext.decode("utf-8", "ignore")
    end = text.rindex("}")
    return json.loads(text[: end + 1])


class CipherV1:
    """AES-128-ECB cipher. `key` is the ASCII key used as raw AES key."""

    version = "v1"

    def __init__(self, key: bytes = GENERIC_KEY_V1) -> None:
        self.key = key

    def encrypt(self, data: Any) -> str:
        return base64.b64encode(ecb_encrypt(self.key, _json_dumps(data))).decode()

    def decrypt(self, payload: str) -> dict:
        return _json_from_plaintext(ecb_decrypt(self.key, base64.b64decode(payload)))


class CipherV2:
    """AES-128-GCM cipher with the firmware's fixed nonce and AAD."""

    version = "v2"

    def __init__(self, key: bytes = GENERIC_KEY_V2) -> None:
        self.key = key

    def encrypt(self, data: Any) -> Tuple[str, str]:
        ciphertext, tag = gcm_encrypt(self.key, GCM_NONCE, GCM_AAD, _json_dumps(data))
        return base64.b64encode(ciphertext).decode(), base64.b64encode(tag).decode()

    def decrypt(self, payload: str, tag: Optional[str] = None) -> dict:
        raw_tag = None
        if tag:
            try:
                raw_tag = base64.b64decode(tag)
            except Exception:  # noqa: BLE001 - a malformed tag is not fatal
                raw_tag = None
        plaintext = gcm_decrypt(
            self.key, GCM_NONCE, GCM_AAD, base64.b64decode(payload), raw_tag
        )
        return _json_from_plaintext(plaintext)


def make_cipher(version: str, key: Optional[bytes] = None):
    if version == "v1":
        return CipherV1(key or GENERIC_KEY_V1)
    if version == "v2":
        return CipherV2(key or GENERIC_KEY_V2)
    raise ValueError(f"unknown protocol version: {version!r}")
