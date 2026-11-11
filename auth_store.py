#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
auth_store.py - 邀请码注册、登录鉴权与 Vercel KV 用户歌单云同步存储中枢
核心原则：
  1. 0 三方依赖，纯 Python 标准库实现 (PBKDF2-HMAC-SHA256 + HMAC-SHA256 会话签名)
  2. TLS 证书严格校验：不复用全局 CERT_NONE 连接池，使用标准 ssl 默认校验证书上下文访问 Upstash KV
  3. 生产环境 Fail-Close：Vercel 环境下缺失 AMUSIC_AUTH_SECRET / AMUSIC_INVITE_CODES / KV 配置时直接拒绝访问
  4. 本地开发兜底：非 Vercel 环境且未配置 KV 时，自动使用被 .gitignore 忽略的 .local_auth.json（默认邀请码 1111）
"""

import base64
import hashlib
import hmac
import http.cookies
import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_AUTH_FILE = os.path.join(BASE_DIR, ".local_auth.json")
_LOCAL_LOCK = threading.Lock()

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_-]{3,24}$")
SESSION_COOKIE_NAME = "amusic_session"
SESSION_TTL_SEC = 30 * 86400
MAX_LIBRARY_BYTES = 512 * 1024  # 512 KB 上限保护
PBKDF2_ITERATIONS = 100000


class AuthConfigError(Exception):
    """生产环境鉴权/存储配置缺失或不可用"""


class AuthClientError(Exception):
    """客户端输入、邀请码或凭据错误"""
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def is_vercel_env() -> bool:
    return bool(os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"))


def _get_kv_config() -> tuple:
    url = (
        os.environ.get("KV_REST_API_URL")
        or os.environ.get("STORAGE_REST_API_URL")
        or os.environ.get("UPSTASH_REDIS_REST_URL")
        or ""
    ).strip().rstrip("/")
    token = (
        os.environ.get("KV_REST_API_TOKEN")
        or os.environ.get("STORAGE_REST_API_TOKEN")
        or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
        or ""
    ).strip()
    return url, token


def _has_kv_config() -> bool:
    url, token = _get_kv_config()
    return bool(url and token)


def _load_local_store_unlocked() -> dict:
    if not os.path.exists(LOCAL_AUTH_FILE):
        data = {
            "local_secret": os.urandom(32).hex(),
            "users": {},
            "libraries": {},
        }
        _save_local_store_unlocked(data)
        return data
    try:
        with open(LOCAL_AUTH_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    data.setdefault("local_secret", os.urandom(32).hex())
    data.setdefault("users", {})
    data.setdefault("libraries", {})
    return data


def _load_local_store() -> dict:
    with _LOCAL_LOCK:
        return _load_local_store_unlocked()


def _save_local_store_unlocked(data: dict):
    tmp_path = LOCAL_AUTH_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, LOCAL_AUTH_FILE)


def _get_auth_secret() -> str:
    secret = (os.environ.get("AMUSIC_AUTH_SECRET") or "").strip()
    if secret:
        return secret
    if is_vercel_env():
        raise AuthConfigError("服务端未配置 AMUSIC_AUTH_SECRET，拒绝鉴权操作")
    store = _load_local_store()
    return store["local_secret"]


def _get_invite_codes() -> list:
    raw = (os.environ.get("AMUSIC_INVITE_CODES") or "").strip()
    if raw:
        return [c.strip() for c in raw.split(",") if c.strip()]
    if is_vercel_env():
        return []
    return ["1111"]


def _kv_command(command_list: list, timeout: float = 3.0):
    """使用严格校验证书的 HTTPS 请求访问 Upstash KV REST API"""
    url, token = _get_kv_config()
    if not url or not token:
        raise AuthConfigError("服务端未配置 KV 存储环境变量")
    body = json.dumps(command_list, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "Amusic-Auth/1.0",
        },
        method="POST",
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read()
            if resp.status != 200 or not raw:
                raise AuthConfigError(f"KV 存储返回异常状态: {resp.status}")
            parsed = json.loads(raw.decode("utf-8"))
            if isinstance(parsed, dict) and parsed.get("error"):
                raise AuthConfigError(f"KV 命令执行失败: {parsed['error']}")
            return parsed.get("result") if isinstance(parsed, dict) else None
    except urllib.error.HTTPError as he:
        raise AuthConfigError(f"KV HTTP 错误: {he.code}") from he
    except AuthConfigError:
        raise
    except Exception as e:
        raise AuthConfigError(f"KV 连接异常: {e}") from e


def _empty_library() -> dict:
    return {
        "customPlaylists": [],
        "favPlaylists": [],
        "categoriesCustom": [],
        "categoriesFav": [],
        "version": 1,
        "updatedAt": int(time.time() * 1000),
    }


def _hash_password(password: str, salt_hex: str = None) -> tuple:
    salt_bytes = bytes.fromhex(salt_hex) if salt_hex else os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_bytes,
        PBKDF2_ITERATIONS,
    )
    return salt_bytes.hex(), digest.hex()


def _b64url_encode(raw_bytes: bytes) -> str:
    return base64.urlsafe_b64encode(raw_bytes).rstrip(b"=").decode("ascii")


def _b64url_decode(txt: str) -> bytes:
    pad = "=" * (-len(txt) % 4)
    return base64.urlsafe_b64decode((txt + pad).encode("ascii"))


def create_session_token(username: str) -> str:
    secret = _get_auth_secret()
    payload = {
        "u": username,
        "exp": int(time.time()) + SESSION_TTL_SEC,
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_session(headers) -> str:
    """从请求头 Cookie 中提取并校验签名会话，通过返回小写 username，否则返回 None"""
    try:
        cookie_hdr = headers.get("Cookie") if headers else None
        if not cookie_hdr:
            return None
        cookie = http.cookies.SimpleCookie()
        cookie.load(cookie_hdr)
        morsel = cookie.get(SESSION_COOKIE_NAME)
        if not morsel or not morsel.value:
            return None
        token = morsel.value.strip()
        if "." not in token:
            return None
        payload_b64, sig = token.split(".", 1)
        secret = _get_auth_secret()
        expected_sig = hmac.new(
            secret.encode("utf-8"),
            payload_b64.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        username = str(payload.get("u") or "").strip().lower()
        exp = int(payload.get("exp") or 0)
        if not username or not USERNAME_RE.match(username) or exp <= int(time.time()):
            return None
        return username
    except Exception:
        return None


def build_session_cookie_header(token: str, secure: bool = False) -> str:
    parts = [
        f"{SESSION_COOKIE_NAME}={token}",
        "HttpOnly",
        "Path=/",
        f"Max-Age={SESSION_TTL_SEC}",
        "SameSite=Lax",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def build_clear_cookie_header(secure: bool = False) -> str:
    parts = [
        f"{SESSION_COOKIE_NAME}=",
        "HttpOnly",
        "Path=/",
        "Max-Age=0",
        "SameSite=Lax",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def _normalize_username(username: str) -> str:
    u = str(username or "").strip()
    if not USERNAME_RE.match(u):
        raise AuthClientError("用户名须为 3-24 位字母、数字、下划线或短横线", 400)
    return u.lower()


def _validate_password(password: str) -> str:
    pwd = str(password or "")
    if len(pwd) < 6 or len(pwd) > 128:
        raise AuthClientError("密码长度须在 6-128 位之间", 400)
    return pwd


def register_user(username: str, password: str, invite_code: str) -> dict:
    """校验邀请码并注册新账号，同时写入全 0 初始歌单资产"""
    uname = _normalize_username(username)
    pwd = _validate_password(password)
    code = str(invite_code or "").strip()

    # 先校验配置，确保生产环境未配置时 Fail-Close
    _get_auth_secret()
    valid_codes = _get_invite_codes()
    if not valid_codes:
        raise AuthClientError("当前暂未开放新用户注册（邀请码未启用）", 403)
    if not code or not any(hmac.compare_digest(code, vc) for vc in valid_codes):
        raise AuthClientError("邀请码无效或已停用", 403)

    salt_hex, pwd_hash = _hash_password(pwd)
    user_record = {
        "username": uname,
        "salt": salt_hex,
        "password_hash": pwd_hash,
        "created_at": int(time.time()),
    }
    init_lib = _empty_library()

    if _has_kv_config():
        user_key = f"amusic:auth:user:{uname}"
        res = _kv_command(["SET", user_key, json.dumps(user_record, ensure_ascii=False), "NX"])
        if res != "OK":
            raise AuthClientError("该用户名已被注册", 409)
        lib_key = f"amusic:user:{uname}:library"
        lib_res = _kv_command(["SET", lib_key, json.dumps(init_lib, ensure_ascii=False)])
        if lib_res != "OK":
            raise AuthConfigError("初始化用户云端歌单失败")
    else:
        if is_vercel_env():
            raise AuthConfigError("生产环境未配置 Vercel KV 存储，拒绝注册")
        with _LOCAL_LOCK:
            store = _load_local_store_unlocked()
            if uname in store["users"]:
                raise AuthClientError("该用户名已被注册", 409)
            store["users"][uname] = user_record
            store["libraries"][uname] = init_lib
            _save_local_store_unlocked(store)

    token = create_session_token(uname)
    return {
        "username": uname,
        "token": token,
        "library": init_lib,
    }


def login_user(username: str, password: str) -> dict:
    """校验用户名与密码并签发会话 Token"""
    uname = _normalize_username(username)
    pwd = str(password or "")
    if not pwd:
        raise AuthClientError("请输入密码", 400)

    _get_auth_secret()
    user_record = None

    if _has_kv_config():
        raw = _kv_command(["GET", f"amusic:auth:user:{uname}"])
        if raw and isinstance(raw, str):
            try:
                user_record = json.loads(raw)
            except Exception:
                user_record = None
    else:
        if is_vercel_env():
            raise AuthConfigError("生产环境未配置 Vercel KV 存储，拒绝登录")
        store = _load_local_store()
        user_record = store.get("users", {}).get(uname)

    if not isinstance(user_record, dict):
        raise AuthClientError("用户名或密码错误", 401)

    salt_hex = user_record.get("salt") or ""
    expected_hash = user_record.get("password_hash") or ""
    if not salt_hex or not expected_hash:
        raise AuthClientError("用户名或密码错误", 401)

    _, computed_hash = _hash_password(pwd, salt_hex=salt_hex)
    if not hmac.compare_digest(computed_hash, expected_hash):
        raise AuthClientError("用户名或密码错误", 401)

    token = create_session_token(uname)
    return {
        "username": uname,
        "token": token,
    }


def get_user_library(username: str) -> dict:
    uname = _normalize_username(username)
    if _has_kv_config():
        raw = _kv_command(["GET", f"amusic:user:{uname}:library"])
        if raw and isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    return _sanitize_library_payload(parsed)
            except Exception:
                pass
        return _empty_library()
    if is_vercel_env():
        raise AuthConfigError("生产环境未配置 Vercel KV 存储")
    store = _load_local_store()
    lib = store.get("libraries", {}).get(uname)
    return _sanitize_library_payload(lib) if isinstance(lib, dict) else _empty_library()


def _sanitize_library_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise AuthClientError("无效的歌单同步数据结构", 400)

    custom = payload.get("customPlaylists", [])
    fav = payload.get("favPlaylists", [])
    cat_custom = payload.get("categoriesCustom", [])
    cat_fav = payload.get("categoriesFav", [])

    if not all(isinstance(x, list) for x in (custom, fav, cat_custom, cat_fav)):
        raise AuthClientError("歌单或分组字段必须为数组", 400)

    return {
        "customPlaylists": custom,
        "favPlaylists": fav,
        "categoriesCustom": cat_custom,
        "categoriesFav": cat_fav,
        "version": 1,
        "updatedAt": int(time.time() * 1000),
    }


def save_user_library(username: str, payload: dict) -> dict:
    uname = _normalize_username(username)
    clean = _sanitize_library_payload(payload)
    serialized = json.dumps(clean, ensure_ascii=False)
    if len(serialized.encode("utf-8")) > MAX_LIBRARY_BYTES:
        raise AuthClientError("歌单同步体积超出 512KB 上限", 413)

    if _has_kv_config():
        res = _kv_command(["SET", f"amusic:user:{uname}:library", serialized])
        if res != "OK":
            raise AuthConfigError("保存云端歌单失败")
    else:
        if is_vercel_env():
            raise AuthConfigError("生产环境未配置 Vercel KV 存储")
        with _LOCAL_LOCK:
            store = _load_local_store_unlocked()
            store["libraries"][uname] = clean
            _save_local_store_unlocked(store)

    return clean
