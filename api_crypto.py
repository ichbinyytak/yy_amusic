#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
零依赖认证加解密工具 (PBKDF2-HMAC-SHA256 + SHA256-CTR + Encrypt-then-MAC HMAC-SHA256)
与 yy-lx-hub Node 端 lib/apicrypto.js 字节级严格互通。
"""

import os
import json
import hmac
import struct
import base64
import hashlib

VERSION = 1
ALG = "PBKDF2-SHA256-CTR-HMAC"
DEFAULT_ITER = 100000
AAD_PREFIX = b"yy-lx-hub:v1:"
BUILTIN_SYNC_KEY = "yy-lx-hub::amusic::auto-sync-v1"


def get_sync_secret() -> str:
    return (
        os.environ.get("AMUSIC_SYNC_KEY")
        or os.environ.get("AMUSIC_SYNC_SECRET")
        or BUILTIN_SYNC_KEY
    ).strip()


def _derive_keys(secret: str, salt: bytes, iterations: int):
    dk = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, iterations, dklen=64)
    return dk[:32], dk[32:64]


def _ctr_xor(enc_key: bytes, nonce: bytes, data: bytes) -> bytes:
    n = len(data)
    out = bytearray(n)
    offset = 0
    counter = 0
    while offset < n:
        block = hashlib.sha256(enc_key + nonce + struct.pack(">I", counter)).digest()
        take = min(32, n - offset)
        for i in range(take):
            out[offset + i] = data[offset + i] ^ block[i]
        offset += take
        counter += 1
    return bytes(out)


def _compute_mac(mac_key: bytes, salt: bytes, nonce: bytes, ct: bytes) -> bytes:
    return hmac.new(mac_key, AAD_PREFIX + salt + nonce + ct, hashlib.sha256).digest()


def encrypt_json(data, secret: str, iterations: int = DEFAULT_ITER) -> dict:
    key_str = str(secret or "").strip()
    if not key_str:
        raise ValueError("缺少加密密钥 AMUSIC_SYNC_KEY")
    if isinstance(data, (bytes, bytearray)):
        plain = bytes(data)
    elif isinstance(data, str):
        plain = data.encode("utf-8")
    else:
        plain = json.dumps(data, ensure_ascii=False).encode("utf-8")

    salt = os.urandom(16)
    nonce = os.urandom(16)
    enc_key, mac_key = _derive_keys(key_str, salt, iterations)
    ct = _ctr_xor(enc_key, nonce, plain)
    mac = _compute_mac(mac_key, salt, nonce, ct)

    return {
        "v": VERSION,
        "alg": ALG,
        "iter": iterations,
        "salt": base64.b64encode(salt).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ct": base64.b64encode(ct).decode("ascii"),
        "mac": base64.b64encode(mac).decode("ascii"),
    }


def decrypt_json(envelope_or_str, secret: str = None):
    key_str = str(secret if secret is not None else get_sync_secret()).strip()
    if not key_str:
        raise ValueError("缺少解密密钥 AMUSIC_SYNC_KEY")

    if isinstance(envelope_or_str, (bytes, bytearray)):
        envelope_or_str = envelope_or_str.decode("utf-8")
    env = json.loads(envelope_or_str) if isinstance(envelope_or_str, str) else envelope_or_str
    if not isinstance(env, dict) or env.get("v") != VERSION or env.get("alg") != ALG:
        raise ValueError("不支持的密文格式或版本")

    iterations = env.get("iter")
    if not isinstance(iterations, int) or iterations < 10000 or iterations > 1000000:
        raise ValueError("非法的 PBKDF2 迭代次数")

    salt = base64.b64decode(str(env.get("salt") or ""), validate=True)
    nonce = base64.b64decode(str(env.get("nonce") or ""), validate=True)
    ct = base64.b64decode(str(env.get("ct") or ""), validate=True)
    mac = base64.b64decode(str(env.get("mac") or ""), validate=True)
    if len(salt) != 16 or len(nonce) != 16 or len(mac) != 32:
        raise ValueError("密文字段长度无效")

    enc_key, mac_key = _derive_keys(key_str, salt, iterations)
    expected_mac = _compute_mac(mac_key, salt, nonce, ct)
    if not hmac.compare_digest(mac, expected_mac):
        raise ValueError("密文完整性校验失败（密钥错误或数据已被篡改）")

    plain = _ctr_xor(enc_key, nonce, ct)
    return json.loads(plain.decode("utf-8"))
