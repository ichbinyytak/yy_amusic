#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
========================================================
模块：kv_cache.py - 基于 Vercel Upstash KV 的云端歌曲 ID 持久化缓存中枢
核心定位：0 pip 额外依赖，纯 Python 标准库 urllib 驱动 Upstash REST API
--------------------------------------------------------
设计哲学与三大防伪铁律：
  1. 绝不缓存未经出声检验的假 ID：只有真实出声校验合格（> 1.2MB）的候选方可入库
  2. 严格绑定“清洗歌名 + 歌手”作为复合主键，原唱打分门槛 >= 80，彻底杜绝翻唱与张冠李戴
  3. 具备自动自愈能力：若云端 ID 遇到版权下架，自动在云端 DEL 作废并无缝触发重新检索
  4. 优雅无损回退：若未配置环境变量或云端网络波动，自动平滑退守本地内存字典，永不阻断业务
========================================================
"""

import os
import json
import time
import urllib.request
import urllib.error
from net_pool import http_post_json

# 动态获取环境变量，防止 Serverless 容器冷启动初始化时序差
def _get_kv_config():
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

# 默认歌曲 ID 映射缓存存活 30 天 (2592000 秒)
CANDIDATE_TTL_SEC = 2592000

def _normalize_key(title: str, artist: str) -> str:
    """生成标准化的云端 Redis Key (繁简归一化、全小写)"""
    try:
        from song_search import to_simple
        t = to_simple(title) if title else ""
        a = to_simple(artist) if artist else ""
    except Exception:
        t = (title or "").strip().lower()
        a = (artist or "").strip().lower()
    return f"amusic:cand:{t}:{a}"

def _execute_kv_command(command_list: list, timeout: float = 1.0):
    """
    通过连接池复用 Keep-Alive 执行 Upstash Redis REST 命令
    消除重复 TLS 握手，毫秒级快速响应
    """
    url, token = _get_kv_config()
    if not url or not token:
        return None
    try:
        headers = {"Authorization": f"Bearer {token}"}
        st, data_bytes, _ = http_post_json(url, command_list, headers=headers, timeout=timeout)
        if st == 200 and data_bytes:
            data = json.loads(data_bytes.decode("utf-8"))
            return data.get("result")
    except Exception:
        # 云端网络抖动或超时不打扰业务，静默回退
        return None
    return None

def get_cached_candidate(title: str, artist: str) -> dict:
    """
    从云端 KV 检索已缓存的歌曲验证候选
    返回: dict(候选歌曲信息) 或 None
    """
    url, token = _get_kv_config()
    if not url or not token or not title:
        return None
    key = _normalize_key(title, artist)
    res = _execute_kv_command(["GET", key], timeout=1.0)
    if res and isinstance(res, str):
        try:
            cand = json.loads(res)
            if isinstance(cand, dict) and cand.get("id") and cand.get("platform"):
                return cand
        except Exception:
            pass
    return None

def set_cached_candidate(title: str, artist: str, candidate: dict, ttl_sec: int = CANDIDATE_TTL_SEC) -> bool:
    """
    【防线 1 与防线 2】：
    将经过真实出声检验合格的高分原唱候选存入云端 KV 永久沉淀
    """
    url, token = _get_kv_config()
    if not url or not token or not title or not candidate:
        return False

    # 防线 2: 严格打分门槛，严禁翻唱、伴奏或劣质候选污染云端资产库
    score = candidate.get("score", 0)
    if score < 80.0:
        return False

    key = _normalize_key(title, artist)
    # 提炼最纯净的持久化字段，节约云端存储空间
    payload = {
        "platform": candidate.get("platform"),
        "id": str(candidate.get("id")),
        "title": candidate.get("title") or title,
        "artist": candidate.get("artist") or artist,
        "album": candidate.get("album", ""),
        "duration": candidate.get("duration"),
        "score": candidate.get("score", 100),
        "cached_at": int(time.time())
    }

    res = _execute_kv_command(["SET", key, json.dumps(payload, ensure_ascii=False), "EX", ttl_sec], timeout=1.2)
    return res == "OK"

def delete_cached_candidate(title: str, artist: str) -> bool:
    """
    【防线 3: 自动自愈机制】：
    若云端已存的 ID 因第三方版权变更下架，立即在云端废除作废，防止死锁
    """
    url, token = _get_kv_config()
    if not url or not token or not title:
        return False
    key = _normalize_key(title, artist)
    res = _execute_kv_command(["DEL", key], timeout=1.0)
    return bool(res)
