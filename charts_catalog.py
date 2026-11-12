#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
charts_catalog.py - 国内五大音乐平台榜单专区（企鹅 / 网易 / 酷我 / 酷狗 / 咪咕）数据抓取与编排中枢
遵循 ARCHITECTURE.md 与 architecture-charts.md:
1. 统一输出标准化「三级分类矩阵」：
   - core: ⭐ 官方核心榜
   - region: 🌐 地区与全球榜
   - genre: ✨ 风格特色潮流榜
2. 统一输出标准化曲目元数据：
   - name, artist, album, durationMillis, sourcePlatform, platform, id, url, coverUrl
3. 纯 Python 原生实现，零第三方依赖
4. 内存缓存：榜单目录 24 小时，榜单曲目 12 小时
"""

import json
import re
import threading
import time
from typing import Dict, Any, List, Optional

from net_pool import http_get, http_post_json

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# ========================================================
# 缓存层定义 (榜单目录 24h，榜单曲目 12h)
# ========================================================
_CATALOG_CACHE: Dict[str, Dict[str, Any]] = {}
_CATALOG_CACHE_TTL = 86400  # 24 小时

_DETAIL_CACHE: Dict[str, Dict[str, Any]] = {}
_DETAIL_CACHE_TTL = 43200   # 12 小时

_CACHE_LOCK = threading.Lock()


# ========================================================
# 兜底静态元数据 (保障极端弱网或风控时首屏秒级呈现)
# ========================================================
FALLBACK_CATALOGS = {
    "qq": {
        "platform": "qq",
        "platformName": "企鹅音乐",
        "categories": [
            {
                "name": "⭐ 官方核心榜",
                "key": "core",
                "lists": [
                    {"id": "62", "title": "飙升榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000000aeJDS3pMGE6.jpg", "updateFrequency": "每天更新"},
                    {"id": "26", "title": "热歌榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M0000009mOBQ2lCq4J.jpg", "updateFrequency": "每天更新"},
                    {"id": "27", "title": "新歌榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000003h1d0H33m1i5.jpg", "updateFrequency": "每天更新"},
                    {"id": "4", "title": "流行指数榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000001fO4592WzD49.jpg", "updateFrequency": "每天更新"}
                ]
            },
            {
                "name": "🌐 地区与全球榜",
                "key": "region",
                "lists": [
                    {"id": "5", "title": "内地榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M0000021b63k1C4PkW.jpg", "updateFrequency": "每周四更新"},
                    {"id": "59", "title": "香港地区榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M0000035t2lH1xVf70.jpg", "updateFrequency": "每周四更新"},
                    {"id": "61", "title": "台湾地区榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000000GqjO00qJ6Hj.jpg", "updateFrequency": "每周四更新"},
                    {"id": "108", "title": "美国公告牌榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000003q8yYj291mXl.jpg", "updateFrequency": "每周一更新"},
                    {"id": "107", "title": "英国UK榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000001oB1iV167G1V.jpg", "updateFrequency": "每周一更新"},
                    {"id": "129", "title": "韩国Melon榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M0000049W5rD0Q8f1i.jpg", "updateFrequency": "每周一更新"}
                ]
            },
            {
                "name": "✨ 风格与特色潮流榜",
                "key": "genre",
                "lists": [
                    {"id": "58", "title": "说唱榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000000w44Bq3GZ7xN.jpg", "updateFrequency": "每周四更新"},
                    {"id": "57", "title": "电音榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000002HqIeO15m60V.jpg", "updateFrequency": "每周四更新"},
                    {"id": "73", "title": "游戏音乐榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000001X701L2O1tC4.jpg", "updateFrequency": "每周四更新"},
                    {"id": "28", "title": "影视金曲榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M0000027T8kG1c90hC.jpg", "updateFrequency": "每周四更新"},
                    {"id": "60", "title": "抖音热歌榜", "cover": "http://y.gtimg.cn/music/photo_new/T003R300x300M000004Z6hU62sE8cW.jpg", "updateFrequency": "每周四更新"}
                ]
            }
        ]
    },
    "wy": {
        "platform": "wy",
        "platformName": "网易云音乐",
        "categories": [
            {
                "name": "⭐ 官方核心榜",
                "key": "core",
                "lists": [
                    {"id": "19723756", "title": "飙升榜", "cover": "https://p1.music.126.net/DrRIg6CrgDfVLEph9SNh7w==/18696095720518497.jpg", "updateFrequency": "每天更新"},
                    {"id": "3779629", "title": "新歌榜", "cover": "https://p1.music.126.net/N2HO1XMyJ client.jpg", "updateFrequency": "每天更新"},
                    {"id": "2884035", "title": "原创榜", "cover": "https://p1.music.126.net/sBzD11nforcuh1jdLSgX7g==/18740076185638788.jpg", "updateFrequency": "每周四更新"},
                    {"id": "3778678", "title": "热歌榜", "cover": "https://p1.music.126.net/GhhuF6Ep5Tq9IEvLldK7rw==/18708190348409091.jpg", "updateFrequency": "每天更新"}
                ]
            },
            {
                "name": "🌐 地区与全球榜",
                "key": "region",
                "lists": [
                    {"id": "60198", "title": "美国Billboard榜", "cover": "", "updateFrequency": "每周三更新"},
                    {"id": "180106", "title": "英国UK榜", "cover": "", "updateFrequency": "每周一更新"},
                    {"id": "60131", "title": "日本Oricon榜", "cover": "", "updateFrequency": "每周三更新"},
                    {"id": "3812895", "title": "Beatport全球电音榜", "cover": "", "updateFrequency": "每周四更新"}
                ]
            },
            {
                "name": "✨ 风格与特色潮流榜",
                "key": "genre",
                "lists": [
                    {"id": "991319590", "title": "网易云说唱榜", "cover": "", "updateFrequency": "每周五更新"},
                    {"id": "1978921795", "title": "网易云电音榜", "cover": "", "updateFrequency": "每周五更新"},
                    {"id": "71384707", "title": "网易云古典榜", "cover": "", "updateFrequency": "刚刚更新"},
                    {"id": "71385702", "title": "网易云ACG榜", "cover": "", "updateFrequency": "每周四更新"},
                    {"id": "745956260", "title": "网易云国风榜", "cover": "", "updateFrequency": "每周五更新"}
                ]
            }
        ]
    },
    "kw": {
        "platform": "kw",
        "platformName": "酷我音乐",
        "categories": [
            {
                "name": "⭐ 官方核心榜",
                "key": "core",
                "lists": [
                    {"id": "93", "title": "酷我飙升榜", "cover": "http://img2.kwcdn.kuwo.cn/star/upload/11/11/1649671202619_.png", "updateFrequency": "每天更新"},
                    {"id": "16", "title": "酷我热歌榜", "cover": "https://kwimg3.kuwo.cn/star/upload/ecom/1684642476266.png", "updateFrequency": "每天更新"},
                    {"id": "17", "title": "酷我新歌榜", "cover": "http://img4.kwcdn.kuwo.cn/star/upload/9/9/1649671239841_.png", "updateFrequency": "每天更新"}
                ]
            },
            {
                "name": "🌐 地区与全球榜",
                "key": "region",
                "lists": [
                    {"id": "104", "title": "酷我华语榜", "cover": "http://img2.kwcdn.kuwo.cn/star/upload/5/5/1649672627397_.png", "updateFrequency": "每周更新"},
                    {"id": "182", "title": "酷我粤语榜", "cover": "http://img1.kwcdn.kuwo.cn/star/upload/3/3/1649672580355_.png", "updateFrequency": "每周更新"},
                    {"id": "12", "title": "美国Billboard", "cover": "http://img3.kwcdn.kuwo.cn/star/upload/10/10/1649672653402_.jpg", "updateFrequency": "每周更新"},
                    {"id": "180", "title": "Beatport电音榜", "cover": "http://img4.kwcdn.kuwo.cn/star/upload/0/0/1649672695520_.jpg", "updateFrequency": "每周更新"}
                ]
            },
            {
                "name": "✨ 风格与特色潮流榜",
                "key": "genre",
                "lists": [
                    {"id": "158", "title": "抖音热歌榜", "cover": "http://img3.kwcdn.kuwo.cn/star/upload/15/15/1649671510488_.jpg", "updateFrequency": "每天更新"},
                    {"id": "187", "title": "古风音乐榜", "cover": "http://img1.kwcdn.kuwo.cn/star/upload/9/9/1649671694939_.jpg", "updateFrequency": "每周更新"},
                    {"id": "64", "title": "影视金曲榜", "cover": "http://img3.kwcdn.kuwo.cn/star/upload/14/14/1649671752488_.jpg", "updateFrequency": "每周更新"},
                    {"id": "186", "title": "DJ嗨歌榜", "cover": "http://img3.kwcdn.kuwo.cn/star/upload/8/8/1649671802958_.jpg", "updateFrequency": "每周更新"}
                ]
            }
        ]
    },
    "kg": {
        "platform": "kg",
        "platformName": "酷狗音乐",
        "categories": [
            {
                "name": "⭐ 官方核心榜",
                "key": "core",
                "lists": [
                    {"id": "8888", "title": "酷狗TOP500", "cover": "http://imge.kugou.com/mcommon/400/20241219/20241219164209670219.png", "updateFrequency": "每天更新"},
                    {"id": "6666", "title": "飙升榜", "cover": "http://imge.kugou.com/mcommon/400/20241219/20241219193628550054.png", "updateFrequency": "每天更新"},
                    {"id": "74534", "title": "新歌榜", "cover": "http://imge.kugou.com/mcommon/400/20241219/20241219200509300768.png", "updateFrequency": "每天更新"}
                ]
            },
            {
                "name": "🌐 地区与全球榜",
                "key": "region",
                "lists": [
                    {"id": "31308", "title": "内地榜", "cover": "http://imge.kugou.com/mcommon/400/20241211/20241211192146592398.png", "updateFrequency": "每周更新"},
                    {"id": "31310", "title": "欧美新歌榜", "cover": "http://imge.kugou.com/mcommon/400/20241211/20241211184719475668.jpg", "updateFrequency": "每周更新"},
                    {"id": "33162", "title": "粤语新歌榜", "cover": "http://imge.kugou.com/mcommon/400/20241211/20241211184628349205.jpg", "updateFrequency": "每周更新"}
                ]
            },
            {
                "name": "✨ 风格与特色潮流榜",
                "key": "genre",
                "lists": [
                    {"id": "82831", "title": "网络热歌榜", "cover": "http://imge.kugou.com/mcommon/400/20241219/20241219195626644029.png", "updateFrequency": "每天更新"},
                    {"id": "85897", "title": "国潮音乐榜", "cover": "http://imge.kugou.com/mcommon/400/20241120/20241120202644296668.jpg", "updateFrequency": "每周更新"},
                    {"id": "33160", "title": "电音榜", "cover": "http://imge.kugou.com/mcommon/400/20241211/20241211184628349205.jpg", "updateFrequency": "每周更新"},
                    {"id": "51341", "title": "民谣榜", "cover": "http://imge.kugou.com/mcommon/400/20241211/20241211184719475668.jpg", "updateFrequency": "每周更新"}
                ]
            }
        ]
    },
    "mg": {
        "platform": "mg",
        "platformName": "咪咕音乐",
        "categories": [
            {
                "name": "⭐ 官方核心榜",
                "key": "core",
                "lists": [
                    {"id": "27553319", "title": "尖叫新歌榜", "cover": "https://d.musicapp.migu.cn/data/oss/column/00/1w/rk/bb9a98b3a7f341e5b685bb0e40d0f9d3.webp", "updateFrequency": "实时更新"},
                    {"id": "27186466", "title": "尖叫热歌榜", "cover": "https://d.musicapp.migu.cn/data/oss/column/00/1w/rj/f672e381440f48bdb9458e24e5b02cb1.webp", "updateFrequency": "实时更新"},
                    {"id": "27553408", "title": "尖叫原创榜", "cover": "https://d.musicapp.migu.cn/data/oss/column/00/1w/rk/a9d5f0c5b9f74f76a430361cd358a5f0.webp", "updateFrequency": "实时更新"}
                ]
            },
            {
                "name": "🌐 地区与全球榜",
                "key": "region",
                "lists": [
                    {"id": "23189399", "title": "内地榜", "cover": "https://d.musicapp.migu.cn/data/oss/column/00/1v/i9/51.webp", "updateFrequency": "每周更新"},
                    {"id": "23189800", "title": "港台榜", "cover": "https://d.musicapp.migu.cn/data/oss/column/00/1v/i9/qv.webp", "updateFrequency": "每周更新"}
                ]
            },
            {
                "name": "✨ 风格与特色潮流榜",
                "key": "genre",
                "lists": [
                    {"id": "27553319", "title": "影视金曲热推", "cover": "https://d.musicapp.migu.cn/data/oss/column/00/1w/rk/bb9a98b3a7f341e5b685bb0e40d0f9d3.webp", "updateFrequency": "每天更新"}
                ]
            }
        ]
    }
}


# ========================================================
# 模块 1: 榜单目录抓取与清洗编排 (按三级互斥分类组织)
# ========================================================

def _fetch_qq_catalog() -> dict:
    post_data = {
        "comm": {"cv": 4747474, "ct": 24, "format": "json", "inCharset": "utf-8", "outCharset": "utf-8", "notice": 0, "platform": "yqq.json", "needNewCode": 1},
        "req_1": {"module": "musicToplist.ToplistInfoServer", "method": "GetAll", "param": {}}
    }
    st, body, _ = http_post_json("https://u.y.qq.com/cgi-bin/musicu.fcg", post_data, headers={"User-Agent": USER_AGENT, "Referer": "https://y.qq.com/"}, timeout=5.0, secure=True)
    if st != 200 or not body:
        return FALLBACK_CATALOGS["qq"]
    try:
        data = json.loads(body.decode("utf-8", errors="ignore"))
        groups = data.get("req_1", {}).get("data", {}).get("group", [])
        if not groups:
            return FALLBACK_CATALOGS["qq"]

        core_lists = []
        region_lists = []
        genre_lists = []

        for g in groups:
            gid = g.get("groupId")
            toplist = g.get("toplist", [])
            for item in toplist:
                cid = str(item.get("topId"))
                title = item.get("title") or ""
                cover = item.get("frontPicUrl") or item.get("headPicUrl") or ""
                update_freq = item.get("updateTips") or item.get("period") or "实时更新"
                entry = {"id": cid, "title": title, "cover": cover, "updateFrequency": update_freq}

                if gid == 0 or cid in ("62", "26", "27", "4"):
                    core_lists.append(entry)
                elif gid in (1, 3) or "榜" in title and any(x in title for x in ["内地", "香港", "台湾", "欧美", "韩国", "日本", "英国", "公告牌"]):
                    region_lists.append(entry)
                else:
                    genre_lists.append(entry)

        return {
            "ok": True,
            "platform": "qq",
            "platformName": "企鹅音乐",
            "categories": [
                {"name": "⭐ 官方核心榜", "key": "core", "lists": core_lists[:8] if core_lists else FALLBACK_CATALOGS["qq"]["categories"][0]["lists"]},
                {"name": "🌐 地区与全球榜", "key": "region", "lists": region_lists[:12] if region_lists else FALLBACK_CATALOGS["qq"]["categories"][1]["lists"]},
                {"name": "✨ 风格与特色潮流榜", "key": "genre", "lists": genre_lists[:16] if genre_lists else FALLBACK_CATALOGS["qq"]["categories"][2]["lists"]}
            ]
        }
    except Exception:
        return FALLBACK_CATALOGS["qq"]


def _fetch_wy_catalog() -> dict:
    st, body, _, _ = http_get("https://music.163.com/api/toplist", headers={"User-Agent": USER_AGENT, "Referer": "https://music.163.com/"}, timeout=5.0, secure=True)
    if st != 200 or not body:
        return FALLBACK_CATALOGS["wy"]
    try:
        data = json.loads(body.decode("utf-8", errors="ignore"))
        raw_list = data.get("list", [])
        if not raw_list:
            return FALLBACK_CATALOGS["wy"]

        core_lists = []
        region_lists = []
        genre_lists = []

        CORE_IDS = {"19723756", "3779629", "2884035", "3778678"}

        for item in raw_list:
            cid = str(item.get("id"))
            name = item.get("name") or ""
            cover = item.get("coverImgUrl") or ""
            freq = item.get("updateFrequency") or "定期更新"
            entry = {"id": cid, "title": name, "cover": cover, "updateFrequency": freq}

            if cid in CORE_IDS or name in ("飙升榜", "新歌榜", "原创榜", "热歌榜"):
                core_lists.append(entry)
            elif any(k in name for k in ["Billboard", "UK", "Oricon", "全球", "欧美", "韩国", "日本", "云音乐欧美", "电音榜"]):
                region_lists.append(entry)
            else:
                genre_lists.append(entry)

        return {
            "ok": True,
            "platform": "wy",
            "platformName": "网易云音乐",
            "categories": [
                {"name": "⭐ 官方核心榜", "key": "core", "lists": core_lists[:6] if core_lists else FALLBACK_CATALOGS["wy"]["categories"][0]["lists"]},
                {"name": "🌐 地区与全球榜", "key": "region", "lists": region_lists[:12] if region_lists else FALLBACK_CATALOGS["wy"]["categories"][1]["lists"]},
                {"name": "✨ 风格与特色潮流榜", "key": "genre", "lists": genre_lists[:16] if genre_lists else FALLBACK_CATALOGS["wy"]["categories"][2]["lists"]}
            ]
        }
    except Exception:
        return FALLBACK_CATALOGS["wy"]


def _fetch_kw_catalog() -> dict:
    st, body, _, _ = http_get("http://wapi.kuwo.cn/api/pc/bang/list", headers={"User-Agent": USER_AGENT, "Referer": "https://www.kuwo.cn/"}, timeout=5.0, secure=False)
    if st != 200 or not body:
        return FALLBACK_CATALOGS["kw"]
    try:
        data = json.loads(body.decode("utf-8", errors="ignore"))
        groups = data.get("child", [])
        if not groups:
            return FALLBACK_CATALOGS["kw"]

        core_lists = []
        region_lists = []
        genre_lists = []

        for g in groups:
            group_name = g.get("disname") or g.get("name") or ""
            sub_list = g.get("child", [])
            for item in sub_list:
                cid = str(item.get("sourceid") or item.get("id"))
                title = item.get("disname") or item.get("name") or ""
                cover = item.get("pic") or item.get("pic2") or ""
                freq = "每天更新" if "飙升" in title or "热歌" in title else "每周更新"
                entry = {"id": cid, "title": title, "cover": cover, "updateFrequency": freq}

                if "官方榜" in group_name or cid in ("93", "16", "17"):
                    core_lists.append(entry)
                elif "全球" in group_name or "语言" in group_name:
                    region_lists.append(entry)
                else:
                    genre_lists.append(entry)

        return {
            "ok": True,
            "platform": "kw",
            "platformName": "酷我音乐",
            "categories": [
                {"name": "⭐ 官方核心榜", "key": "core", "lists": core_lists[:8] if core_lists else FALLBACK_CATALOGS["kw"]["categories"][0]["lists"]},
                {"name": "🌐 地区与全球榜", "key": "region", "lists": region_lists[:12] if region_lists else FALLBACK_CATALOGS["kw"]["categories"][1]["lists"]},
                {"name": "✨ 风格与特色潮流榜", "key": "genre", "lists": genre_lists[:16] if genre_lists else FALLBACK_CATALOGS["kw"]["categories"][2]["lists"]}
            ]
        }
    except Exception:
        return FALLBACK_CATALOGS["kw"]


def _fetch_kg_catalog() -> dict:
    st, body, _, _ = http_get("http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0", headers={"User-Agent": USER_AGENT}, timeout=5.0, secure=False)
    if st != 200 or not body:
        return FALLBACK_CATALOGS["kg"]
    try:
        data = json.loads(body.decode("utf-8", errors="ignore"))
        raw_list = data.get("data", {}).get("info", [])
        if not raw_list:
            return FALLBACK_CATALOGS["kg"]

        core_lists = []
        region_lists = []
        genre_lists = []

        CORE_IDS = {"8888", "6666", "74534", "31308"}

        for item in raw_list:
            cid = str(item.get("rankid"))
            title = item.get("rankname") or ""
            raw_img = item.get("banner_url") or item.get("imgurl") or ""
            cover = raw_img.replace("{size}", "400") if raw_img else ""
            freq = "每天更新" if "TOP" in title or "飙升" in title else "每周更新"
            entry = {"id": cid, "title": title, "cover": cover, "updateFrequency": freq}

            if cid in CORE_IDS or any(k in title for k in ("TOP500", "飙升", "新歌榜")):
                core_lists.append(entry)
            elif any(k in title for k in ("内地", "港台", "粤语", "欧美", "日韩", "日本", "韩国", "香港")):
                region_lists.append(entry)
            else:
                genre_lists.append(entry)

        return {
            "ok": True,
            "platform": "kg",
            "platformName": "酷狗音乐",
            "categories": [
                {"name": "⭐ 官方核心榜", "key": "core", "lists": core_lists[:6] if core_lists else FALLBACK_CATALOGS["kg"]["categories"][0]["lists"]},
                {"name": "🌐 地区与全球榜", "key": "region", "lists": region_lists[:12] if region_lists else FALLBACK_CATALOGS["kg"]["categories"][1]["lists"]},
                {"name": "✨ 风格与特色潮流榜", "key": "genre", "lists": genre_lists[:16] if genre_lists else FALLBACK_CATALOGS["kg"]["categories"][2]["lists"]}
            ]
        }
    except Exception:
        return FALLBACK_CATALOGS["kg"]


def _fetch_mg_catalog() -> dict:
    st, body, _, _ = http_get("https://app.c.nf.migu.cn/MIGUM3.0/v1.0/template/rank-list", headers={"User-Agent": USER_AGENT}, timeout=5.0, secure=True)
    if st != 200 or not body:
        return FALLBACK_CATALOGS["mg"]
    try:
        raw_text = body.decode("utf-8", errors="ignore")
        cleaned_text = re.sub(r',\s*([}\]])', r'\1', raw_text)
        data = json.loads(cleaned_text)

        core_lists = []
        region_lists = []
        genre_lists = []

        MIGU_NAME_MAP = {
            "27553319": "尖叫新歌榜",
            "27186466": "尖叫热歌榜",
            "27553408": "尖叫原创榜",
            "23189399": "内地榜",
            "23189800": "港台榜"
        }

        for group in data.get("data", {}).get("contentItemList", []):
            for item in group.get("itemList", []):
                act_url = item.get("actionUrl") or ""
                m = re.search(r'id=(\d+)', act_url)
                if not m:
                    continue
                cid = m.group(1)
                title = MIGU_NAME_MAP.get(cid)
                if not title:
                    raw_t = item.get("title") or ""
                    clean_title = re.sub(r'<[^>]+>', '', raw_t).strip()
                    if " · " in clean_title:
                        clean_title = clean_title.split(" · ")[0]
                    clean_title = re.sub(r'^\d+\.', '', clean_title).strip()
                    title = clean_title or f"咪咕榜单 #{cid}"

                cover = item.get("imageUrl") or item.get("picUrl") or ""
                entry = {"id": cid, "title": title, "cover": cover, "updateFrequency": "实时更新" if "尖叫" in title else "每周更新"}

                if cid in ("27553319", "27186466", "27553408"):
                    core_lists.append(entry)
                elif cid in ("23189399", "23189800"):
                    region_lists.append(entry)
                else:
                    genre_lists.append(entry)

        return {
            "ok": True,
            "platform": "mg",
            "platformName": "咪咕音乐",
            "categories": [
                {"name": "⭐ 官方核心榜", "key": "core", "lists": core_lists or FALLBACK_CATALOGS["mg"]["categories"][0]["lists"]},
                {"name": "🌐 地区与全球榜", "key": "region", "lists": region_lists or FALLBACK_CATALOGS["mg"]["categories"][1]["lists"]},
                {"name": "✨ 风格与特色潮流榜", "key": "genre", "lists": genre_lists or FALLBACK_CATALOGS["mg"]["categories"][2]["lists"]}
            ]
        }
    except Exception:
        return FALLBACK_CATALOGS["mg"]


def get_charts_list(platform: str) -> dict:
    """获取指定平台的榜单分类目录 (带 24h 内存缓存)"""
    plat = (platform or "qq").lower().strip()
    if plat == "tx":
        plat = "qq"

    now = time.time()
    with _CACHE_LOCK:
        cached = _CATALOG_CACHE.get(plat)
        if cached and (now - cached["ts"]) < _CATALOG_CACHE_TTL:
            return cached["data"]

    catalog = None
    if plat == "qq":
        catalog = _fetch_qq_catalog()
    elif plat == "wy":
        catalog = _fetch_wy_catalog()
    elif plat == "kw":
        catalog = _fetch_kw_catalog()
    elif plat == "kg":
        catalog = _fetch_kg_catalog()
    elif plat == "mg":
        catalog = _fetch_mg_catalog()
    else:
        catalog = FALLBACK_CATALOGS.get(plat, {"ok": False, "error": f"不支持的平台: {platform}"})

    if catalog and catalog.get("ok"):
        with _CACHE_LOCK:
            _CATALOG_CACHE[plat] = {"ts": now, "data": catalog}

    return catalog or FALLBACK_CATALOGS.get(plat, {"ok": False, "error": "无法获取榜单目录"})


# ========================================================
# 模块 2: 榜单曲目明细抓取与清洗标准化 (对齐 Amusic 曲目规范)
# ========================================================

def _fetch_qq_detail(top_id: str, page: int = 1, page_size: int = 100) -> dict:
    url = f"https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid={top_id}&n={page_size}&page={page}&type=top"
    st, body, _, _ = http_get(url, headers={"User-Agent": USER_AGENT, "Referer": "https://y.qq.com/"}, timeout=8.0, secure=True)
    if st != 200 or not body:
        raise ValueError(f"企鹅音乐榜单接口响应异常 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore"))
    topinfo = data.get("topinfo", {})
    title = topinfo.get("ListName") or f"QQ音乐榜单 {top_id}"
    cover = topinfo.get("pic_v12") or topinfo.get("pic") or ""
    update_time = data.get("update_time") or "实时更新"
    total = int(data.get("cur_song_num") or data.get("total_song_num") or 100)

    raw_songlist = data.get("songlist", [])
    tracks = []
    for idx, item in enumerate(raw_songlist):
        s = item.get("data") or item
        smid = s.get("songmid") or s.get("mid") or ""
        singers = [sg.get("name") for sg in s.get("singer") or [] if sg.get("name")]
        dur = (s.get("interval") or 0) * 1000
        album_mid = s.get("albummid") or ""
        song_cover = f"https://y.gtimg.cn/music/photo_new/T002R300x300M000{album_mid}.jpg" if album_mid else cover

        tracks.append({
            "index": idx + 1 + (page - 1) * page_size,
            "name": s.get("songname") or s.get("name") or "未知歌曲",
            "artist": " / ".join(singers) or "未知歌手",
            "album": s.get("albumname") or title,
            "durationMillis": dur,
            "sourcePlatform": "tx",
            "platform": "tx",
            "id": str(smid),
            "coverUrl": song_cover,
            "url": f"https://y.qq.com/n/ryqq/songDetail/{smid}" if smid else ""
        })

    return {
        "ok": True,
        "platform": "qq",
        "platformName": "企鹅音乐",
        "id": str(top_id),
        "title": title,
        "cover": cover,
        "updateFrequency": update_time,
        "total": max(total, len(tracks)),
        "page": page,
        "pageSize": page_size,
        "tracks": tracks
    }


def _fetch_wy_detail(top_id: str, page: int = 1, page_size: int = 100) -> dict:
    url = f"https://music.163.com/api/v6/playlist/detail?id={top_id}&n={page_size}"
    st, body, _, _ = http_get(url, headers={"User-Agent": USER_AGENT, "Referer": "https://music.163.com/"}, timeout=8.0, secure=True)
    if st != 200 or not body:
        raise ValueError(f"网易云榜单接口响应异常 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore"))
    pl = data.get("playlist") or {}
    title = pl.get("name") or f"网易云榜单 {top_id}"
    cover = pl.get("coverImgUrl") or ""
    update_freq = pl.get("updateFrequency") or "每天更新"
    total = int(pl.get("trackCount") or 100)

    raw_tracks = pl.get("tracks", [])
    tracks = []
    for idx, s in enumerate(raw_tracks):
        sid = str(s.get("id"))
        artists = [a.get("name") for a in s.get("ar") or [] if a.get("name")]
        dur = s.get("dt") or 0
        al = s.get("al") or {}
        album_name = al.get("name") or title
        song_cover = al.get("picUrl") or cover

        tracks.append({
            "index": idx + 1,
            "name": s.get("name") or "未知歌曲",
            "artist": " / ".join(artists) or "未知歌手",
            "album": album_name,
            "durationMillis": dur,
            "sourcePlatform": "wy",
            "platform": "wy",
            "id": sid,
            "coverUrl": song_cover,
            "url": f"https://music.163.com/#/song?id={sid}"
        })

    return {
        "ok": True,
        "platform": "wy",
        "platformName": "网易云音乐",
        "id": str(top_id),
        "title": title,
        "cover": cover,
        "updateFrequency": update_freq,
        "total": max(total, len(tracks)),
        "page": page,
        "pageSize": page_size,
        "tracks": tracks
    }


def _fetch_kw_detail(top_id: str, page: int = 1, page_size: int = 100) -> dict:
    pn = max(0, page - 1)
    url = f"http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&type=bang&data=bang&id={top_id}&pn={pn}&rn={page_size}"
    st, body, _, _ = http_get(url, headers={"User-Agent": USER_AGENT, "Referer": "https://www.kuwo.cn/"}, timeout=8.0, secure=False)
    if st != 200 or not body:
        raise ValueError(f"酷我音乐榜单接口响应异常 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore"))
    title = data.get("name") or f"酷我榜单 {top_id}"
    cover = data.get("pic") or ""
    total = int(data.get("num") or len(data.get("musiclist", [])) or 100)

    raw_music = data.get("musiclist", [])
    tracks = []
    for idx, item in enumerate(raw_music):
        rid = str(item.get("id") or item.get("musicrid", "")).replace("MUSIC_", "")
        dur = int(item.get("duration") or 0) * 1000
        song_cover = item.get("pic") or cover

        tracks.append({
            "index": idx + 1 + pn * page_size,
            "name": item.get("name") or "未知歌曲",
            "artist": item.get("artist") or "未知歌手",
            "album": item.get("album") or title,
            "durationMillis": dur,
            "sourcePlatform": "kw",
            "platform": "kw",
            "id": rid,
            "coverUrl": song_cover,
            "url": f"https://www.kuwo.cn/play_detail/{rid}" if rid else ""
        })

    return {
        "ok": True,
        "platform": "kw",
        "platformName": "酷我音乐",
        "id": str(top_id),
        "title": title,
        "cover": cover,
        "updateFrequency": "每天更新",
        "total": max(total, len(tracks)),
        "page": page,
        "pageSize": page_size,
        "tracks": tracks
    }


def _fetch_kg_detail(top_id: str, page: int = 1, page_size: int = 100) -> dict:
    url = f"http://mobilecdnbj.kugou.com/api/v3/rank/song?rankid={top_id}&page={page}&pagesize={page_size}"
    st, body, _, _ = http_get(url, headers={"User-Agent": USER_AGENT}, timeout=8.0, secure=False)
    if st != 200 or not body:
        raise ValueError(f"酷狗音乐榜单接口响应异常 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore"))
    inner_data = data.get("data", {})
    total = int(inner_data.get("total") or 100)
    raw_info = inner_data.get("info", [])

    title = f"酷狗榜单 {top_id}"
    cover = ""
    tracks = []

    for idx, item in enumerate(raw_info):
        raw_hash = item.get("hash") or item.get("sqhash") or item.get("320hash") or ""
        filename = item.get("filename") or ""
        song_name = item.get("songname") or (filename.split(" - ")[-1] if " - " in filename else filename) or "未知歌曲"
        
        authors = item.get("authors") or []
        if authors:
            singer = " / ".join([a.get("author_name") for a in authors if a.get("author_name")])
        elif " - " in filename:
            singer = filename.split(" - ")[0]
        else:
            singer = "未知歌手"

        dur = int(item.get("duration") or 0) * 1000
        raw_cover = item.get("album_sizable_cover") or ""
        song_cover = raw_cover.replace("{size}", "400") if raw_cover else ""
        if not cover and song_cover:
            cover = song_cover

        tracks.append({
            "index": idx + 1 + (page - 1) * page_size,
            "name": song_name,
            "artist": singer,
            "album": item.get("remark") or title,
            "durationMillis": dur,
            "sourcePlatform": "kg",
            "platform": "kg",
            "id": raw_hash,
            "coverUrl": song_cover,
            "url": f"https://www.kugou.com/song/#hash={raw_hash}" if raw_hash else ""
        })

    return {
        "ok": True,
        "platform": "kg",
        "platformName": "酷狗音乐",
        "id": str(top_id),
        "title": title,
        "cover": cover,
        "updateFrequency": "每天更新",
        "total": max(total, len(tracks)),
        "page": page,
        "pageSize": page_size,
        "tracks": tracks
    }


def _fetch_mg_detail(top_id: str, page: int = 1, page_size: int = 100) -> dict:
    url = f"https://app.c.nf.migu.cn/MIGUM3.0/v1.0/template/rank-detail?columnId={top_id}"
    st, body, _, _ = http_get(url, headers={"User-Agent": USER_AGENT}, timeout=8.0, secure=True)
    if st != 200 or not body:
        raise ValueError(f"咪咕音乐榜单接口响应异常 (HTTP {st})")
    raw_text = body.decode("utf-8", errors="ignore")
    cleaned_text = re.sub(r',\s*([}\]])', r'\1', raw_text)
    data = json.loads(cleaned_text)

    col_info = data.get("data", {}).get("columnInfo", {})
    title = col_info.get("title") or f"咪咕榜单 {top_id}"
    cover = col_info.get("columnPic") or col_info.get("songPic") or ""
    update_freq = col_info.get("updateDate") or "实时更新"
    raw_list = col_info.get("dataList", [])
    total = len(raw_list)

    tracks = []
    for idx, item in enumerate(raw_list[:page_size]):
        cid = str(item.get("copyrightId") or item.get("contentId") or item.get("songId") or "")
        song_name = item.get("songName") or "未知歌曲"
        singer = item.get("singer") or "未知歌手"
        album_name = item.get("album") or title

        # 解析时长 (如 "00:03:36")
        dur_millis = 0
        raw_len = item.get("length") or ""
        if raw_len and ":" in raw_len:
            parts = raw_len.split(":")
            try:
                if len(parts) == 2:
                    dur_millis = (int(parts[0]) * 60 + int(parts[1])) * 1000
                elif len(parts) == 3:
                    dur_millis = (int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])) * 1000
            except Exception:
                dur_millis = 0

        album_imgs = item.get("albumImgs") or []
        song_cover = album_imgs[0].get("img") if album_imgs else cover

        tracks.append({
            "index": idx + 1,
            "name": song_name,
            "artist": singer,
            "album": album_name,
            "durationMillis": dur_millis,
            "sourcePlatform": "mg",
            "platform": "mg",
            "id": cid,
            "coverUrl": song_cover,
            "url": f"https://music.migu.cn/v3/music/song/{cid}" if cid else ""
        })

    return {
        "ok": True,
        "platform": "mg",
        "platformName": "咪咕音乐",
        "id": str(top_id),
        "title": title,
        "cover": cover,
        "updateFrequency": update_freq,
        "total": max(total, len(tracks)),
        "page": page,
        "pageSize": page_size,
        "tracks": tracks
    }


def get_charts_detail(platform: str, chart_id: str, page: int = 1, page_size: int = 100) -> dict:
    """获取指定平台某榜单的曲目明细 (带 12h 内存缓存与优雅兜底)"""
    plat = (platform or "qq").lower().strip()
    if plat == "tx":
        plat = "qq"
    cid = str(chart_id or "").strip()
    if not cid:
        return {"ok": False, "error": "缺少榜单 ID"}

    cache_key = f"{plat}_{cid}_{page}_{page_size}"
    now = time.time()
    with _CACHE_LOCK:
        cached = _DETAIL_CACHE.get(cache_key)
        if cached and (now - cached["ts"]) < _DETAIL_CACHE_TTL:
            return cached["data"]

    detail = None
    try:
        if plat == "qq":
            detail = _fetch_qq_detail(cid, page=page, page_size=page_size)
        elif plat == "wy":
            detail = _fetch_wy_detail(cid, page=page, page_size=page_size)
        elif plat == "kw":
            detail = _fetch_kw_detail(cid, page=page, page_size=page_size)
        elif plat == "kg":
            detail = _fetch_kg_detail(cid, page=page, page_size=page_size)
        elif plat == "mg":
            detail = _fetch_mg_detail(cid, page=page, page_size=page_size)
        else:
            return {"ok": False, "error": f"不支持的平台: {platform}"}
    except Exception as e:
        # 若网络异常且有过期缓存，返回过期缓存保障体验
        if cached:
            return cached["data"]
        return {"ok": False, "error": f"获取榜单歌曲失败: {str(e)}"}

    if detail and detail.get("ok"):
        with _CACHE_LOCK:
            _DETAIL_CACHE[cache_key] = {"ts": now, "data": detail}

    return detail
