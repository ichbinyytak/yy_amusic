#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
streetvoice_catalog.py - 街声 StreetVoice 专区数据抓取与 HLS 直通解析中枢
包含：
1. 官方排行榜目录与 SSR HTML 解析 (15 榜 × Top 50: 8 即时榜 + 7 周榜)
2. 精选歌单广场与 7 大主题分区解析 (支持分批翻页与二级内存缓存)
3. 歌单曲目明细 JSON 提取 (/api/v5/playlist/{id}/songs/)
4. 单曲 HLS 播放流与歌词并行解析 (.com 192k 主线 + .cn 96k 自动降级)
5. 真实连通性健康度探针 (probe_sv_health，供顶部 ⚡ 音源监控第 1 行展示)
"""

import html as html_lib
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from net_pool import http_get, http_post_json
from lyric_service import _parse_lrc_text

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# ========================================================
# 静态目录枚举：15 个官方排行榜 + 精选歌单 7 大主题分区
# ========================================================
SV_CHART_DEFINITIONS = [
    # 即时排行 (8 榜)
    {"id": "sv_chart_realtime_all", "kind": "realtime", "category": "all", "group": "即时排行", "title": "即时榜 · 总榜"},
    {"id": "sv_chart_realtime_rock", "kind": "realtime", "category": "rock", "group": "即时排行", "title": "即时榜 · 摇滚"},
    {"id": "sv_chart_realtime_folk", "kind": "realtime", "category": "folk", "group": "即时排行", "title": "即时榜 · 民谣"},
    {"id": "sv_chart_realtime_hip_hop", "kind": "realtime", "category": "hip_hop", "group": "即时排行", "title": "即时榜 · 嘻哈"},
    {"id": "sv_chart_realtime_urban", "kind": "realtime", "category": "urban", "group": "即时排行", "title": "即时榜 · 都会"},
    {"id": "sv_chart_realtime_electronic", "kind": "realtime", "category": "electronic", "group": "即时排行", "title": "即时榜 · 电子"},
    {"id": "sv_chart_realtime_explore", "kind": "realtime", "category": "explore", "group": "即时排行", "title": "即时榜 · 探索"},
    {"id": "sv_chart_realtime_ai_generated", "kind": "realtime", "category": "ai_generated", "group": "即时排行", "title": "即时榜 · AI 生成"},
    # 每周排行 (7 榜)
    {"id": "sv_chart_weekly_all", "kind": "weekly", "category": "all", "group": "每周排行", "title": "每周榜 · 总榜"},
    {"id": "sv_chart_weekly_rock", "kind": "weekly", "category": "rock", "group": "每周排行", "title": "每周榜 · 摇滚"},
    {"id": "sv_chart_weekly_folk", "kind": "weekly", "category": "folk", "group": "每周排行", "title": "每周榜 · 民谣"},
    {"id": "sv_chart_weekly_hip_hop", "kind": "weekly", "category": "hip_hop", "group": "每周排行", "title": "每周榜 · 嘻哈"},
    {"id": "sv_chart_weekly_urban", "kind": "weekly", "category": "urban", "group": "每周排行", "title": "每周榜 · 都会"},
    {"id": "sv_chart_weekly_electronic", "kind": "weekly", "category": "electronic", "group": "每周排行", "title": "每周榜 · 电子"},
    {"id": "sv_chart_weekly_explore", "kind": "weekly", "category": "explore", "group": "每周排行", "title": "每周榜 · 探索"},
]

_VALID_CHART_KEYS = {(c["kind"], c["category"]): c for c in SV_CHART_DEFINITIONS}

SV_PLAYLIST_SECTIONS = [
    {"id": "all", "title": "精选推荐", "count_hint": 63},
    {"id": "1", "title": "特别企划", "count_hint": 338},
    {"id": "chillouttree", "title": "小树精选", "count_hint": 132},
    {"id": "DJ", "title": "驻站 DJ", "count_hint": 41},
    {"id": "campus", "title": "校园推广", "count_hint": 41},
    {"id": "2style", "title": "热推", "count_hint": 20},
    {"id": "situation", "title": "情境", "count_hint": 11},
    {"id": "7", "title": "街头自选集", "count_hint": 20},
]

_VALID_SECTION_IDS = {s["id"] for s in SV_PLAYLIST_SECTIONS}

# ========================================================
# 二级内存缓存 (30 分钟 TTL + LRU 淘汰)
# ========================================================
_SV_CACHE = {}
_SV_CACHE_LOCK = threading.Lock()
_SV_CACHE_TTL_SEC = 1800
_SV_CACHE_MAX_ENTRIES = 200

_SV_HEALTH_CACHE = {"data": None, "ts": 0.0}
_SV_HEALTH_LOCK = threading.Lock()
_SV_HEALTH_TTL_SEC = 300


def _cached_sv_call(cache_key: str, fn, *args, **kwargs):
    now = time.time()
    with _SV_CACHE_LOCK:
        entry = _SV_CACHE.get(cache_key)
        if entry:
            data, expire_at = entry
            if now < expire_at:
                return data

    res = fn(*args, **kwargs)
    if res:
        with _SV_CACHE_LOCK:
            if len(_SV_CACHE) >= _SV_CACHE_MAX_ENTRIES:
                _SV_CACHE.pop(next(iter(_SV_CACHE)))
            _SV_CACHE[cache_key] = (res, now + _SV_CACHE_TTL_SEC)
    return res


def _clean_html_text(raw: str) -> str:
    if not raw:
        return ""
    txt = re.sub(r"<[^>]+>", " ", raw)
    txt = html_lib.unescape(txt)
    return re.sub(r"\s+", " ", txt).strip()


def _sv_headers(host: str = "com") -> dict:
    domain = f"https://streetvoice.{host}"
    return {
        "User-Agent": USER_AGENT,
        "Referer": f"{domain}/",
        "Origin": domain,
    }


def _fetch_html(url: str, host: str = "com", timeout: float = 8.0) -> str:
    status, body, _, _ = http_get(url, headers=_sv_headers(host), timeout=timeout)
    if status == 200 and body:
        return body.decode("utf-8", errors="ignore")
    return ""


# ========================================================
# 1. 官方排行榜列表与单榜 Top 50 抓取 (优先 /api/v5/chart/ 纯 JSON)
# ========================================================
def get_sv_chart_catalog() -> dict:
    return {
        "charts": SV_CHART_DEFINITIONS,
        "sections": SV_PLAYLIST_SECTIONS,
    }


def _map_sv_song(song: dict, index: int, host: str = "com") -> dict:
    """统一映射 StreetVoice API v5 单曲 JSON 为前端标准曲目结构（含真实时长与封面）"""
    sid = str(song["id"])
    title = (song.get("name") or "未知曲目").strip()
    user = song.get("user") or {}
    profile = user.get("profile") or {}
    artist = (profile.get("nickname") or user.get("username") or "未知音乐人").strip()
    length_sec = int(song.get("length") or 0)
    cover = (song.get("image") or "").strip()
    username = (user.get("username") or "").strip()
    song_url = f"https://streetvoice.{host}/{username}/songs/{sid}/" if username else f"https://streetvoice.{host}/songs/{sid}/"
    return {
        "index": index,
        "id": sid,
        "name": title,
        "title": title,
        "artist": artist,
        "album": "",
        "durationMillis": length_sec * 1000,
        "duration": length_sec,
        "cover": cover,
        "platform": "streetvoice",
        "url": song_url,
    }


def _fetch_chart_json(kind: str, category: str, host: str = "com") -> list:
    url = f"https://streetvoice.{host}/api/v5/chart/{kind}/{category}/?limit=50"
    status, body, _, _ = http_get(url, headers=_sv_headers(host), timeout=6.0)
    if status != 200 or not body:
        return []
    try:
        data = json.loads(body.decode("utf-8", errors="ignore"))
    except Exception:
        return []
    tracks = []
    seen = set()
    for entry in (data.get("results") or []):
        song = entry.get("song") if isinstance(entry, dict) else None
        if not isinstance(song, dict) or not song.get("id"):
            continue
        sid = str(song["id"])
        if sid in seen:
            continue
        seen.add(sid)
        tracks.append(_map_sv_song(song, len(tracks) + 1, host=host))
    return tracks


def _parse_chart_html(html_text: str, host: str = "com") -> list:
    if not html_text:
        return []
    pattern = re.compile(
        r'<img\s+src="([^"]+)"[^>]*>.*?<div class="work-item-info">\s*'
        r'<h4[^>]*>\s*<a\s+href="([^"]+/songs/(\d+)/)"[^>]*>(.*?)</a>\s*</h4>\s*'
        r'<h5[^>]*>\s*<a[^>]*>(.*?)</a>\s*</h5>',
        re.S,
    )
    tracks = []
    seen_ids = set()
    base = f"https://streetvoice.{host}"
    for match in pattern.finditer(html_text):
        cover, path, sid, raw_name, raw_artist = match.groups()
        if sid in seen_ids:
            continue
        seen_ids.add(sid)
        name = _clean_html_text(raw_name) or "未知曲目"
        artist = _clean_html_text(raw_artist) or "未知音乐人"
        tracks.append({
            "index": len(tracks) + 1,
            "id": str(sid),
            "name": name,
            "title": name,
            "artist": artist,
            "album": "",
            "durationMillis": 0,
            "cover": cover.strip(),
            "platform": "streetvoice",
            "url": path if path.startswith("http") else f"{base}{path}",
        })
    return tracks


def fetch_sv_chart(kind: str, category: str, host: str = "com") -> dict:
    meta = _VALID_CHART_KEYS.get((kind, category))
    if not meta:
        raise ValueError(f"Invalid chart: {kind}/{category}")
    return _cached_sv_call(f"sv_chart_{host}_{kind}_{category}", _fetch_sv_chart_raw, meta, host)


def _fetch_sv_chart_raw(meta: dict, host: str = "com") -> dict:
    kind = meta["kind"]
    category = meta["category"]
    used_host = host

    # 1. 优先直连官方 JSON 榜单接口（自带真实曲目时长，体积小且无需正则解析 HTML）
    tracks = _fetch_chart_json(kind, category, host=host)
    if not tracks and host == "com":
        used_host = "cn"
        tracks = _fetch_chart_json(kind, category, host="cn")

    # 2. 兜底回退 SSR HTML 页面解析
    if not tracks:
        used_host = host
        url = f"https://streetvoice.{host}/music/charts/{kind}/{category}/"
        html_text = _fetch_html(url, host=host, timeout=8.0)
        tracks = _parse_chart_html(html_text, host=host)
        if not tracks and host == "com":
            used_host = "cn"
            cn_url = f"https://streetvoice.cn/music/charts/{kind}/{category}/"
            html_text = _fetch_html(cn_url, host="cn", timeout=8.0)
            tracks = _parse_chart_html(html_text, host="cn")

    return {
        "id": meta["id"],
        "kind": kind,
        "category": category,
        "title": meta["title"],
        "curator": f"StreetVoice {meta['group']}",
        "platform": "streetvoice",
        "svType": "chart",
        "host": used_host,
        "tracks": tracks,
    }


# ========================================================
# 2. 精选歌单广场与 7 大主题分区抓取
# ========================================================
def _parse_playlist_cards_html(html_text: str, host: str = "com") -> list:
    if not html_text:
        return []
    pattern = re.compile(
        r'<a\s+href="(/[^"]+/playlists/(\d+)/)"[^>]*>\s*<img\s+src="([^"]+)"[^>]*>.*?'
        r'<h3[^>]*>\s*<a[^>]*>(.*?)</a>\s*</h3>\s*'
        r'<h4[^>]*>\s*<a[^>]*>(.*?)</a>\s*</h4>',
        re.S,
    )
    items = []
    seen_ids = set()
    base = f"https://streetvoice.{host}"
    for match in pattern.finditer(html_text):
        path, pid, cover, raw_title, raw_curator = match.groups()
        if pid in seen_ids:
            continue
        seen_ids.add(pid)
        title = _clean_html_text(raw_title) or "街声精选歌单"
        curator = _clean_html_text(raw_curator) or "StreetVoice"
        items.append({
            "id": str(pid),
            "type": "playlist",
            "kind": "playlist",
            "platform": "streetvoice",
            "svType": "playlist",
            "title": title,
            "name": title,
            "curator": curator,
            "cover": cover.strip(),
            "url": path if path.startswith("http") else f"{base}{path}",
        })
    return items


def fetch_sv_playlists(section: str = "all", page: int = 1, host: str = "com") -> dict:
    sec = section if section in _VALID_SECTION_IDS else "all"
    page_num = max(1, int(page or 1))
    return _cached_sv_call(f"sv_pl_{host}_{sec}_p{page_num}", _fetch_sv_playlists_raw, sec, page_num, host)


def _fetch_sv_playlists_raw(section: str, page: int, host: str = "com") -> dict:
    if section == "all":
        url = f"https://streetvoice.{host}/music/playlists/all/most_liked/"
        html_text = _fetch_html(url, host=host, timeout=8.0)
        used_host = host
        if not html_text and host == "com":
            used_host = "cn"
            html_text = _fetch_html("https://streetvoice.cn/music/playlists/all/most_liked/", host="cn", timeout=8.0)
        items = _parse_playlist_cards_html(html_text, host=used_host)
        return {
            "section": "all",
            "page": 1,
            "has_more": False,
            "host": used_host,
            "playlists": items,
        }

    # 主题分区每页 8 条，每次并行拉取 2 页（共 16 条）保证首屏充实且 <1s 响应
    pages_to_fetch = [(page - 1) * 2 + 1, (page - 1) * 2 + 2]
    used_host = host

    def _fetch_sec_page(p: int, target_host: str):
        u = f"https://streetvoice.{target_host}/music/playlist/section/{section}/?page={p}"
        return _fetch_html(u, host=target_host, timeout=7.0)

    with ThreadPoolExecutor(max_workers=2) as pool:
        html_pages = list(pool.map(lambda p: _fetch_sec_page(p, used_host), pages_to_fetch))

    if not any(html_pages) and host == "com":
        used_host = "cn"
        with ThreadPoolExecutor(max_workers=2) as pool:
            html_pages = list(pool.map(lambda p: _fetch_sec_page(p, "cn"), pages_to_fetch))

    combined = []
    seen = set()
    for hp in html_pages:
        for item in _parse_playlist_cards_html(hp, host=used_host):
            if item["id"] not in seen:
                seen.add(item["id"])
                combined.append(item)

    last_html = html_pages[-1] if html_pages else ""
    next_p = pages_to_fetch[-1] + 1
    has_more = bool(last_html and f"page={next_p}" in last_html)

    return {
        "section": section,
        "page": page,
        "next_page": page + 1 if has_more else None,
        "has_more": has_more,
        "host": used_host,
        "playlists": combined,
    }


# ========================================================
# 3. 歌单曲目明细 JSON 提取 (/api/v5/playlist/{id}/songs/)
# ========================================================
def fetch_sv_playlist_songs(playlist_id: str, host: str = "com") -> dict:
    pid = str(playlist_id or "").strip()
    if not pid.isdigit():
        raise ValueError("Invalid StreetVoice playlist id")
    return _cached_sv_call(f"sv_pl_songs_{host}_{pid}", _fetch_sv_playlist_songs_raw, pid, host)


def _fetch_sv_playlist_songs_raw(pid: str, host: str = "com") -> dict:
    used_host = host
    tracks = []
    next_url = f"https://streetvoice.{host}/api/v5/playlist/{pid}/songs/?limit=100"

    # 最多翻 3 页（300 首），避免超大歌单拖垮 Vercel 10s 超时
    for page_idx in range(3):
        if not next_url:
            break
        status, body, _, _ = http_get(next_url, headers=_sv_headers(used_host), timeout=6.0)
        if (status != 200 or not body) and page_idx == 0 and used_host == "com":
            used_host = "cn"
            next_url = f"https://streetvoice.cn/api/v5/playlist/{pid}/songs/?limit=100"
            status, body, _, _ = http_get(next_url, headers=_sv_headers("cn"), timeout=6.0)

        if status != 200 or not body:
            break

        try:
            data = json.loads(body.decode("utf-8", errors="ignore"))
        except Exception:
            break

        results = data.get("results") or []
        for entry in results:
            song = entry.get("song") if isinstance(entry, dict) else None
            if not isinstance(song, dict) or not song.get("id"):
                continue
            tracks.append(_map_sv_song(song, len(tracks) + 1, host=used_host))

        next_url = data.get("next") or ""
        if next_url and used_host == "cn" and "streetvoice.com" in next_url:
            next_url = next_url.replace("streetvoice.com", "streetvoice.cn")

    return {
        "id": pid,
        "platform": "streetvoice",
        "svType": "playlist",
        "host": used_host,
        "tracks": tracks,
    }


# ========================================================
# 4. 歌词解析与单曲 HLS 直通解析
# ========================================================
def parse_sv_lyrics(raw_lyrics: str, is_lrc: bool = False) -> tuple:
    """返回 (lyrics_list, untimed_flag)"""
    if not raw_lyrics or not isinstance(raw_lyrics, str):
        return [], False

    text = raw_lyrics.strip()
    if not text:
        return [], False

    if is_lrc or re.search(r'\[\d{1,3}:\d{2}(?:\.\d+)?\]', text):
        parsed = _parse_lrc_text(text)
        if parsed:
            return parsed, False

    lines = []
    for raw_line in text.splitlines():
        clean = raw_line.strip()
        if clean:
            lines.append({"time": 0, "text": clean, "untimed": True})
    return lines, bool(lines)


def fetch_sv_song_lyrics(song_id: str, host: str = "com") -> list:
    sid = str(song_id or "").strip()
    if not sid.isdigit():
        return []
    url = f"https://streetvoice.{host}/api/v5/song/{sid}/"
    status, body, _, _ = http_get(url, headers=_sv_headers(host), timeout=4.0)
    if (status != 200 or not body) and host == "com":
        status, body, _, _ = http_get(f"https://streetvoice.cn/api/v5/song/{sid}/", headers=_sv_headers("cn"), timeout=4.0)
    if status != 200 or not body:
        return []
    try:
        detail = json.loads(body.decode("utf-8", errors="ignore"))
        lines, _ = parse_sv_lyrics(detail.get("lyrics", ""), bool(detail.get("lyrics_is_lrc")))
        return lines
    except Exception:
        return []


def _resolve_on_host(song_id: str, host: str = "com") -> dict:
    base = f"https://streetvoice.{host}"
    hdrs = _sv_headers(host)

    def _fetch_hls():
        st, body, _ = http_post_json(f"{base}/api/v5/song/{song_id}/hls/file/", {}, headers=hdrs, timeout=4.5)
        if st == 200 and body:
            try:
                return json.loads(body.decode("utf-8", errors="ignore"))
            except Exception:
                return {}
        return {}

    def _fetch_detail():
        st, body, _, _ = http_get(f"{base}/api/v5/song/{song_id}/", headers=hdrs, timeout=4.5)
        if st == 200 and body:
            try:
                return json.loads(body.decode("utf-8", errors="ignore"))
            except Exception:
                return {}
        return {}

    with ThreadPoolExecutor(max_workers=2) as pool:
        hls_fut = pool.submit(_fetch_hls)
        detail_fut = pool.submit(_fetch_detail)
        hls_data = hls_fut.result()
        detail_data = detail_fut.result()

    m3u8_url = (hls_data or {}).get("file") or ""
    if not m3u8_url:
        return None

    lyrics, untimed = parse_sv_lyrics(
        (detail_data or {}).get("lyrics", ""),
        bool((detail_data or {}).get("lyrics_is_lrc")),
    )
    bitrate = "96k" if ("96khls" in m3u8_url or host == "cn") else "192k"
    return {
        "success": True,
        "url": m3u8_url,
        "is_hls": True,
        "platform": "streetvoice",
        "bitrate": bitrate,
        "host": host,
        "source_id": "streetvoice",
        "source_name": f"街声 StreetVoice ({bitrate} · .{host})",
        "bytes": 0,
        "lyrics": lyrics,
        "untimed_lyrics": untimed,
    }


def resolve_streetvoice_track(song_id: str, host: str = "com") -> dict:
    sid = str(song_id or "").strip()
    if not sid.isdigit():
        return {
            "success": False,
            "error": "无效的街声曲目 ID",
            "platform": "streetvoice",
            "no_cross_fallback": True,
        }

    res = _resolve_on_host(sid, host=host)
    if not res and host == "com":
        res = _resolve_on_host(sid, host="cn")

    if res:
        return res

    return {
        "success": False,
        "error": "该街声曲目暂未开放播放流",
        "platform": "streetvoice",
        "no_cross_fallback": True,
    }


# ========================================================
# 5. 真实连通性健康度探针 (置顶展示于 ⚡ 音源监控面板)
# ========================================================
def probe_sv_health(force: bool = False) -> dict:
    now = time.time()
    if not force:
        with _SV_HEALTH_LOCK:
            if _SV_HEALTH_CACHE["data"] and (now - _SV_HEALTH_CACHE["ts"]) < _SV_HEALTH_TTL_SEC:
                return dict(_SV_HEALTH_CACHE["data"])

    t0 = time.time()
    used_host = "com"
    bitrate = "192k"
    ok = False

    try:
        st, body, _ = http_post_json(
            "https://streetvoice.com/api/v5/song/123688/hls/file/",
            {},
            headers=_sv_headers("com"),
            timeout=3.0,
        )
        if st == 200 and body and b".m3u8" in body:
            ok = True
        else:
            st_cn, body_cn, _ = http_post_json(
                "https://streetvoice.cn/api/v5/song/123688/hls/file/",
                {},
                headers=_sv_headers("cn"),
                timeout=3.0,
            )
            if st_cn == 200 and body_cn and b".m3u8" in body_cn:
                ok = True
                used_host = "cn"
                bitrate = "96k"
    except Exception:
        ok = False

    latency_ms = round((time.time() - t0) * 1000, 1) if ok else 9999.0
    result = {
        "id": "streetvoice_official",
        "name": f"街声官方直连 ({bitrate} · .{used_host})",
        "platform": "streetvoice",
        "type": "STREETVOICE · 独立音乐直通通道",
        "status": "ok" if ok else "failed",
        "latency_ms": latency_ms,
        "consecutive_fails": 0 if ok else 1,
        "success_count": 1 if ok else 0,
    }

    with _SV_HEALTH_LOCK:
        _SV_HEALTH_CACHE["data"] = result
        _SV_HEALTH_CACHE["ts"] = time.time()

    return dict(result)
