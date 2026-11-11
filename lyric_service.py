#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lyric_service.py - 时间轴歌词直通提取、LRC 解析与秒级缓存服务
"""

import base64
import json
import re
import threading
import time
import urllib.parse

from net_pool import http_get

_LYRIC_CACHE = {}
_LYRIC_CACHE_LOCK = threading.Lock()
_LYRIC_CACHE_MAX = 256
_LYRIC_TTL_SEC = 7200


def _cache_get(key: str):
    with _LYRIC_CACHE_LOCK:
        entry = _LYRIC_CACHE.get(key)
        if entry and (time.time() - entry[1]) < _LYRIC_TTL_SEC:
            return entry[0]
    return None


def _cache_set(key: str, lines: list):
    if not lines:
        return
    with _LYRIC_CACHE_LOCK:
        if len(_LYRIC_CACHE) >= _LYRIC_CACHE_MAX:
            _LYRIC_CACHE.pop(next(iter(_LYRIC_CACHE)))
        _LYRIC_CACHE[key] = (lines, time.time())


def _parse_lrc_text(lrc_text: str) -> list:
    """
    标准 LRC 时间轴解析器：
    1. 支持 [offset:xxx] (毫秒) 全局时间轴平移修正
    2. 支持一行多时间戳语法展开
    3. 过滤元数据行并按时间递增排序
    """
    if not lrc_text:
        return []

    offset_sec = 0.0
    offset_m = re.search(r'\[offset:\s*([+-]?\d+)\s*\]', lrc_text, re.IGNORECASE)
    if offset_m:
        try:
            offset_sec = int(offset_m.group(1)) / 1000.0
        except Exception:
            offset_sec = 0.0

    parsed = []
    for line in lrc_text.splitlines():
        line = line.strip()
        if not line or re.match(r'^\[(ti|ar|al|by|offset|length|tool|re|ve):.*\]$', line, re.IGNORECASE):
            continue

        matches = list(re.finditer(r'\[(\d+):(\d+(?:\.\d+)?)\]', line))
        if not matches:
            continue

        txt = re.sub(r'\[\d+:\d+(?:\.\d+)?\]', '', line).strip()
        if not txt:
            continue

        for m in matches:
            mins, secs = m.groups()
            t = round(int(mins) * 60 + float(secs) + offset_sec, 2)
            if t < 0:
                t = 0.0
            parsed.append({"time": t, "text": txt})

    parsed.sort(key=lambda x: x["time"])
    return parsed


def _fetch_qq_lyric_by_mid(songmid: str) -> list:
    if not songmid:
        return []
    try:
        url = f"https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid={songmid}&format=json&nobase64=1"
        st, data_bytes, _, _ = http_get(url, headers={'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0'}, timeout=2.0)
        if st == 200 and data_bytes:
            d = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            lrc = d.get('lyric', '')
            if lrc:
                if not lrc.strip().startswith('['):
                    try:
                        lrc = base64.b64decode(lrc).decode('utf-8', errors='ignore')
                    except Exception:
                        pass
                return _parse_lrc_text(lrc)
    except Exception:
        pass
    return []


def _fetch_wy_lyric_by_id(song_id: str) -> list:
    if not song_id or not str(song_id).isdigit():
        return []
    try:
        url = f"https://music.163.com/api/song/lyric?os=pc&id={song_id}&lv=-1"
        st, data_bytes, _, _ = http_get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=2.0)
        if st == 200 and data_bytes:
            data = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            lrc_text = (data.get('lrc') or {}).get('lyric', '')
            if lrc_text:
                return _parse_lrc_text(lrc_text)
    except Exception:
        pass
    return []


def _fetch_kw_lyric_by_id(rid: str) -> list:
    kw_rid = str(rid or "").replace("MUSIC_", "")
    if not kw_rid.isdigit():
        return []
    try:
        url = f"https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId={kw_rid}&httpsStatus=1"
        st, data_bytes, _, _ = http_get(url, headers={'User-Agent': 'okhttp/3.10.0', 'Referer': 'https://kuwo.cn/'}, timeout=1.5)
        if st == 200 and data_bytes:
            data = json.loads(data_bytes.decode('utf-8', errors='ignore').strip())
            items = (data.get('data') or {}).get('lrclist') or []
            lines = []
            for item in items:
                if not item:
                    continue
                t = round(float(item.get('time', 0)), 2)
                txt = (item.get('lineLyric') or '').strip()
                if txt:
                    lines.append({"time": t, "text": txt})
            return lines
    except Exception:
        pass
    return []


def get_song_lyric(platform: str = "kw", song_id: str = "", title: str = "", artist: str = "") -> list:
    """
    获取并统一解析标准歌词列表: [{"time": float, "text": str}]
    核心原则：音画同源优先；若无源则按 QQ -> 酷我 -> 网易云 顺序严格匹配防伪。
    """
    from song_search import to_simple, clean_brackets, calculate_song_match_score

    plat_str = (platform or "").strip().lower()
    sid_str = str(song_id or "").strip()
    cache_key = f"{plat_str}_{sid_str}_{title.strip().lower()}_{artist.strip().lower()}"

    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    if plat_str in ("tx", "qq") and sid_str:
        lines = _fetch_qq_lyric_by_mid(sid_str)
        if lines:
            _cache_set(cache_key, lines)
            return lines

    if plat_str in ("wy", "netease") and sid_str and sid_str.isdigit():
        lines = _fetch_wy_lyric_by_id(sid_str)
        if lines:
            _cache_set(cache_key, lines)
            return lines

    if plat_str in ("kw", "kuwo") and sid_str:
        lines = _fetch_kw_lyric_by_id(sid_str)
        if lines:
            _cache_set(cache_key, lines)
            return lines

    clean_t = clean_brackets(to_simple(title))
    clean_a = to_simple(artist)
    q_str = f"{clean_t} {clean_a}".strip()
    if not q_str:
        return []

    # 4.1 优先 QQ 音乐检索正版单曲 LRC
    try:
        url_qq = f"https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w={urllib.parse.quote(q_str)}&format=json"
        st, data_bytes, _, _ = http_get(url_qq, headers={'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0'}, timeout=2.0)
        if st == 200 and data_bytes:
            data = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            songs = (data.get('data') or {}).get('song', {}).get('list', [])
            for s in songs:
                mid = s.get('songmid')
                s_name = s.get('songname', '')
                s_art = "/".join(a.get('name', '') for a in s.get('singer', []))
                _, ok = calculate_song_match_score(s_name, s_art, "", clean_t, clean_a)
                if ok and mid:
                    lines = _fetch_qq_lyric_by_mid(mid)
                    if lines:
                        _cache_set(cache_key, lines)
                        return lines
    except Exception:
        pass

    # 4.2 次选酷我音乐检索
    try:
        url_kw = f"https://search.kuwo.cn/r.s?client=kt&all={urllib.parse.quote(q_str)}&pn=0&rn=3&uid=794762528&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newsearch=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1"
        st, data_bytes, _, _ = http_get(url_kw, headers={'User-Agent': 'okhttp/3.10.0'}, timeout=1.8)
        if st == 200 and data_bytes:
            data = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            for it in (data.get('abslist') or []):
                rid = it.get('MUSICRID', '').replace('MUSIC_', '')
                if rid.isdigit():
                    lines = _fetch_kw_lyric_by_id(rid)
                    if lines:
                        _cache_set(cache_key, lines)
                        return lines
    except Exception:
        pass

    # 4.3 最后网易云严格过滤匹配
    try:
        url_ne = f"https://music.163.com/api/search/get?s={urllib.parse.quote(q_str)}&type=1&offset=0&limit=3"
        st, data_bytes, _, _ = http_get(url_ne, headers={'User-Agent': 'Mozilla/5.0'}, timeout=2.0)
        if st == 200 and data_bytes:
            d = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            songs = (d.get('result') or {}).get('songs') or []
            for s in songs:
                s_name = s.get('name', '')
                s_art = "/".join(a.get('name', '') for a in s.get('artists', []))
                _, ok = calculate_song_match_score(s_name, s_art, "", clean_t, clean_a)
                if ok and s.get('id'):
                    lines = _fetch_wy_lyric_by_id(str(s['id']))
                    if lines:
                        _cache_set(cache_key, lines)
                        return lines
    except Exception:
        pass

    return []
