#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
resolver.py - /api/resolve 策略 A 短路阶梯寻链与热缓存编排中枢
职责：
  1. 管理单曲解析热点缓存 (_RESOLVE_CACHE) 与街声直通分支
  2. 统一编排【直连/云缓存 -> 全平台搜索 -> Apple 母语转译 -> QQ+咪咕兜底】流水线
  3. 非阻塞异步并发拉取歌词：音频失败立即 cancel 歌词任务，绝不拖慢下一候选回退
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from kv_cache import delete_cached_candidate, get_cached_candidate, set_cached_candidate
from lyric_service import get_song_lyric
from song_search import search_candidates, search_candidates_fallback
from source_manager import source_hub
from streetvoice_catalog import resolve_streetvoice_track

_RESOLVE_CACHE = {}
_RESOLVE_CACHE_LOCK = threading.Lock()
_CACHE_MAX_ENTRIES = 256
_CACHE_TTL_SEC = 900  # 15 分钟

_LYRIC_EXECUTOR = ThreadPoolExecutor(max_workers=4)


def _get_cached_resolve(cache_key: str):
    if not cache_key:
        return None
    with _RESOLVE_CACHE_LOCK:
        entry = _RESOLVE_CACHE.get(cache_key)
        if entry and (time.time() - entry["ts"]) < _CACHE_TTL_SEC:
            cached_res = dict(entry["res"])
            cached_res["source_name"] = str(cached_res.get("source_name", "")) + " ⚡快取"
            return cached_res
    return None


def _set_cached_resolve(cache_key: str, res: dict):
    if not cache_key or not res:
        return
    with _RESOLVE_CACHE_LOCK:
        if len(_RESOLVE_CACHE) >= _CACHE_MAX_ENTRIES:
            _RESOLVE_CACHE.pop(next(iter(_RESOLVE_CACHE)))
        _RESOLVE_CACHE[cache_key] = {"res": res, "ts": time.time()}


def _pop_cached_resolve(cache_key: str):
    if not cache_key:
        return
    with _RESOLVE_CACHE_LOCK:
        _RESOLVE_CACHE.pop(cache_key, None)


def _resolve_candidate_with_lyrics(
    cand_item: dict,
    title: str,
    artist: str,
    overall_deadline: float,
    resolve_budget: float,
    lyric_title: str = None,
    lyric_artist: str = None,
    cache_key: str = "",
    source_suffix: str = "",
    attach_matched: bool = True,
    cache_to_kv: bool = True,
    extra_fields: dict = None,
):
    """
    统一单候选并行解析（音频竞速 + 歌词并发）。
    若音频未出声，立即取消歌词 Future 并返回 (None, error)，绝不阻塞线程退出。
    """
    l_title = lyric_title if lyric_title is not None else title
    l_artist = lyric_artist if lyric_artist is not None else artist
    lyric_fut = _LYRIC_EXECUTOR.submit(
        get_song_lyric,
        cand_item.get("platform", ""),
        cand_item.get("id", ""),
        l_title,
        l_artist,
    )

    res = source_hub.resolve_best_stream(cand_item, timeout_budget=resolve_budget)
    if not (res and res.get("success")):
        lyric_fut.cancel()
        err = res.get("error") if isinstance(res, dict) else None
        return None, err

    if attach_matched:
        res["matched_candidate"] = cand_item
        res["target_title"] = title
        res["target_artist"] = artist
    if extra_fields:
        res.update(extra_fields)
    if source_suffix:
        res["source_name"] = str(res.get("source_name", "")) + source_suffix

    rem_lyric = max(0.1, min(1.0, overall_deadline - time.time() - 0.2))
    try:
        res["lyrics"] = lyric_fut.result(timeout=rem_lyric)
    except Exception:
        res["lyrics"] = []

    if cache_key:
        _set_cached_resolve(cache_key, res)
    if cache_to_kv and cand_item.get("score", 0) >= 80.0:
        try:
            set_cached_candidate(title, artist, cand_item)
        except Exception:
            pass
    return res, None


def _select_diverse_candidates(cands: list, max_count: int = 3) -> list:
    """跨平台优选，优先取各平台最高分候选，再补齐剩余高分"""
    selected = []
    seen_platforms = set()
    for c in cands:
        plat = c.get("platform")
        if plat not in seen_platforms:
            selected.append(c)
            seen_platforms.add(plat)
            if len(selected) >= max_count:
                return selected
    for c in cands:
        if c not in selected:
            selected.append(c)
            if len(selected) >= max_count:
                break
    return selected


def resolve_track(cand: dict, fetch_apple_native_fn=None) -> tuple:
    """
    执行 /api/resolve 全流程寻链，返回 (payload_dict, http_status)
    """
    req_start = time.time()
    overall_deadline = req_start + 7.5

    title = (cand.get("title") or cand.get("name") or "").strip()
    artist = (cand.get("artist") or "").strip()
    duration = cand.get("duration")
    force_refresh = bool(cand.get("force_refresh", False))
    if not duration and cand.get("durationMillis"):
        duration = round(cand.get("durationMillis", 0) / 1000)

    # 0. 热点缓存
    cache_key = f"{title.lower()}_{artist.lower()}".strip() if (title and not cand.get("platform")) else ""
    if cache_key:
        if force_refresh:
            _pop_cached_resolve(cache_key)
        else:
            cached_res = _get_cached_resolve(cache_key)
            if cached_res:
                return cached_res, 200

    # 0.5 街声直通分支
    if (cand.get("platform") or "").strip().lower() == "streetvoice":
        sv_id = str(cand.get("id") or "").strip()
        sv_cache_key = f"sv_{sv_id}" if sv_id else ""
        if sv_cache_key:
            if force_refresh:
                _pop_cached_resolve(sv_cache_key)
            else:
                cached_res = _get_cached_resolve(sv_cache_key)
                if cached_res:
                    return cached_res, 200
        sv_res = resolve_streetvoice_track(sv_id)
        if sv_res and sv_res.get("success") and sv_cache_key:
            _set_cached_resolve(sv_cache_key, sv_res)
        return sv_res, 200

    # 1. 已有确切平台与 ID
    if cand.get("platform") and cand.get("id"):
        remaining = overall_deadline - time.time()
        if remaining > 0.6:
            res, _ = _resolve_candidate_with_lyrics(
                cand, title, artist, overall_deadline, remaining,
                attach_matched=False, cache_to_kv=False,
            )
            if res:
                return res, 200

    # 1.5 云端 KV ID 沉淀快查与自愈
    if title and not cand.get("platform") and not force_refresh:
        cloud_cand = get_cached_candidate(title, artist)
        if cloud_cand and cloud_cand.get("platform") and cloud_cand.get("id"):
            cloud_cand["duration"] = cloud_cand.get("duration") or duration
            remaining = overall_deadline - time.time()
            if remaining > 0.6:
                res, _ = _resolve_candidate_with_lyrics(
                    cloud_cand, title, artist, overall_deadline, remaining,
                    cache_key=cache_key, source_suffix=" ☁️云快取", cache_to_kv=False,
                )
                if res:
                    return res, 200
                delete_cached_candidate(title, artist)

    # 2. 策略 A 全网检索
    search_key = f"{title} {artist}".strip() if title else ""
    if not search_key:
        return {"error": "缺少有效歌名或候选信息"}, 400

    last_err = "未找到候选歌曲"
    if time.time() >= (overall_deadline - 1.0):
        return {"success": False, "error": "请求时间预算耗尽", "title": title, "artist": artist}, 200

    # 2.1 第一阶梯：酷我 + 网易 + 酷狗（搜空时内部补查 QQ）
    cands = search_candidates(search_key, target_artist=artist, target_title=title, target_duration=duration)
    for c in _select_diverse_candidates(cands, max_count=3):
        rem = overall_deadline - time.time()
        if rem <= 1.2:
            break
        c["duration"] = c.get("duration") or duration
        res, err = _resolve_candidate_with_lyrics(
            c, title, artist, overall_deadline, min(2.5, max(0.6, rem - 0.8)),
            cache_key=cache_key,
        )
        if res:
            return res, 200
        if err:
            last_err = err

    # 2.2 第 1.5 阶梯：Apple 日文/母语原生转译
    apple_song_id = str(cand.get("id") or "").strip()
    rem = overall_deadline - time.time()
    if fetch_apple_native_fn and apple_song_id.isdigit() and rem > 2.0:
        apple_timeout = min(1.5, max(0.5, rem - 1.2))
        native_meta = fetch_apple_native_fn(apple_song_id, timeout=apple_timeout)
        if native_meta and (native_meta.get("title") != title or native_meta.get("artist") != artist):
            native_t = native_meta.get("title")
            native_a = native_meta.get("artist") or artist
            native_dur = native_meta.get("duration") or duration
            native_cands = search_candidates(
                f"{native_t} {native_a}",
                target_artist=native_a,
                target_title=native_t,
                target_duration=native_dur,
            )
            for nc in native_cands[:2]:
                rem_cand = overall_deadline - time.time()
                if rem_cand <= 1.0:
                    break
                nc["duration"] = nc.get("duration") or native_dur
                res, err = _resolve_candidate_with_lyrics(
                    nc, title, artist, overall_deadline, min(2.2, max(0.6, rem_cand - 0.6)),
                    lyric_title=native_t, lyric_artist=native_a,
                    cache_key=cache_key, source_suffix=" 🌸母语精配",
                    extra_fields={"native_title": native_t, "native_artist": native_a},
                )
                if res:
                    return res, 200
                if err:
                    last_err = err

    # 2.3 第二阶梯：QQ + 咪咕兜底
    rem = overall_deadline - time.time()
    if rem > 1.4:
        fallback_cands = search_candidates_fallback(
            search_key, target_artist=artist, target_title=title, target_duration=duration
        )
        for fc in fallback_cands[:2]:
            rem_fb = overall_deadline - time.time()
            if rem_fb <= 0.6:
                break
            fc["duration"] = fc.get("duration") or duration
            res, err = _resolve_candidate_with_lyrics(
                fc, title, artist, overall_deadline, rem_fb, cache_key=cache_key,
            )
            if res:
                return res, 200
            if err:
                last_err = err

    return {
        "success": False,
        "error": f"全源库冲刺完成，未能匹配到有效音频流: {last_err}",
        "title": title,
        "artist": artist,
    }, 200
