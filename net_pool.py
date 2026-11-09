#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
net_pool.py - 全局高性能 HTTP 连接池与应用层 DNS 缓存中枢
为跨洋 Serverless 调用 (Vercel iad1 <-> 国内底座) 提供连接复用 (Keep-Alive) 与 0ms DNS 秒查
"""

import os
import sys
import time
import socket
import threading
import urllib.request
import urllib.parse
import ssl

# ========================================================
# 区块 1: 线程安全带 TTL 应用层 DNS 缓存池 (IPv4 优先)
# ========================================================
_DNS_CACHE = {}
_DNS_LOCK = threading.Lock()
_DNS_TTL_SEC = 300  # 5 分钟缓存期
_ORIG_GETADDRINFO = socket.getaddrinfo

def _cached_getaddrinfo(host, port, *args, **kwargs):
    now = time.time()
    cache_key = (host, port)
    with _DNS_LOCK:
        if cache_key in _DNS_CACHE:
            res, expire_at = _DNS_CACHE[cache_key]
            if now < expire_at:
                return res

    try:
        raw_res = _ORIG_GETADDRINFO(host, port, *args, **kwargs)
        ipv4 = [r for r in raw_res if r[0] == socket.AF_INET]
        filtered = ipv4 if ipv4 else raw_res
    except Exception:
        return _ORIG_GETADDRINFO(host, port, *args, **kwargs)

    with _DNS_LOCK:
        if len(_DNS_CACHE) > 500:
            _DNS_CACHE.clear()
        _DNS_CACHE[cache_key] = (filtered, now + _DNS_TTL_SEC)
    return filtered

socket.getaddrinfo = _cached_getaddrinfo


# ========================================================
# 区块 2: 全局持久 HTTP 连接池 (urllib3 Keep-Alive)
# ========================================================
try:
    import urllib3
    import logging
    urllib3.disable_warnings()
    # 屏蔽 urllib3 内部冗余重定向与探针日志，净化 Vercel 生产 Runtime Logs
    logging.getLogger("urllib3").setLevel(logging.ERROR)

    # 严格重试策略：仅跟随 302 重定向 (redirect=3)，绝对不在故障/超时节点上死循环盲目重试 (connect=0, read=0)
    _RETRY_CONFIG = urllib3.Retry(
        total=3,
        connect=0,
        read=0,
        redirect=3,
        status=0,
        other=0,
        raise_on_redirect=False
    )

    _HTTP_POOL = urllib3.PoolManager(
        maxsize=50,
        cert_reqs='CERT_NONE',
        retries=_RETRY_CONFIG,
        timeout=urllib3.Timeout(connect=2.0, read=4.0)
    )
except Exception:
    _HTTP_POOL = None


# 铁律常量：假音频与试听截断黑名单字节数
FAKE_AUDIO_LENGTHS = {81629, 181521}
MIN_VALID_BYTES = 1200000  # 1.2MB

def http_get(url: str, headers: dict = None, timeout: float = 3.0, redirect: bool = True):
    """
    通用极速 HTTP GET 请求（优先使用连接池复用 Keep-Alive，平滑回退标准库）
    返回: (status: int, body_bytes: bytes, final_url: str, resp_headers: dict)
    """
    hdrs = headers.copy() if headers else {}
    if "User-Agent" not in hdrs:
        hdrs["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    if _HTTP_POOL:
        try:
            r = _HTTP_POOL.request(
                'GET',
                url,
                headers=hdrs,
                timeout=timeout,
                redirect=redirect
            )
            final_url = r.geturl() if callable(getattr(r, 'geturl', None)) else getattr(r, 'url', None)
            if final_url and not final_url.startswith('http') and hasattr(r, '_pool'):
                final_url = f"{getattr(r._pool, 'scheme', 'https')}://{getattr(r._pool, 'host', '')}{final_url}"
            if not final_url:
                final_url = url
            return r.status, r.data, final_url, dict(r.headers)
        except Exception:
            pass

    # 平滑回退 urllib.request
    try:
        req = urllib.request.Request(url, headers=hdrs)
        ctx = ssl._create_unverified_context() if hasattr(ssl, '_create_unverified_context') else None
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            final_url = resp.geturl()
            data = resp.read()
            return resp.status, data, final_url, dict(resp.headers)
    except Exception:
        return 0, b"", url, {}


def http_post_json(url: str, payload: dict, headers: dict = None, timeout: float = 3.0):
    """
    通用极速 HTTP POST JSON 请求
    返回: (status: int, body_bytes: bytes, resp_headers: dict)
    """
    import json
    hdrs = headers.copy() if headers else {}
    hdrs["Content-Type"] = "application/json"
    if "User-Agent" not in hdrs:
        hdrs["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

    data_bytes = json.dumps(payload).encode("utf-8")

    if _HTTP_POOL:
        try:
            r = _HTTP_POOL.request(
                'POST',
                url,
                body=data_bytes,
                headers=hdrs,
                timeout=timeout
            )
            return r.status, r.data, dict(r.headers)
        except Exception:
            pass

    req = urllib.request.Request(url, data=data_bytes, headers=hdrs)
    ctx = ssl._create_unverified_context() if hasattr(ssl, '_create_unverified_context') else None
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return resp.status, resp.read(), dict(resp.headers)


def is_audio_magic(data: bytes) -> bool:
    """嗅探首包二进制魔数，确保为真正的多媒体音频文件格式"""
    if not data or len(data) < 4:
        return False
    # MP3 ID3v2 标签
    if data[:3] == b'ID3':
        return True
    # MP3 原始帧同步字 (11 个连续 1: 0xFF 与后字节高 3 位为 1)
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return True
    # FLAC 无损
    if data[:4] == b'fLaC':
        return True
    # M4A / MP4 / AAC (ftyp 魔数)
    if len(data) >= 8 and (data[4:8] == b'ftyp' or data[:4] == b'ftyp'):
        return True
    # OGG
    if data[:4] == b'OggS':
        return True
    return False


def verify_audio_stream(url: str, timeout: float = 2.0) -> tuple:
    """
    轻量秒级校验音频有效性：
    1. 严格过滤黑名单与试听截断残卷 (< 1.2MB 拦截 30 秒试听)
    2. 对无 Content-Length / Chunked 响应抓取前 512 字节进行音频魔数检验，杜绝空响应与假直链
    返回: (is_valid: bool, content_length: int, final_url: str)
    """
    if not url or not url.startswith("http"):
        return False, 0, ""

    if "588957081" in url or "music.163.com/404" in url:
        return False, 0, url

    hdrs = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Range': 'bytes=0-1024'
    }

    if _HTTP_POOL:
        try:
            r = _HTTP_POOL.request(
                'GET',
                url,
                headers=hdrs,
                timeout=timeout,
                redirect=True,
                preload_content=False
            )
            final_url = r.geturl() if callable(getattr(r, 'geturl', None)) else getattr(r, 'url', None)
            if final_url and not final_url.startswith('http') and hasattr(r, '_pool'):
                final_url = f"{getattr(r._pool, 'scheme', 'https')}://{getattr(r._pool, 'host', '')}{final_url}"
            if not final_url:
                final_url = url
            status = r.status
            resp_headers = dict(r.headers)

            if "588957081" in final_url or "music.163.com/404" in final_url or status not in (200, 206):
                r.release_conn()
                return False, 0, final_url

            content_type = (resp_headers.get('Content-Type') or resp_headers.get('content-type') or '').lower()
            if content_type and ('text/' in content_type or 'application/json' in content_type or 'html' in content_type):
                r.release_conn()
                return False, 0, final_url

            cr = resp_headers.get('Content-Range') or resp_headers.get('content-range') or ''
            total_size = 0
            if cr and '/' in cr:
                try:
                    total_size = int(cr.split('/')[-1])
                except Exception:
                    pass
            if total_size == 0:
                try:
                    total_size = int(resp_headers.get('Content-Length') or resp_headers.get('content-length') or 0)
                except Exception:
                    pass

            # 命中已知假语音字节数或过小试听截断
            if total_size in FAKE_AUDIO_LENGTHS or (0 < total_size < MIN_VALID_BYTES):
                r.release_conn()
                return False, total_size, final_url

            # 若无法获取总大小 (如 Chunked 流式传输或无 Content-Length)，抓取首段数据严格嗅探音频格式
            if total_size == 0:
                first_chunk = r.read(512)
                r.release_conn()
                if not is_audio_magic(first_chunk):
                    return False, 0, final_url
                return True, 0, final_url

            r.release_conn()
            return True, total_size, final_url
        except Exception:
            return False, 0, ""

    # 平滑回退 urllib
    try:
        req = urllib.request.Request(url, headers=hdrs)
        ctx = ssl._create_unverified_context() if hasattr(ssl, '_create_unverified_context') else None
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            final_url = resp.geturl()
            if "588957081" in final_url or "music.163.com/404" in final_url or resp.status not in (200, 206):
                return False, 0, final_url
            content_type = (resp.headers.get('Content-Type') or '').lower()
            if content_type and ('text/' in content_type or 'application/json' in content_type or 'html' in content_type):
                return False, 0, final_url
            cr = resp.headers.get('Content-Range', '')
            total_size = 0
            if cr and '/' in cr:
                try:
                    total_size = int(cr.split('/')[-1])
                except Exception:
                    pass
            if total_size == 0:
                try:
                    total_size = int(resp.headers.get('Content-Length', 0))
                except Exception:
                    pass
            if total_size in FAKE_AUDIO_LENGTHS or (0 < total_size < MIN_VALID_BYTES):
                return False, total_size, final_url
            if total_size == 0:
                first_chunk = resp.read(512)
                if not is_audio_magic(first_chunk):
                    return False, 0, final_url
                return True, 0, final_url
            return True, total_size, final_url
    except Exception:
        return False, 0, ""
