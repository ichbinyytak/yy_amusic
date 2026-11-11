#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
========================================================
模块：server.py - 本地 HTTP 网关与 Apple Music / 音源底座调度服务
核心定位：0 图片下载开销，直连 Apple Music 官方数据库与 SSR 渲染树，极速提取歌单与专辑
依赖协同：source_manager.py, song_search.py, apple_catalog.py
--------------------------------------------------------
功能目录：
  1. 网络安全校验与 SSRF 防护 (is_safe_external_url)
  2. HTTP 统一响应与 ETag 304 快速协商 (Handler: send_json / send_error_json)
  3. GET 路由矩阵 (/api/apple_new, /api/apple_search_page, /api/lyric, /api/stream_proxy)
  4. POST 路由矩阵 (/api/resolve 双核冲刺, /api/sources/test, /api/sources/sync)
  5. 多线程异步 TCP 服务器引导 (ThreadingTCPServer)
========================================================
"""

import http.server
import socketserver
import os
import sys
import json
import time
import re
import threading
import urllib.request
import urllib.error
import urllib.parse
import hashlib
import ipaddress
import socket
import ssl
from concurrent.futures import ThreadPoolExecutor
import net_pool

# 引入底层音源调度、歌曲检索、歌词与解析编排模块
from source_manager import source_hub
from song_search import search_candidates
from lyric_service import get_song_lyric
from resolver import resolve_track
from auth_store import (
    AuthClientError,
    AuthConfigError,
    build_clear_cookie_header,
    build_session_cookie_header,
    get_user_library,
    login_user,
    register_user,
    save_user_library,
    verify_session,
)

# 方案 4: Apple Catalog API 官方数据代理服务端缓存 (URL -> (bytes, etag, ts))，存活 20 分钟
_APPLE_CATALOG_CACHE = {}
_APPLE_CATALOG_CACHE_LOCK = threading.Lock()
_APPLE_CATALOG_TTL_SEC = 1200

# 引入 Apple Music 官方专区与页面解构模块
from apple_catalog import (
    USER_AGENT,
    fetch_apple_new_page,
    fetch_apple_search_page,
    fetch_apple_curator_page,
    fetch_apple_room
)
from streetvoice_catalog import (
    get_sv_chart_catalog,
    fetch_sv_chart,
    fetch_sv_playlists,
    fetch_sv_playlist_songs,
    fetch_sv_song_lyrics,
    resolve_streetvoice_track,
    probe_sv_health,
)

# ========================================================
# 区块 1: 网络安全校验与 SSRF / 私网穿透探测防护
# ========================================================
def _is_forbidden_ip(ip_obj) -> bool:
    if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_multicast or ip_obj.is_reserved or ip_obj.is_unspecified:
        return True
    mapped = getattr(ip_obj, "ipv4_mapped", None)
    if mapped and _is_forbidden_ip(mapped):
        return True
    return False


def is_safe_external_url(url: str, allowed_hosts: list = None) -> bool:
    """
    网络安全防御：校验外部请求 URL 是否合法安全，严防 SSRF、本地敏感文件读取 (file://) 及私有内网穿透探测。
    """
    if not url or not isinstance(url, str):
        return False
    url = url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return False
    try:
        parsed = urllib.parse.urlparse(url)
        hostname = (parsed.hostname or "").strip().lower()
        if not hostname:
            return False

        # 1. 域名白名单校验（若指定）
        if allowed_hosts:
            if not any(hostname == h or hostname.endswith("." + h) for h in allowed_hosts):
                return False

        # 2. 拦截本机与内网专用域名
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1") or hostname.endswith(".local") or hostname.endswith(".internal"):
            return False

        # 3. 拦截私有 IP 与链路本地段 (含 IPv4-mapped IPv6)
        try:
            ip = ipaddress.ip_address(hostname)
            if _is_forbidden_ip(ip):
                return False
        except ValueError:
            try:
                addrinfo = socket.getaddrinfo(hostname, None)
                if not addrinfo:
                    return False
                for item in addrinfo:
                    resolved_ip = ipaddress.ip_address(item[4][0])
                    if _is_forbidden_ip(resolved_ip):
                        return False
            except Exception:
                return False
        return True
    except Exception:
        return False


def _fetch_apple_native_metadata(song_id: str, timeout: float = 1.5):
    """
    针对海外/香港/台湾 Apple Storefront 将日韩等非英语曲目罗马音化/英译化的痛点，
    通过 Apple 官方原生目录直接提取地道日文/母语标题与歌手，打通国内音源库检索
    """
    if not song_id or not str(song_id).isdigit():
        return None
    apple_url = f"https://api.music.apple.com/v1/catalog/jp/songs/{song_id}"
    with _APPLE_CATALOG_CACHE_LOCK:
        cached = _APPLE_CATALOG_CACHE.get(apple_url)
        if cached and (time.time() - cached["ts"]) < _APPLE_CATALOG_TTL_SEC:
            try:
                d = json.loads(cached["bytes"].decode("utf-8"))
                items = d.get("data", [])
                if items:
                    attrs = items[0].get("attributes", {})
                    return {
                        "title": attrs.get("name", "").strip(),
                        "artist": attrs.get("artistName", "").strip(),
                        "duration": round(attrs.get("durationInMillis", 0) / 1000) or None
                    }
            except Exception:
                pass

    try:
        headers = {
            "Authorization": f"Bearer {DEFAULT_TOKEN}",
            "Origin": "https://music.apple.com",
            "User-Agent": USER_AGENT
        }
        st, raw_bytes, _, _ = net_pool.http_get(apple_url, headers=headers, timeout=timeout, secure=True)
        if st == 200 and raw_bytes:
            with _APPLE_CATALOG_CACHE_LOCK:
                if len(_APPLE_CATALOG_CACHE) > 300:
                    _APPLE_CATALOG_CACHE.pop(next(iter(_APPLE_CATALOG_CACHE)))
                _APPLE_CATALOG_CACHE[apple_url] = {"bytes": raw_bytes, "etag": "", "ts": time.time()}
            data = json.loads(raw_bytes.decode('utf-8'))
            items = data.get("data", [])
            if items:
                attrs = items[0].get("attributes", {})
                return {
                    "title": attrs.get("name", "").strip(),
                    "artist": attrs.get("artistName", "").strip(),
                    "duration": round(attrs.get("durationInMillis", 0) / 1000) or None
                }
    except Exception:
        pass
    return None

PORT = 8088
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIRECTORY = os.path.join(BASE_DIR, "public")

# 官方 Web 播放器公共只读访客 Token (有效期至 2027 年)
DEFAULT_TOKEN = (
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ."
    "eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ."
    "wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw"
)

# ========================================================
# 区块 2: HTTP 统一响应封装与 ETag 304 缓存协商
# ========================================================
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=DIRECTORY, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def send_json(self, data, status=200, cache_control=None, extra_headers=None):
        """统一 JSON 响应辅助函数，支持 ETag 与 HTTP 304 快速协商（客户端主导缓存）"""
        res_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        etag = f'"{hashlib.md5(res_bytes).hexdigest()}"'

        client_etag = self.headers.get("If-None-Match")
        if status == 200 and not extra_headers and client_etag and client_etag.strip('"') == etag.strip('"'):
            self.send_response(304)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("ETag", etag)
            if cache_control:
                self.send_header("Cache-Control", cache_control)
            self.end_headers()
            return

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache_control or "private, no-cache")
        if extra_headers:
            for k, v in extra_headers:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(res_bytes)))
        self.end_headers()
        self.wfile.write(res_bytes)

    def send_error_json(self, message, status=500):
        """统一错误 JSON 响应"""
        self.send_json({"error": str(message)}, status=status, cache_control="private, no-store")

    def _is_https_request(self) -> bool:
        proto = (self.headers.get("X-Forwarded-Proto") or "").strip().lower()
        return proto == "https" or bool(os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"))

    def _require_auth_user(self):
        """全局接口门禁校验：未通过认证一律返回 401"""
        user = verify_session(self.headers)
        if not user:
            self.send_json(
                {"error": "请先登录", "code": "AUTH_REQUIRED"},
                status=401,
                cache_control="private, no-store",
            )
            return None
        return user

    @staticmethod
    def _format_sources_data(ordered, force_sv=False):
        """真实透传音源健康度与实测延迟，杜绝虚假全绿（街声官方通道置顶第 1 行）"""
        data = []
        try:
            data.append(probe_sv_health(force=force_sv))
        except Exception:
            pass
        for s in ordered:
            lat = 9999.0 if (s.latency_ms == float('inf') or s.latency_ms is None) else round(s.latency_ms, 1)
            data.append({
                "id": s.id,
                "name": s.name,
                "platform": s.platform,
                "status": s.status,
                "latency_ms": lat,
                "consecutive_fails": s.consecutive_fails,
                "success_count": s.success_count
            })
        return data

    # ========================================================
    # 区块 3: GET 路由分发矩阵 (Apple 数据代理、歌词与音频流中继)
    # ========================================================
    def do_GET(self):
        parsed_req = urllib.parse.urlparse(self.path)
        req_path = parsed_req.path

        # 0. 登录态检查接口 (门禁豁免)
        if req_path == "/api/auth/me":
            user = verify_session(self.headers)
            if user:
                self.send_json({"authenticated": True, "username": user}, cache_control="private, no-store")
            else:
                self.send_json(
                    {"authenticated": False, "error": "请先登录", "code": "AUTH_REQUIRED"},
                    status=401,
                    cache_control="private, no-store",
                )
            return

        # 全局 /api/* 门禁拦截（静态资源与 /api/auth/* 放行）
        auth_user = None
        if req_path.startswith("/api/"):
            auth_user = self._require_auth_user()
            if not auth_user:
                return

        # 0.5 云端歌单资产读取
        if req_path == "/api/sync/library":
            try:
                lib = get_user_library(auth_user)
                self.send_json(lib, cache_control="private, no-store")
            except AuthClientError as ce:
                self.send_error_json(str(ce), ce.status)
            except AuthConfigError as cfg_e:
                self.send_error_json(str(cfg_e), 503)
            except Exception as e:
                self.send_error_json(str(e), 500)
            return

        # 1. /new 页面结构化抓取 (全歌单/专辑模式)
        if req_path == "/api/apple_new":
            sf = urllib.parse.parse_qs(parsed_req.query).get("storefront", ["cn"])[0]
            try:
                self.send_json(fetch_apple_new_page(sf))
            except Exception as e:
                self.send_error_json(e)
            return

        # 2. /search 探索中枢全部分类专区抓取
        if req_path == "/api/apple_search_page":
            sf = urllib.parse.parse_qs(parsed_req.query).get("storefront", ["cn"])[0]
            try:
                self.send_json(fetch_apple_search_page(sf))
            except Exception as e:
                self.send_error_json(e)
            return

        # 3. 专区官方主页真实板块抓取 (与官网 100% 对齐)
        if req_path in ("/api/apple_curator_page", "/api/apple_curator"):
            curator_url = urllib.parse.parse_qs(parsed_req.query).get("url", [""])[0]
            if not curator_url:
                self.send_error_json("Missing url parameter", 400)
                return
            if not is_safe_external_url(curator_url, allowed_hosts=["music.apple.com"]):
                self.send_error_json("Invalid Apple Music URL: only https://music.apple.com is allowed", 403)
                return
            try:
                self.send_json(fetch_apple_curator_page(curator_url))
            except Exception as e:
                self.send_error_json(e)
            return

        # 4. 专题 Room 完整曲目抓取 (如 100 首完整合集)
        if req_path == "/api/apple_room":
            room_url = urllib.parse.parse_qs(parsed_req.query).get("url", [""])[0]
            if not room_url:
                self.send_error_json("Missing url parameter", 400)
                return
            if not is_safe_external_url(room_url, allowed_hosts=["music.apple.com"]):
                self.send_error_json("Invalid Apple Music URL: only https://music.apple.com is allowed", 403)
                return
            try:
                self.send_json({"tracks": fetch_apple_room(room_url)})
            except Exception as e:
                self.send_error_json(e)
            return

        # 5. 官方数据库请求代理转发 (附带 Bearer Token 与合法 Origin，支持 304 快速协商)
        if req_path.startswith("/api/apple/"):
            apple_path = self.path[len("/api/apple/"):]
            if not apple_path or ".." in apple_path or "@" in apple_path or "\\" in apple_path or re.search(r"[\s\x00-\x1f]", apple_path):
                self.send_error_json("Invalid Apple API path", 400)
                return
            # 安全钳制：Apple Music 官方 search 等接口 limit 上限为 25
            apple_path = re.sub(r'([?&]limit=)(?:[3-9]\d|\d{3,}|2[6-9])', r'\g<1>25', apple_path)
            apple_url = f"https://api.music.apple.com/{apple_path}"
            client_etag = self.headers.get("If-None-Match")

            # 方案 4: 快速命中服务端内存二级缓存 (0ms 秒开，消除反复连 Apple 官方的物理延迟)
            now_t = time.time()
            with _APPLE_CATALOG_CACHE_LOCK:
                cached_item = _APPLE_CATALOG_CACHE.get(apple_url)
                if cached_item and (now_t - cached_item["ts"]) < _APPLE_CATALOG_TTL_SEC:
                    etag = cached_item["etag"]
                    if client_etag and client_etag.strip('"') == etag.strip('"'):
                        self.send_response(304)
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.send_header("ETag", etag)
                        self.end_headers()
                        return
                    res_bytes = cached_item["bytes"]
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "private, no-cache")
                    self.send_header("Content-Length", str(len(res_bytes)))
                    self.end_headers()
                    self.wfile.write(res_bytes)
                    return

            try:
                headers = {
                    "Authorization": f"Bearer {DEFAULT_TOKEN}",
                    "Origin": "https://music.apple.com",
                    "User-Agent": USER_AGENT
                }
                if client_etag:
                    headers["If-None-Match"] = client_etag
                st, res_bytes, _, resp_hdrs = net_pool.http_get(apple_url, headers=headers, timeout=12, secure=True)
                if st == 304:
                    self.send_response(304)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    if client_etag:
                        self.send_header("ETag", client_etag)
                    self.end_headers()
                    return
                if st == 200 and res_bytes:
                    etag = resp_hdrs.get("ETag") or resp_hdrs.get("etag") or f'"{hashlib.md5(res_bytes).hexdigest()}"'
                    with _APPLE_CATALOG_CACHE_LOCK:
                        if len(_APPLE_CATALOG_CACHE) > 300:
                            _APPLE_CATALOG_CACHE.pop(next(iter(_APPLE_CATALOG_CACHE)))
                        _APPLE_CATALOG_CACHE[apple_url] = {"bytes": res_bytes, "etag": etag, "ts": time.time()}

                    if client_etag and client_etag.strip('"') == etag.strip('"'):
                        self.send_response(304)
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.send_header("ETag", etag)
                        self.end_headers()
                        return

                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "private, no-cache")
                    self.send_header("Content-Length", str(len(res_bytes)))
                    self.end_headers()
                    self.wfile.write(res_bytes)
                    return
                if st > 0:
                    self.send_response(st)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(res_bytes)))
                    self.end_headers()
                    self.wfile.write(res_bytes)
                    return
                self.send_error_json("Upstream Apple Music request failed", 502)
            except Exception as e:
                self.send_error_json(e)
            return

        # 5.5 街声专区目录与曲目接口 (启用门禁后严禁 Edge CDN 公共缓存跨用户下发)
        sv_cache_ctl = "private, no-cache"
        if req_path == "/api/sv_charts":
            qs = urllib.parse.parse_qs(parsed_req.query)
            kind = qs.get("kind", [""])[0]
            category = qs.get("category", [""])[0]
            try:
                if kind and category:
                    self.send_json(fetch_sv_chart(kind, category), cache_control=sv_cache_ctl)
                else:
                    self.send_json(get_sv_chart_catalog(), cache_control=sv_cache_ctl)
            except Exception as e:
                self.send_error_json(e, status=400 if isinstance(e, ValueError) else 500)
            return

        if req_path == "/api/sv_playlists":
            qs = urllib.parse.parse_qs(parsed_req.query)
            section = qs.get("section", ["all"])[0]
            try:
                page = int(qs.get("page", ["1"])[0])
            except Exception:
                page = 1
            try:
                self.send_json(fetch_sv_playlists(section=section, page=page), cache_control=sv_cache_ctl)
            except Exception as e:
                self.send_error_json(e)
            return

        if req_path == "/api/sv_playlist_songs":
            qs = urllib.parse.parse_qs(parsed_req.query)
            pid = qs.get("id", [""])[0]
            try:
                self.send_json(fetch_sv_playlist_songs(pid), cache_control=sv_cache_ctl)
            except Exception as e:
                self.send_error_json(e, status=400 if isinstance(e, ValueError) else 500)
            return

        # 6. 音频底层：音源健康度队列 (真实透传各音源健康度与延迟)
        if req_path == "/api/sources":
            ordered = source_hub.get_ordered_sources()
            data = self._format_sources_data(ordered, force_sv=False)
            self.send_json({
                "tested_at": source_hub.tested_at,
                "sources": data
            })
            return

        # 7. 音频底层：歌曲候选检索 (带 OpenCC 繁简转换与多维打分)
        if req_path == "/api/search_song":
            try:
                qs = urllib.parse.parse_qs(parsed_req.query)
                q = qs.get("q", [""])[0]
                artist = qs.get("artist", [""])[0]
                dur = qs.get("duration", [None])[0]
                if dur:
                    try:
                        dur = float(dur)
                    except Exception:
                        dur = None
                cands = search_candidates(q, artist, target_duration=dur)
                self.send_json(cands)
            except Exception as e:
                self.send_error_json(str(e))
            return

        # 8. 音频底层：歌词毫秒级时间轴直通提取
        if req_path == "/api/lyric":
            qs = urllib.parse.parse_qs(parsed_req.query)
            plat = qs.get("platform", ["kw"])[0]
            sid = qs.get("id", [""])[0]
            title = qs.get("title", [""])[0]
            artist = qs.get("artist", [""])[0]
            if (plat or "").strip().lower() == "streetvoice":
                self.send_json(fetch_sv_song_lyrics(sid))
                return
            lines = get_song_lyric(plat, sid, title, artist)
            self.send_json(lines)
            return

        # 9. 零内存流转发中继 (逐跳重定向 SSRF 防护 + 连接池复用)
        if req_path == "/api/stream_proxy":
            qs = urllib.parse.parse_qs(parsed_req.query)
            target_url = qs.get("url", [""])[0]
            if not target_url:
                self.send_error_json("Missing url parameter", 400)
                return
            if not is_safe_external_url(target_url):
                self.send_error_json("Forbidden target URL (SSRF and local file protection)", 403)
                return

            resp_obj = None
            try:
                cur_url = target_url
                for _ in range(5):
                    if not net_pool._HTTP_POOL:
                        raise RuntimeError("HTTP pool unavailable")
                    r = net_pool._HTTP_POOL.request(
                        "GET",
                        cur_url,
                        headers={"User-Agent": USER_AGENT},
                        timeout=20,
                        redirect=False,
                        preload_content=False,
                    )
                    if r.status in (301, 302, 303, 307, 308):
                        loc = r.headers.get("Location") or r.headers.get("location") or ""
                        r.release_conn()
                        next_url = urllib.parse.urljoin(cur_url, loc)
                        if not is_safe_external_url(next_url):
                            self.send_error_json("Forbidden redirect target (SSRF protection)", 403)
                            return
                        cur_url = next_url
                        continue
                    resp_obj = r
                    break

                if resp_obj is None:
                    self.send_error_json("Too many redirects", 502)
                    return

                if resp_obj.status not in (200, 206):
                    self.send_error_json(f"Upstream HTTP {resp_obj.status}", 502)
                    return

                self.send_response(200)
                self.send_header("Content-Type", resp_obj.headers.get("Content-Type", "audio/mpeg"))
                self.send_header("Access-Control-Allow-Origin", "*")
                cl = resp_obj.headers.get("Content-Length") or resp_obj.headers.get("content-length")
                if cl:
                    self.send_header("Content-Length", cl)
                self.end_headers()
                while True:
                    chunk = resp_obj.read(65536)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break
            except Exception as e:
                self.send_error_json(str(e), 502)
            finally:
                if resp_obj is not None:
                    try:
                        resp_obj.release_conn()
                    except Exception:
                        pass
            return

        if req_path.startswith("/api/"):
            self.send_error_json("API Not Found", 404)
            return

        # 仅提供 public/ 目录内的静态文件，严禁目录浏览
        local_fs_path = self.translate_path(self.path)
        if os.path.isdir(local_fs_path) and req_path != "/":
            self.send_error(404, "Not Found")
            return
        super().do_GET()

    # ========================================================
    # 区块 4: POST 路由分发矩阵 (音源测速、同步与全源双核冲刺)
    # ========================================================
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
        except (ValueError, TypeError):
            self.send_error_json("Invalid Content-Length", 400)
            return
        if length < 0 or length > 2 * 1024 * 1024:
            self.send_error_json("Payload too large or invalid", 413 if length > 0 else 400)
            return
        body = self.rfile.read(length).decode('utf-8', errors='replace') if length > 0 else ""

        # 0. 登录 / 注册 / 退出接口 (门禁豁免)
        if path in ("/api/auth/register", "/api/auth/login", "/api/auth/logout"):
            secure_cookie = self._is_https_request()
            if path == "/api/auth/logout":
                self.send_json(
                    {"ok": True},
                    cache_control="private, no-store",
                    extra_headers=[("Set-Cookie", build_clear_cookie_header(secure=secure_cookie))],
                )
                return

            try:
                payload = json.loads(body) if body else {}
                if not isinstance(payload, dict):
                    payload = {}
            except Exception:
                self.send_error_json("Invalid JSON payload", 400)
                return

            username = payload.get("username", "")
            password = payload.get("password", "")

            if path == "/api/auth/register":
                invite_code = payload.get("inviteCode") or payload.get("invite_code") or ""
                try:
                    res = register_user(username, password, invite_code)
                    self.send_json(
                        {
                            "authenticated": True,
                            "username": res["username"],
                            "library": res["library"],
                        },
                        cache_control="private, no-store",
                        extra_headers=[("Set-Cookie", build_session_cookie_header(res["token"], secure=secure_cookie))],
                    )
                except AuthClientError as ce:
                    self.send_error_json(str(ce), ce.status)
                except AuthConfigError as cfg_e:
                    self.send_error_json(str(cfg_e), 503)
                except Exception as e:
                    self.send_error_json(str(e), 500)
                return

            if path == "/api/auth/login":
                try:
                    res = login_user(username, password)
                    self.send_json(
                        {"authenticated": True, "username": res["username"]},
                        cache_control="private, no-store",
                        extra_headers=[("Set-Cookie", build_session_cookie_header(res["token"], secure=secure_cookie))],
                    )
                except AuthClientError as ce:
                    self.send_error_json(str(ce), ce.status)
                except AuthConfigError as cfg_e:
                    self.send_error_json(str(cfg_e), 503)
                except Exception as e:
                    self.send_error_json(str(e), 500)
                return

        # 全局 /api/* POST 门禁拦截
        auth_user = self._require_auth_user()
        if not auth_user:
            return

        # 云端歌单资产保存 (POST /api/sync/library)
        if path == "/api/sync/library":
            try:
                payload = json.loads(body) if body else {}
            except Exception:
                self.send_error_json("Invalid JSON payload", 400)
                return
            try:
                saved = save_user_library(auth_user, payload)
                self.send_json({"ok": True, "updatedAt": saved["updatedAt"]}, cache_control="private, no-store")
            except AuthClientError as ce:
                self.send_error_json(str(ce), ce.status)
            except AuthConfigError as cfg_e:
                self.send_error_json(str(cfg_e), 503)
            except Exception as e:
                self.send_error_json(str(e), 500)
            return

        # 音源并发测速重排 (真实透传实测结果)
        if path in ("/api/sources/test", "/api/sources_test"):
            source_hub.test_all()
            ordered = source_hub.get_ordered_sources()
            data = self._format_sources_data(ordered, force_sv=True)
            self.send_json({
                "tested_at": source_hub.tested_at,
                "sources": data
            })
            return

        # 同步音源并就地测速重排 (纯 Python 原生通道)
        if path in ("/api/sources/sync", "/api/sources_sync"):
            source_hub.test_all()
            ordered = source_hub.get_ordered_sources()
            data = self._format_sources_data(ordered, force_sv=True)
            self.send_json({
                "tested_at": source_hub.tested_at,
                "sources": data
            })
            return

        # 核心音频流双核并发解析：委托 resolver.py 执行策略 A（短路式阶梯寻链）
        if path == "/api/resolve":
            try:
                cand = json.loads(body) if body else {}
                if not isinstance(cand, dict):
                    cand = {}
            except Exception:
                self.send_error_json("Invalid JSON payload", 400)
                return
            res_payload, res_status = resolve_track(cand, fetch_apple_native_fn=_fetch_apple_native_metadata)
            self.send_json(res_payload, status=res_status)
            return

        self.send_error(404, "Not Found")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def log_message(self, format, *args):
        try:
            sys.stdout.write(f"[Amusic] {self.address_string()} - {format % args}\n")
            sys.stdout.flush()
        except Exception:
            pass

# ========================================================
# 区块 5: 多线程 TCP 服务实体与异步测速预热引导
# ========================================================
class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    os.chdir(DIRECTORY)
    listen_port = int(os.environ.get("PORT") or os.environ.get("AMUSIC_PORT") or PORT)
    # 异步预热音源并发测速，零阻塞 HTTP 即时响应（非 Vercel 环境下启动）
    if not os.environ.get("VERCEL"):
        def _warmup_sources():
            try:
                probe_sv_health(force=False)
            except Exception:
                pass
            source_hub.test_all()
        threading.Thread(target=_warmup_sources, daemon=True).start()

    with ThreadingTCPServer(("0.0.0.0", listen_port), Handler) as httpd:
        print(f"==================================================")
        print(f"🍎 Amusic (Apple 音乐纯文本数据库浏览器 + 音频底座) 已就绪！")
        print(f"本地访问地址: http://127.0.0.1:{PORT}")
        print(f"局域网地址:   http://0.0.0.0:{PORT}")
        print(f"==================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已平滑关闭。")
