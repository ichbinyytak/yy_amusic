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

# ----------------------------------------------------
# 优先 IPv4 地址解析 (解决跨国/Serverless云机房对国内双栈域名的 IPv6 黑洞与握手超时)
# ----------------------------------------------------
try:
    _orig_getaddrinfo = socket.getaddrinfo

    def _ipv4_first_getaddrinfo(*args, **kwargs):
        res = _orig_getaddrinfo(*args, **kwargs)
        ipv4 = [r for r in res if r[0] == socket.AF_INET]
        return ipv4 if ipv4 else res

    socket.getaddrinfo = _ipv4_first_getaddrinfo
except Exception:
    pass

# 引入底层音源调度与歌曲检索核心模块 (来自 music_underlying)
from source_manager import source_hub
from song_search import search_candidates, search_candidates_fallback, get_song_lyric
from kv_cache import get_cached_candidate, set_cached_candidate, delete_cached_candidate

# 核心音频寻链热点缓存 (Title+Artist -> ResolveResult)，存活 15 分钟 (对齐前端 TTL，杜绝 CDN Token 过期 403)，容量 256 首
_RESOLVE_CACHE = {}
_RESOLVE_CACHE_LOCK = threading.Lock()
_CACHE_MAX_ENTRIES = 256
_CACHE_TTL_SEC = 900  # 15 分钟缓存期

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

# ========================================================
# 区块 1: 网络安全校验与 SSRF / 私网穿透探测防护
# ========================================================
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

        # 3. 拦截私有 IP 与链路本地段 (防御针对 169.254.x.x / 192.168.x.x 等地址的 SSRF)
        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
                return False
        except ValueError:
            # 域名解析 A/AAAA 记录防 DNS 重绑定或内网解析绕过 (Fail-Close 默认安全原则)
            try:
                addrinfo = socket.getaddrinfo(hostname, None)
                if not addrinfo:
                    return False
                for item in addrinfo:
                    resolved_ip = ipaddress.ip_address(item[4][0])
                    if resolved_ip.is_private or resolved_ip.is_loopback or resolved_ip.is_link_local or resolved_ip.is_reserved:
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
        req = urllib.request.Request(apple_url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_bytes = resp.read()
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
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

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

    def send_json(self, data, status=200):
        """统一 JSON 响应辅助函数，支持 ETag 与 HTTP 304 快速协商（客户端主导缓存）"""
        res_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        etag = f'"{hashlib.md5(res_bytes).hexdigest()}"'

        client_etag = self.headers.get("If-None-Match")
        if client_etag and client_etag.strip('"') == etag.strip('"'):
            self.send_response(304)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("ETag", etag)
            self.end_headers()
            return

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private, no-cache")
        self.send_header("Content-Length", str(len(res_bytes)))
        self.end_headers()
        self.wfile.write(res_bytes)

    def send_error_json(self, message, status=500):
        """统一错误 JSON 响应"""
        self.send_json({"error": str(message)}, status=status)

    @staticmethod
    def _format_sources_data(ordered):
        """真实透传音源健康度与实测延迟，杜绝虚假全绿"""
        data = []
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
        # 1. /new 页面结构化抓取 (全歌单/专辑模式)
        if self.path.startswith("/api/apple_new"):
            parsed = urllib.parse.urlparse(self.path)
            sf = urllib.parse.parse_qs(parsed.query).get("storefront", ["cn"])[0]
            try:
                self.send_json(fetch_apple_new_page(sf))
            except Exception as e:
                self.send_error_json(e)
            return

        # 2. /search 探索中枢全部分类专区抓取
        if self.path.startswith("/api/apple_search_page"):
            parsed = urllib.parse.urlparse(self.path)
            sf = urllib.parse.parse_qs(parsed.query).get("storefront", ["cn"])[0]
            try:
                self.send_json(fetch_apple_search_page(sf))
            except Exception as e:
                self.send_error_json(e)
            return

        # 3. 专区官方主页真实板块抓取 (与官网 100% 对齐)
        if self.path.startswith("/api/apple_curator_page") or self.path.startswith("/api/apple_curator"):
            parsed = urllib.parse.urlparse(self.path)
            curator_url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
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
        if self.path.startswith("/api/apple_room"):
            parsed = urllib.parse.urlparse(self.path)
            room_url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
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
        if self.path.startswith("/api/apple/"):
            apple_path = self.path[len("/api/apple/"):]
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
                req = urllib.request.Request(apple_url, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=12) as resp:
                        res_bytes = resp.read()
                        etag = resp.headers.get("ETag") or f'"{hashlib.md5(res_bytes).hexdigest()}"'

                        # 写入服务端内存缓存
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

                        self.send_response(resp.status)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.send_header("ETag", etag)
                        self.send_header("Cache-Control", "private, no-cache")
                        self.send_header("Content-Length", str(len(res_bytes)))
                        self.end_headers()
                        self.wfile.write(res_bytes)
                except urllib.error.HTTPError as he:
                    if he.code == 304:
                        self.send_response(304)
                        self.send_header("Access-Control-Allow-Origin", "*")
                        if client_etag:
                            self.send_header("ETag", client_etag)
                        self.end_headers()
                        return
                    err_data = he.read()
                    self.send_response(he.code)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(err_data)))
                    self.end_headers()
                    self.wfile.write(err_data)
            except Exception as e:
                self.send_error_json(e)
            return

        # 6. 音频底层：音源健康度队列 (真实透传各音源健康度与延迟)
        if self.path == "/api/sources":
            ordered = source_hub.get_ordered_sources()
            data = self._format_sources_data(ordered)
            self.send_json({
                "tested_at": source_hub.tested_at,
                "sources": data
            })
            return

        # 7. 音频底层：歌曲候选检索 (带 OpenCC 繁简转换与多维打分)
        if self.path.startswith("/api/search_song"):
            try:
                parsed = urllib.parse.urlparse(self.path)
                qs = urllib.parse.parse_qs(parsed.query)
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
        if self.path.startswith("/api/lyric"):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            plat = qs.get("platform", ["kw"])[0]
            sid = qs.get("id", [""])[0]
            title = qs.get("title", [""])[0]
            artist = qs.get("artist", [""])[0]
            lines = get_song_lyric(plat, sid, title, artist)
            self.send_json(lines)
            return

        # 9. 零内存流转发中继 (用于前端纯客户端打包 ZIP 跨域音频拉流)
        if self.path.startswith("/api/stream_proxy"):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            target_url = qs.get("url", [""])[0]
            if not target_url:
                self.send_error_json("Missing url parameter", 400)
                return
            if not is_safe_external_url(target_url):
                self.send_error_json("Forbidden target URL (SSRF and local file protection)", 403)
                return
            try:
                req = urllib.request.Request(target_url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    self.send_response(200)
                    self.send_header("Content-Type", resp.headers.get("Content-Type", "audio/mpeg"))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    if "Content-Length" in resp.headers:
                        self.send_header("Content-Length", resp.headers["Content-Length"])
                    self.end_headers()
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except Exception as e:
                self.send_error_json(str(e), 502)
            return

        super().do_GET()

    # ========================================================
    # 区块 4: POST 路由分发矩阵 (音源测速、同步与全源双核冲刺)
    # ========================================================
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length > 0 else ""

        # 音源并发测速重排 (真实透传实测结果)
        if path in ("/api/sources/test", "/api/sources_test"):
            source_hub.test_all()
            ordered = source_hub.get_ordered_sources()
            data = self._format_sources_data(ordered)
            self.send_json({
                "tested_at": source_hub.tested_at,
                "sources": data
            })
            return

        # 同步 lx-hub 音源并测速
        if path in ("/api/sources/sync", "/api/sources_sync"):
            source_hub.sync_from_lx_hub()
            source_hub.test_all()
            ordered = source_hub.get_ordered_sources()
            data = self._format_sources_data(ordered)
            self.send_json({
                "tested_at": source_hub.tested_at,
                "sources": data
            })
            return

        # 核心音频流双核并发解析：贯彻策略 A（短路式阶梯寻链，追求极速出声）
        if path == "/api/resolve":
            req_start = time.time()
            # 严格时间预算锚定：从请求接收刻起算全局预算 7.5s (在 Vercel 10s 物理上限内保留 2.5s 充裕余量，杜绝 504 Gateway Timeout)
            overall_deadline = req_start + 7.5

            cand = json.loads(body) if body else {}
            title = (cand.get("title") or cand.get("name") or "").strip()
            artist = (cand.get("artist") or "").strip()
            album = cand.get("album", "")
            duration = cand.get("duration")
            if not duration and cand.get("durationMillis"):
                duration = round(cand.get("durationMillis", 0) / 1000)

            # 0. 快速检查内存热点缓存：同歌单重复切歌或复听 0ms 秒开
            # 兼容 Apple Music 歌单切歌（即便带有 Apple ID，只要不是已知具体音源平台 platform 即适用标题缓存）
            cache_key = f"{title.lower()}_{artist.lower()}".strip() if (title and not cand.get("platform")) else ""
            if cache_key:
                with _RESOLVE_CACHE_LOCK:
                    entry = _RESOLVE_CACHE.get(cache_key)
                    if entry and (time.time() - entry["ts"]) < _CACHE_TTL_SEC:
                        cached_res = dict(entry["res"])
                        cached_res["source_name"] = str(cached_res.get("source_name", "")) + " ⚡快取"
                        self.send_json(cached_res)
                        return

            # 1. 如果已有确切的平台与歌曲 ID，优先直接调度
            if cand.get("platform") and cand.get("id"):
                remaining = overall_deadline - time.time()
                if remaining > 0.6:
                    res = source_hub.resolve_best_stream(cand, timeout_budget=remaining)
                    if res and res.get("success"):
                        if (overall_deadline - time.time()) > 0.8:
                            try:
                                res["lyrics"] = get_song_lyric(cand.get("platform", ""), cand.get("id", ""), title, artist)
                            except Exception:
                                res["lyrics"] = []
                        else:
                            res["lyrics"] = []
                        self.send_json(res)
                        return

            # 1.5 跨会话与跨容器云端 ID 沉淀快速检查 (Vercel Upstash KV)
            if title and not cand.get("platform"):
                cloud_cand = get_cached_candidate(title, artist)
                if cloud_cand and cloud_cand.get("platform") and cloud_cand.get("id"):
                    cloud_cand["duration"] = cloud_cand.get("duration") or duration
                    remaining = overall_deadline - time.time()
                    if remaining > 0.6:
                        res = source_hub.resolve_best_stream(cloud_cand, timeout_budget=remaining)
                        if res and res.get("success"):
                            res["matched_candidate"] = cloud_cand
                            res["target_title"] = title
                            res["target_artist"] = artist
                            res["source_name"] = str(res.get("source_name", "")) + " ☁️云快取"
                            if (overall_deadline - time.time()) > 0.8:
                                try:
                                    res["lyrics"] = get_song_lyric(cloud_cand.get("platform", ""), cloud_cand.get("id", ""), title, artist)
                                except Exception:
                                    res["lyrics"] = []
                            else:
                                res["lyrics"] = []
                            if cache_key:
                                with _RESOLVE_CACHE_LOCK:
                                    if len(_RESOLVE_CACHE) >= _CACHE_MAX_ENTRIES:
                                        _RESOLVE_CACHE.pop(next(iter(_RESOLVE_CACHE)))
                                    _RESOLVE_CACHE[cache_key] = {"res": res, "ts": time.time()}
                            self.send_json(res)
                            return
                        else:
                            # 【防线 3: 自愈机制】若云端已存 ID 在第三方下架失效，立刻删除作废，平滑进入多通道全搜
                            delete_cached_candidate(title, artist)

            # 2. 纯 Apple Music 元数据：贯彻【策略 A 短路式阶梯寻链】
            search_key = f"{title} {artist}".strip() if title else ""
            if not search_key:
                self.send_error_json("缺少有效歌名或候选信息", 400)
                return

            last_err = "未找到候选歌曲"

            # 动态检查剩余预算
            if time.time() >= (overall_deadline - 1.0):
                self.send_json({
                    "success": False,
                    "error": "请求时间预算耗尽",
                    "title": title,
                    "artist": artist
                })
                return

            # ----------------------------------------------------
            # 方案 1: 全息多通道并发检索与跨平台容灾冲刺
            # ----------------------------------------------------
            cands = search_candidates(search_key, target_artist=artist, target_title=title, target_duration=duration)

            # 跨平台优选：优先提取不同平台的最高分候选 (如 kw 最优、wy 最优)，杜绝同平台连续试错
            selected_cands = []
            seen_platforms = set()
            for c in cands:
                plat = c.get("platform")
                if plat not in seen_platforms:
                    selected_cands.append(c)
                    seen_platforms.add(plat)
                if len(selected_cands) >= 2:
                    break
            if len(selected_cands) < 2:
                for c in cands:
                    if c not in selected_cands:
                        selected_cands.append(c)
                    if len(selected_cands) >= 2:
                        break

            for c in selected_cands:
                rem = overall_deadline - time.time()
                if rem <= 1.2:
                    break
                c["duration"] = c.get("duration") or duration
                res = source_hub.resolve_best_stream(c, timeout_budget=min(2.5, max(0.6, rem - 0.8)))
                if res and res.get("success"):
                    res["matched_candidate"] = c
                    res["target_title"] = title
                    res["target_artist"] = artist
                    if (overall_deadline - time.time()) > 0.8:
                        try:
                            res["lyrics"] = get_song_lyric(c.get("platform", ""), c.get("id", ""), title, artist)
                        except Exception:
                            res["lyrics"] = []
                    else:
                        res["lyrics"] = []
                    if cache_key:
                        with _RESOLVE_CACHE_LOCK:
                            if len(_RESOLVE_CACHE) >= _CACHE_MAX_ENTRIES:
                                _RESOLVE_CACHE.pop(next(iter(_RESOLVE_CACHE)))
                            _RESOLVE_CACHE[cache_key] = {"res": res, "ts": time.time()}
                    # 【防线 1 与 2】真实出声且原唱高分 (>=80) 候选存入云端 KV
                    if c.get("score", 0) >= 80.0:
                        try:
                            set_cached_candidate(title, artist, c)
                        except Exception:
                            pass
                    self.send_json(res)
                    return  # 一击即中，立即短路！彻底截断一切后续网络开销！
                elif res and res.get("error"):
                    last_err = res["error"]

            # ----------------------------------------------------
            # 策略 A 第 1.5 阶梯（原生母语转译）：
            # 针对海外/香港/台湾 Apple Storefront 将日韩等非英语曲目英译/罗马音化（如 musubi, Shiwaawase, Lilac）导致国内音源搜空的物理痛点，
            # 通过 Apple 官方原生目录反查母语原名（如 結び, しわあわせ, ライラック），打通多平台正版检索
            # ----------------------------------------------------
            apple_song_id = str(cand.get("id") or "").strip()
            rem = overall_deadline - time.time()
            if apple_song_id.isdigit() and rem > 2.0:
                apple_timeout = min(1.5, max(0.5, rem - 1.2))
                native_meta = _fetch_apple_native_metadata(apple_song_id, timeout=apple_timeout)
                if native_meta and (native_meta.get("title") != title or native_meta.get("artist") != artist):
                    native_t = native_meta.get("title")
                    native_a = native_meta.get("artist") or artist
                    native_dur = native_meta.get("duration") or duration
                    native_cands = search_candidates(f"{native_t} {native_a}", target_artist=native_a, target_title=native_t, target_duration=native_dur)
                    for nc in native_cands[:2]:
                        rem_cand = overall_deadline - time.time()
                        if rem_cand <= 1.0:
                            break
                        nc["duration"] = nc.get("duration") or native_dur
                        res = source_hub.resolve_best_stream(nc, timeout_budget=min(2.2, max(0.6, rem_cand - 0.6)))
                        if res and res.get("success"):
                            res["matched_candidate"] = nc
                            res["target_title"] = title
                            res["target_artist"] = artist
                            res["native_title"] = native_t
                            res["native_artist"] = native_a
                            res["source_name"] = str(res.get("source_name", "")) + " 🌸母语精配"
                            if (overall_deadline - time.time()) > 0.8:
                                try:
                                    res["lyrics"] = get_song_lyric(nc.get("platform", ""), nc.get("id", ""), native_t, native_a)
                                except Exception:
                                    res["lyrics"] = []
                            else:
                                res["lyrics"] = []
                            if cache_key:
                                with _RESOLVE_CACHE_LOCK:
                                    if len(_RESOLVE_CACHE) >= _CACHE_MAX_ENTRIES:
                                        _RESOLVE_CACHE.pop(next(iter(_RESOLVE_CACHE)))
                                    _RESOLVE_CACHE[cache_key] = {"res": res, "ts": time.time()}
                            if nc.get("score", 0) >= 80.0:
                                try:
                                    set_cached_candidate(title, artist, nc)
                                except Exception:
                                    pass
                            self.send_json(res)
                            return

            # ----------------------------------------------------
            # 策略 A 第二阶梯（独家兜底）：当第一梯队全部候选尝试失败时激活 QQ 音乐精准补漏
            # 弹性受 overall_deadline 预算约束 (保留 1.4 秒底线)，动态分配剩余预算
            # ----------------------------------------------------
            rem = overall_deadline - time.time()
            if rem > 1.4:
                fallback_cands = search_candidates_fallback(search_key, target_artist=artist, target_title=title, target_duration=duration)
                for fc in fallback_cands[:2]:
                    rem_fb = overall_deadline - time.time()
                    if rem_fb <= 0.6:
                        break
                    fc["duration"] = fc.get("duration") or duration
                    res = source_hub.resolve_best_stream(fc, timeout_budget=rem_fb)
                    if res and res.get("success"):
                        res["matched_candidate"] = fc
                        res["target_title"] = title
                        res["target_artist"] = artist
                        if (overall_deadline - time.time()) > 0.8:
                            try:
                                res["lyrics"] = get_song_lyric(fc.get("platform", ""), fc.get("id", ""), title, artist)
                            except Exception:
                                res["lyrics"] = []
                        else:
                            res["lyrics"] = []
                        if cache_key:
                            with _RESOLVE_CACHE_LOCK:
                                if len(_RESOLVE_CACHE) >= _CACHE_MAX_ENTRIES:
                                    _RESOLVE_CACHE.pop(next(iter(_RESOLVE_CACHE)))
                                _RESOLVE_CACHE[cache_key] = {"res": res, "ts": time.time()}
                        # 【防线 1 与 2】真实出声且原唱高分 (>=80) 候选沉淀入云端 KV
                        if fc.get("score", 0) >= 80.0:
                            try:
                                set_cached_candidate(title, artist, fc)
                            except Exception:
                                pass
                        self.send_json(res)
                        return  # 兜底成功，即刻出声
                    elif res and res.get("error"):
                        last_err = res["error"]

            self.send_json({
                "success": False,
                "error": f"全源库冲刺完成，未能匹配到有效音频流: {last_err}",
                "title": title,
                "artist": artist
            })
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
    # 异步预热音源并发测速，零阻塞 HTTP 即时响应（非 Vercel 环境下启动）
    if not os.environ.get("VERCEL"):
        threading.Thread(target=source_hub.test_all, daemon=True).start()

    with ThreadingTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"==================================================")
        print(f"🍎 Amusic (Apple 音乐纯文本数据库浏览器 + 音频底座) 已就绪！")
        print(f"本地访问地址: http://127.0.0.1:{PORT}")
        print(f"局域网地址:   http://0.0.0.0:{PORT}")
        print(f"==================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已平滑关闭。")
