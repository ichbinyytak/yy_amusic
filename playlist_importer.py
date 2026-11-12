#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
========================================================
模块：playlist_importer.py - 外部音乐平台歌单/专辑/歌手单曲导入中枢
设计依据：architecture-playlist-import.md (单一事实来源)
核心原则：
  1. 主流无登录全覆盖 (9 类平台)：
     - 网易云音乐 (wy)、QQ 音乐 (tx/qq)、酷我音乐 (kw)
     - 汽水音乐、咪咕音乐 (mg)、酷狗概念版 (kg)
     - Apple Music、街声 (StreetVoice)、Spotify (海外免 OAuth)
  2. 严苛 SSRF 防护：多跳短链重定向每一跳均复用 net_pool.py 且强制校验 is_safe_external_url
  3. 元数据严格对齐 Amusic 规范：name, artist, album, durationMillis, url, sourcePlatform
  4. 支持平台：直连音源透传 platform + id，其余走 song_search 严格繁简转换与 15s 硬门禁
========================================================
"""

import html as html_lib
import json
import re
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import net_pool
from server import is_safe_external_url
from streetvoice_catalog import fetch_sv_playlist_songs

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
)
MAX_IMPORT_TRACKS = 1000

# ========================================================
# 区块 1: 安全多跳短链展开与 URL 提取 (SSRF 防御)
# ========================================================

def extract_url_from_text(text: str) -> str:
    """从中文分享口令、微信安全检测转链、Markdown 文案中提取有效 HTTP/HTTPS 链接"""
    if not text or not isinstance(text, str):
        return ""

    # 1. 优先提取微信客户端安全转链中的真实目标 (requrl)
    m_wx = re.search(r"https?://(?:wx|weixin)\.qq\.com/[^\s<>\"'()]+\?[^\s<>\"'()]*requrl=([^\s&<>\"'()]+)", text)
    if m_wx:
        try:
            unquoted = urllib.parse.unquote(m_wx.group(1)).rstrip("，。！？；、),\"'>][")
            if unquoted.startswith("http"):
                return unquoted
        except Exception:
            pass

    # 2. 通用 HTTP/HTTPS 链接提取 (剥除中文标点、括号与 Markdown 方括号)
    m = re.search(r"https?://[^\s<>\"'()]+", text)
    if m:
        url = m.group(0).rstrip("，。！？；、),\"'>][")
        if "webwxcheckurl" in url or "requrl=" in url:
            try:
                parsed = urllib.parse.urlparse(url)
                qs = urllib.parse.parse_qs(parsed.query)
                if "requrl" in qs and qs["requrl"]:
                    real_req = qs["requrl"][0]
                    if real_req.startswith("http"):
                        return real_req.rstrip("，。！？；、),\"'>][")
            except Exception:
                pass
        return url
    return ""


def resolve_safe_redirects(start_url: str, max_hops: int = 8) -> tuple:
    """
    逐跳追踪短链重定向，每一跳均强制执行 SSRF 安全校验。
    返回: (final_url: str, body_bytes: bytes, status_code: int)
    """
    cur_url = start_url.strip()
    last_body = b""
    last_status = 0

    for hop in range(max_hops):
        if not is_safe_external_url(cur_url):
            raise ValueError(f"SSRF 安全拦截：非法或内网重定向目标 {cur_url}")

        status, body, _, headers = net_pool.http_get(
            cur_url,
            headers={"User-Agent": USER_AGENT},
            timeout=8.0,
            redirect=False,
            secure=True,
        )
        last_body = body
        last_status = status

        if status in (301, 302, 303, 307, 308):
            loc = headers.get("Location") or headers.get("location") or ""
            if not loc:
                break
            next_url = urllib.parse.urljoin(cur_url, loc)
            if next_url == cur_url:
                break
            cur_url = next_url
            continue
        break

    return cur_url, last_body, last_status


# ========================================================
# 区块 2: 网易云音乐 (Netease, 'wy')
# ========================================================

def _fetch_netease_songs_detail(song_ids: list) -> dict:
    """批量获取网易云曲目详情 (每批 400 首)"""
    res = {}
    chunk_size = 400
    for i in range(0, len(song_ids), chunk_size):
        chunk = song_ids[i:i + chunk_size]
        c_param = json.dumps([{"id": sid} for sid in chunk], separators=(",", ":"))
        api_url = f"https://music.163.com/api/v3/song/detail?c={urllib.parse.quote(c_param)}"
        st, body, _, _ = net_pool.http_get(
            api_url,
            headers={"User-Agent": USER_AGENT, "Referer": "https://music.163.com/"},
            timeout=8.0,
            secure=True,
        )
        if st == 200 and body:
            try:
                data = json.loads(body.decode("utf-8", errors="ignore"))
                for s in data.get("songs") or []:
                    sid = s.get("id")
                    if sid:
                        res[str(sid)] = s
            except Exception:
                pass
    return res


def import_netease(res_type: str, item_id: str, orig_url: str) -> dict:
    """网易云歌单 / 专辑 / 歌手热门单曲解析"""
    if res_type == "album":
        api_url = f"https://music.163.com/api/v1/album/{item_id}"
        st, body, _, _ = net_pool.http_get(
            api_url,
            headers={"User-Agent": USER_AGENT, "Referer": "https://music.163.com/"},
            timeout=8.0,
            secure=True,
        )
        if st != 200 or not body:
            raise ValueError(f"请求网易云专辑接口失败 (HTTP {st})")
        data = json.loads(body.decode("utf-8", errors="ignore"))
        album_info = data.get("album") or {}
        raw_songs = data.get("songs") or []
        title = album_info.get("name") or "网易云专辑"
        curator = (album_info.get("artist") or {}).get("name") or "未知歌手"
        cover = album_info.get("picUrl") or ""

        tracks = []
        for idx, s in enumerate(raw_songs[:MAX_IMPORT_TRACKS]):
            artists = [a.get("name") for a in s.get("artists") or [] if a.get("name")]
            tracks.append({
                "index": idx + 1,
                "name": s.get("name") or "未知曲目",
                "artist": "/".join(artists) or curator,
                "album": title,
                "durationMillis": s.get("duration") or 0,
                "url": f"https://music.163.com/#/song?id={s.get('id')}",
                "sourcePlatform": "wy",
                "platform": "wy",
                "id": str(s.get("id")),
            })

        return {
            "ok": True,
            "platform": "wy",
            "platformName": "网易云音乐",
            "resourceType": "album",
            "resourceTypeLabel": "专辑",
            "id": str(item_id),
            "title": title,
            "curator": curator,
            "coverUrl": cover,
            "sourceUrl": orig_url,
            "total": len(tracks),
            "tracks": tracks,
        }

    if res_type == "artist":
        api_url = f"https://music.163.com/api/v1/artist/{item_id}"
        st, body, _, _ = net_pool.http_get(
            api_url,
            headers={"User-Agent": USER_AGENT, "Referer": "https://music.163.com/"},
            timeout=8.0,
            secure=True,
        )
        if st != 200 or not body:
            raise ValueError(f"请求网易云歌手接口失败 (HTTP {st})")
        data = json.loads(body.decode("utf-8", errors="ignore"))
        artist_info = data.get("artist") or {}
        raw_songs = data.get("hotSongs") or []
        curator = artist_info.get("name") or "未知歌手"
        title = f"{curator} - 热门单曲"
        cover = artist_info.get("picUrl") or ""

        tracks = []
        for idx, s in enumerate(raw_songs[:MAX_IMPORT_TRACKS]):
            artists = [a.get("name") for a in s.get("artists") or [] if a.get("name")]
            tracks.append({
                "index": idx + 1,
                "name": s.get("name") or "未知曲目",
                "artist": "/".join(artists) or curator,
                "album": (s.get("album") or {}).get("name") or title,
                "durationMillis": s.get("duration") or 0,
                "url": f"https://music.163.com/#/song?id={s.get('id')}",
                "sourcePlatform": "wy",
                "platform": "wy",
                "id": str(s.get("id")),
            })

        return {
            "ok": True,
            "platform": "wy",
            "platformName": "网易云音乐",
            "resourceType": "artist",
            "resourceTypeLabel": "歌手热门单曲",
            "id": str(item_id),
            "title": title,
            "curator": curator,
            "coverUrl": cover,
            "sourceUrl": orig_url,
            "total": len(tracks),
            "tracks": tracks,
        }

    # 默认歌单 playlist
    api_url = f"https://music.163.com/api/v6/playlist/detail?id={item_id}"
    st, body, _, _ = net_pool.http_get(
        api_url,
        headers={"User-Agent": USER_AGENT, "Referer": "https://music.163.com/"},
        timeout=8.0,
        secure=True,
    )
    if st != 200 or not body:
        raise ValueError(f"请求网易云歌单接口失败 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore"))
    pl = data.get("playlist") or {}
    title = pl.get("name") or "网易云歌单"
    curator = (pl.get("creator") or {}).get("nickname") or "网易云用户"
    cover = pl.get("coverImgUrl") or ""
    track_ids = [str(t.get("id")) for t in pl.get("trackIds") or [] if t.get("id")][:MAX_IMPORT_TRACKS]

    # 若 tracks 已包含全部歌曲则直接使用，否则分批补齐
    initial_tracks = pl.get("tracks") or []
    songs_map = {str(s.get("id")): s for s in initial_tracks if s.get("id")}
    missing_ids = [tid for tid in track_ids if tid not in songs_map]
    if missing_ids:
        more_songs = _fetch_netease_songs_detail(missing_ids)
        songs_map.update(more_songs)

    tracks = []
    for idx, tid in enumerate(track_ids):
        s = songs_map.get(tid)
        if not s:
            continue
        artists = [a.get("name") for a in s.get("ar") or s.get("artists") or [] if a.get("name")]
        dur = s.get("dt") or s.get("duration") or 0
        al_name = (s.get("al") or s.get("album") or {}).get("name") or title
        tracks.append({
            "index": idx + 1,
            "name": s.get("name") or "未知曲目",
            "artist": "/".join(artists) or "未知歌手",
            "album": al_name,
            "durationMillis": dur,
            "url": f"https://music.163.com/#/song?id={tid}",
            "sourcePlatform": "wy",
            "platform": "wy",
            "id": str(tid),
        })

    return {
        "ok": True,
        "platform": "wy",
        "platformName": "网易云音乐",
        "resourceType": "playlist",
        "resourceTypeLabel": "歌单",
        "id": str(item_id),
        "title": title,
        "curator": curator,
        "coverUrl": cover,
        "sourceUrl": orig_url,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 3: QQ 音乐 (Tencent, 'tx' / 'qq')
# ========================================================

def import_qq(res_type: str, item_id: str, orig_url: str) -> dict:
    """QQ 音乐歌单 / 专辑 / 歌手热门单曲解析"""
    if res_type == "album":
        payload = {
            "comm": {"ct": 24, "cv": 0},
            "albumDetail": {
                "module": "music.musichallAlbum.AlbumInfoServer",
                "method": "GetAlbumDetail",
                "param": {"albumMid": str(item_id)},
            },
            "albumSonglist": {
                "module": "music.musichallAlbum.AlbumSongList",
                "method": "GetAlbumSongList",
                "param": {"albumMid": str(item_id), "begin": 0, "num": min(MAX_IMPORT_TRACKS, 300)},
            },
        }
        api_url = f"https://u.y.qq.com/cgi-bin/musicu.fcg?data={urllib.parse.quote(json.dumps(payload))}"
        st, body, _, _ = net_pool.http_get(
            api_url,
            headers={"User-Agent": USER_AGENT, "Referer": "https://y.qq.com/"},
            timeout=8.0,
            secure=True,
        )
        if st != 200 or not body:
            raise ValueError(f"请求 QQ 音乐专辑接口失败 (HTTP {st})")
        data = json.loads(body.decode("utf-8", errors="ignore"))
        basic_info = data.get("albumDetail", {}).get("data", {}).get("basicInfo", {})
        title = basic_info.get("albumName") or "QQ音乐专辑"
        curator = basic_info.get("singerName") or "未知歌手"
        cover = basic_info.get("albumPic") or ""
        song_list = data.get("albumSonglist", {}).get("data", {}).get("songList", [])

        tracks = []
        for idx, item in enumerate(song_list):
            s = item.get("songInfo") or item
            smid = s.get("mid") or s.get("songmid") or ""
            singers = [sg.get("name") for sg in s.get("singer") or [] if sg.get("name")]
            tracks.append({
                "index": idx + 1,
                "name": s.get("title") or s.get("name") or "未知曲目",
                "artist": "/".join(singers) or curator,
                "album": (s.get("album") or {}).get("name") or title,
                "durationMillis": (s.get("interval") or 0) * 1000,
                "url": f"https://y.qq.com/n/ryqq/songDetail/{smid}" if smid else orig_url,
                "sourcePlatform": "tx",
                "platform": "tx",
                "id": str(smid),
            })

        return {
            "ok": True,
            "platform": "tx",
            "platformName": "QQ 音乐",
            "resourceType": "album",
            "resourceTypeLabel": "专辑",
            "id": str(item_id),
            "title": title,
            "curator": curator,
            "coverUrl": cover,
            "sourceUrl": orig_url,
            "total": len(tracks),
            "tracks": tracks,
        }

    if res_type == "artist":
        payload = {
            "comm": {"ct": 24, "cv": 0},
            "singerSongList": {
                "module": "musichall.song_list_server",
                "method": "GetSingerSongList",
                "param": {"singerMid": str(item_id), "order": 1, "begin": 0, "num": min(MAX_IMPORT_TRACKS, 100)},
            },
        }
        api_url = f"https://u.y.qq.com/cgi-bin/musicu.fcg?data={urllib.parse.quote(json.dumps(payload))}"
        st, body, _, _ = net_pool.http_get(
            api_url,
            headers={"User-Agent": USER_AGENT, "Referer": "https://y.qq.com/"},
            timeout=8.0,
            secure=True,
        )
        if st != 200 or not body:
            raise ValueError(f"请求 QQ 音乐歌手接口失败 (HTTP {st})")
        data = json.loads(body.decode("utf-8", errors="ignore"))
        song_list = data.get("singerSongList", {}).get("data", {}).get("songList", [])
        curator = "未知歌手"
        if song_list:
            singers = song_list[0].get("songInfo", {}).get("singer") or []
            if singers:
                curator = singers[0].get("name") or curator
        title = f"{curator} - 热门单曲"

        tracks = []
        for idx, item in enumerate(song_list):
            s = item.get("songInfo") or item
            smid = s.get("mid") or s.get("songmid") or ""
            singers = [sg.get("name") for sg in s.get("singer") or [] if sg.get("name")]
            tracks.append({
                "index": idx + 1,
                "name": s.get("title") or s.get("name") or "未知曲目",
                "artist": "/".join(singers) or curator,
                "album": (s.get("album") or {}).get("name") or title,
                "durationMillis": (s.get("interval") or 0) * 1000,
                "url": f"https://y.qq.com/n/ryqq/songDetail/{smid}" if smid else orig_url,
                "sourcePlatform": "tx",
                "platform": "tx",
                "id": str(smid),
            })

        return {
            "ok": True,
            "platform": "tx",
            "platformName": "QQ 音乐",
            "resourceType": "artist",
            "resourceTypeLabel": "歌手热门单曲",
            "id": str(item_id),
            "title": title,
            "curator": curator,
            "coverUrl": "",
            "sourceUrl": orig_url,
            "total": len(tracks),
            "tracks": tracks,
        }

    # 默认歌单 playlist
    payload = {
        "comm": {"ct": 24, "cv": 0},
        "req_0": {
            "module": "music.srfDissInfo.aiDissInfo",
            "method": "uniform_get_Dissinfo",
            "param": {"disstid": int(item_id), "enc_host_uin": ""},
        },
    }
    api_url = f"https://u.y.qq.com/cgi-bin/musicu.fcg?data={urllib.parse.quote(json.dumps(payload))}"
    st, body, _, _ = net_pool.http_get(
        api_url,
        headers={"User-Agent": USER_AGENT, "Referer": "https://y.qq.com/"},
        timeout=8.0,
        secure=True,
    )
    if st != 200 or not body:
        raise ValueError(f"请求 QQ 音乐歌单接口失败 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore"))
    req_0 = data.get("req_0", {}).get("data", {})
    dirinfo = req_0.get("dirinfo") or {}
    title = dirinfo.get("title") or "QQ音乐歌单"
    curator = dirinfo.get("host_nick") or (dirinfo.get("creator") or {}).get("nick") or "QQ音乐用户"
    cover = dirinfo.get("picurl") or ""
    song_list = req_0.get("songlist") or []

    tracks = []
    for idx, s in enumerate(song_list[:MAX_IMPORT_TRACKS]):
        smid = s.get("mid") or s.get("songmid") or ""
        singers = [sg.get("name") for sg in s.get("singer") or [] if sg.get("name")]
        dur = (s.get("interval") or 0) * 1000
        tracks.append({
            "index": idx + 1,
            "name": s.get("title") or s.get("name") or "未知曲目",
            "artist": "/".join(singers) or "未知歌手",
            "album": (s.get("album") or {}).get("name") or title,
            "durationMillis": dur,
            "url": f"https://y.qq.com/n/ryqq/songDetail/{smid}" if smid else orig_url,
            "sourcePlatform": "tx",
            "platform": "tx",
            "id": str(smid),
        })

    return {
        "ok": True,
        "platform": "tx",
        "platformName": "QQ 音乐",
        "resourceType": "playlist",
        "resourceTypeLabel": "歌单",
        "id": str(item_id),
        "title": title,
        "curator": curator,
        "coverUrl": cover,
        "sourceUrl": orig_url,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 4: 酷我音乐 (Kuwo, 'kw')
# ========================================================

def _parse_kuwo_js_dict(text: str) -> dict:
    """解析 search.kuwo.cn 返回的伪 JSON / JS 对象字符串"""
    if not text:
        return {}
    clean = text.strip()
    clean = re.sub(r"^var\s+\w+\s*=\s*", "", clean)
    clean = clean.replace("&nbsp;", " ").replace("&#039;", "'")
    # 将无引号或单引号 key/val 转成标准 json 提取
    # 采用安全且精确的字段正则提取
    return {"raw": clean}


def import_kuwo(res_type: str, item_id: str, orig_url: str) -> dict:
    """酷我歌单 / 专辑 / 歌手热门单曲解析"""
    if res_type == "album":
        api_url = f"http://search.kuwo.cn/r.s?pn=0&rn=100&albumid={item_id}&stype=albuminfo&show_copyright_off=1&encoding=utf&vipver=MUSIC_9.1.0"
        st, body, _, _ = net_pool.http_get(api_url, headers={"User-Agent": USER_AGENT}, timeout=8.0)
        if st != 200 or not body:
            raise ValueError(f"请求酷我专辑接口失败 (HTTP {st})")
        text = body.decode("utf-8", errors="ignore").replace("&nbsp;", " ")
        m_name = re.search(r"['\"]name['\"]\s*:\s*['\"]([^'\"]+)['\"]", text)
        m_artist = re.search(r"['\"]artist['\"]\s*:\s*['\"]([^'\"]+)['\"]", text)
        title = m_name.group(1) if m_name else "酷我专辑"
        curator = m_artist.group(1) if m_artist else "未知歌手"

        tracks = []
        # 提取 musiclist 内部所有的单曲区块
        song_blocks = re.findall(r"\{[^{}]*['\"]id['\"]\s*:\s*['\"](\d+)['\"][^{}]*\}", text)
        for idx, block in enumerate(song_blocks[:MAX_IMPORT_TRACKS]):
            m_sname = re.search(r"['\"]name['\"]\s*:\s*['\"]([^'\"]+)['\"]", block)
            m_art = re.search(r"['\"]artist['\"]\s*:\s*['\"]([^'\"]+)['\"]", block)
            m_id = re.search(r"['\"]id['\"]\s*:\s*['\"](\d+)['\"]", block)
            m_dur = re.search(r"['\"]duration['\"]\s*:\s*['\"]?(\d+)['\"]?", block)
            if not m_id:
                continue
            rid = m_id.group(1)
            tracks.append({
                "index": idx + 1,
                "name": html_lib.unescape(m_sname.group(1)) if m_sname else "未知曲目",
                "artist": html_lib.unescape(m_art.group(1)) if m_art else curator,
                "album": title,
                "durationMillis": int(m_dur.group(1) if m_dur else 0) * 1000,
                "url": f"https://www.kuwo.cn/play_detail/{rid}",
                "sourcePlatform": "kw",
                "platform": "kw",
                "id": str(rid),
            })

        return {
            "ok": True,
            "platform": "kw",
            "platformName": "酷我音乐",
            "resourceType": "album",
            "resourceTypeLabel": "专辑",
            "id": str(item_id),
            "title": title,
            "curator": curator,
            "coverUrl": "",
            "sourceUrl": orig_url,
            "total": len(tracks),
            "tracks": tracks,
        }

    if res_type == "artist":
        api_url = f"http://search.kuwo.cn/r.s?pn=0&rn=100&artistid={item_id}&stype=artist2music&sortby=1&show_copyright_off=1&encoding=utf&vipver=MUSIC_9.1.0"
        st, body, _, _ = net_pool.http_get(api_url, headers={"User-Agent": USER_AGENT}, timeout=8.0)
        if st != 200 or not body:
            raise ValueError(f"请求酷我歌手接口失败 (HTTP {st})")
        text = body.decode("utf-8", errors="ignore").replace("&nbsp;", " ")
        m_artist = re.search(r"['\"]artist['\"]\s*:\s*['\"]([^'\"]+)['\"]", text)
        curator = m_artist.group(1) if m_artist else "未知歌手"
        title = f"{curator} - 热门单曲"

        tracks = []
        song_blocks = re.findall(r"\{[^{}]*['\"]MUSICRID['\"]\s*:\s*['\"](?:MUSIC_)?(\d+)['\"][^{}]*\}", text)
        for idx, block in enumerate(song_blocks[:MAX_IMPORT_TRACKS]):
            m_sname = re.search(r"['\"]NAME['\"]\s*:\s*['\"]([^'\"]+)['\"]", block)
            m_art = re.search(r"['\"]ARTIST['\"]\s*:\s*['\"]([^'\"]+)['\"]", block)
            m_alb = re.search(r"['\"]ALBUM['\"]\s*:\s*['\"]([^'\"]+)['\"]", block)
            m_id = re.search(r"['\"]MUSICRID['\"]\s*:\s*['\"](?:MUSIC_)?(\d+)['\"]", block)
            m_dur = re.search(r"['\"]DURATION['\"]\s*:\s*['\"]?(\d+)['\"]?", block)
            if not m_id:
                continue
            rid = m_id.group(1)
            tracks.append({
                "index": idx + 1,
                "name": html_lib.unescape(m_sname.group(1)) if m_sname else "未知曲目",
                "artist": html_lib.unescape(m_art.group(1)) if m_art else curator,
                "album": html_lib.unescape(m_alb.group(1)) if m_alb else title,
                "durationMillis": int(m_dur.group(1) if m_dur else 0) * 1000,
                "url": f"https://www.kuwo.cn/play_detail/{rid}",
                "sourcePlatform": "kw",
                "platform": "kw",
                "id": str(rid),
            })

        return {
            "ok": True,
            "platform": "kw",
            "platformName": "酷我音乐",
            "resourceType": "artist",
            "resourceTypeLabel": "歌手热门单曲",
            "id": str(item_id),
            "title": title,
            "curator": curator,
            "coverUrl": "",
            "sourceUrl": orig_url,
            "total": len(tracks),
            "tracks": tracks,
        }

    # 默认歌单 playlist
    api_url = f"http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid={item_id}&pn=0&rn=1000&encode=utf-8&keyset=pl2012"
    st, body, _, _ = net_pool.http_get(api_url, headers={"User-Agent": USER_AGENT}, timeout=8.0)
    if st != 200 or not body:
        raise ValueError(f"请求酷我歌单接口失败 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore"))
    title = data.get("title") or "酷我歌单"
    curator = data.get("uname") or "酷我用户"
    cover = data.get("pic") or ""
    music_list = data.get("musiclist") or []

    tracks = []
    for idx, s in enumerate(music_list[:MAX_IMPORT_TRACKS]):
        rid = s.get("id") or ""
        dur = int(s.get("duration") or 0) * 1000
        tracks.append({
            "index": idx + 1,
            "name": s.get("name") or "未知曲目",
            "artist": s.get("artist") or "未知歌手",
            "album": s.get("album") or title,
            "durationMillis": dur,
            "url": f"https://www.kuwo.cn/play_detail/{rid}" if rid else orig_url,
            "sourcePlatform": "kw",
            "platform": "kw",
            "id": str(rid),
        })

    return {
        "ok": True,
        "platform": "kw",
        "platformName": "酷我音乐",
        "resourceType": "playlist",
        "resourceTypeLabel": "歌单",
        "id": str(item_id),
        "title": title,
        "curator": curator,
        "coverUrl": cover,
        "sourceUrl": orig_url,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 5: 汽水音乐 (Qishui)
# ========================================================

def import_qishui(final_url: str, html_body: bytes) -> dict:
    """汽水音乐分享页 / H5 提取曲目与歌单"""
    text = html_body.decode("utf-8", errors="ignore") if html_body else ""
    if not text:
        st, body, _, _ = net_pool.http_get(final_url, headers={"User-Agent": MOBILE_UA}, timeout=8.0, secure=True)
        text = body.decode("utf-8", errors="ignore")

    # 提取内置 SSR 状态 JSON
    m = re.search(r'<script id="RENDER_DATA" type="application/json">([^<]+)</script>', text)
    if not m:
        m = re.search(r'<script id="__NEXT_DATA__" type="application/json">([^<]+)</script>', text)

    parsed_json = {}
    if m:
        raw_val = m.group(1).strip()
        try:
            parsed_json = json.loads(urllib.parse.unquote(raw_val))
        except Exception:
            try:
                parsed_json = json.loads(raw_val)
            except Exception:
                pass

    title = "汽水音乐精选"
    curator = "汽水音乐"
    cover = ""
    raw_tracks = []

    # 深度递归查找曲目列表与元数据
    def _search_data(obj):
        nonlocal title, curator, cover, raw_tracks
        if not isinstance(obj, dict):
            return
        if "playlist_title" in obj or "playlistTitle" in obj:
            title = obj.get("playlist_title") or obj.get("playlistTitle") or title
        if "title" in obj and isinstance(obj["title"], str) and not raw_tracks:
            title = obj.get("title") or title
        if "author_name" in obj or "authorName" in obj:
            curator = obj.get("author_name") or obj.get("authorName") or curator
        if "cover" in obj and isinstance(obj["cover"], str) and obj["cover"].startswith("http"):
            cover = obj["cover"]
        if "track_list" in obj and isinstance(obj["track_list"], list):
            raw_tracks = obj["track_list"]
            return
        if "songs" in obj and isinstance(obj["songs"], list):
            raw_tracks = obj["songs"]
            return
        if "song_list" in obj and isinstance(obj["song_list"], list):
            raw_tracks = obj["song_list"]
            return
        for v in obj.values():
            if isinstance(v, dict):
                _search_data(v)
            elif isinstance(v, list) and v and isinstance(v[0], dict) and not raw_tracks:
                for item in v:
                    _search_data(item)

    _search_data(parsed_json)

    tracks = []
    for idx, s in enumerate(raw_tracks[:MAX_IMPORT_TRACKS]):
        sname = s.get("track_name") or s.get("song_name") or s.get("title") or s.get("name") or "未知曲目"
        sart = s.get("artist_name") or s.get("singer_name") or s.get("author") or "未知歌手"
        salb = s.get("album_name") or s.get("album") or title
        sdur = int(s.get("duration") or s.get("duration_ms") or 0)
        if sdur < 1000:
            sdur *= 1000
        tracks.append({
            "index": idx + 1,
            "name": sname,
            "artist": sart,
            "album": salb,
            "durationMillis": sdur,
            "url": final_url,
            "sourcePlatform": "qishui",
        })

    return {
        "ok": True,
        "platform": "qishui",
        "platformName": "汽水音乐",
        "resourceType": "playlist",
        "resourceTypeLabel": "歌单",
        "id": "qishui_imported",
        "title": title,
        "curator": curator,
        "coverUrl": cover,
        "sourceUrl": final_url,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 6: 咪咕音乐 (Migu, 'mg')
# ========================================================

def import_migu(res_type: str, item_id: str, orig_url: str) -> dict:
    """咪咕音乐歌单 / 专辑 / 歌手单曲解析"""
    headers = {"User-Agent": USER_AGENT, "channel": "0146951"}

    if res_type == "album":
        api_url = f"https://app.c.nf.migu.cn/MIGUM3.0/resource/album/song/v2.0?albumId={item_id}&pageNo=1&pageSize=100"
        st, body, _, _ = net_pool.http_get(api_url, headers=headers, timeout=8.0, secure=True)
        if st != 200 or not body:
            raise ValueError(f"请求咪咕专辑接口失败 (HTTP {st})")
        data = json.loads(body.decode("utf-8", errors="ignore")).get("data") or {}
        song_list = data.get("songList") or []
        title = "咪咕专辑"
        curator = "未知歌手"
        cover = ""

        tracks = []
        for idx, s in enumerate(song_list[:MAX_IMPORT_TRACKS]):
            sname = s.get("songName") or "未知曲目"
            singers = [sg.get("name") for sg in s.get("singerList") or [] if sg.get("name")]
            curator = "/".join(singers) if idx == 0 and singers else curator
            salb = s.get("album") or title
            title = salb if idx == 0 and salb else title
            dur = int(s.get("duration") or 0) * 1000
            tracks.append({
                "index": idx + 1,
                "name": sname,
                "artist": "/".join(singers) or curator,
                "album": salb,
                "durationMillis": dur,
                "url": orig_url,
                "sourcePlatform": "mg",
            })

        return {
            "ok": True,
            "platform": "mg",
            "platformName": "咪咕音乐",
            "resourceType": "album",
            "resourceTypeLabel": "专辑",
            "id": str(item_id),
            "title": title,
            "curator": curator,
            "coverUrl": cover,
            "sourceUrl": orig_url,
            "total": len(tracks),
            "tracks": tracks,
        }

    # 默认歌单 playlist
    meta_url = f"https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId={item_id}"
    st, mbody, _, _ = net_pool.http_get(meta_url, headers=headers, timeout=8.0, secure=True)
    title = "咪咕歌单"
    curator = "咪咕用户"
    cover = ""
    if st == 200 and mbody:
        try:
            mdata = json.loads(mbody.decode("utf-8", errors="ignore")).get("data") or {}
            title = mdata.get("title") or title
            curator = mdata.get("userName") or curator
            cover = mdata.get("img1") or mdata.get("img2") or ""
        except Exception:
            pass

    api_url = f"https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?playlistId={item_id}&pageNo=1&pageSize=100"
    st, body, _, _ = net_pool.http_get(api_url, headers=headers, timeout=8.0, secure=True)
    if st != 200 or not body:
        raise ValueError(f"请求咪咕歌单曲目接口失败 (HTTP {st})")
    data = json.loads(body.decode("utf-8", errors="ignore")).get("data") or {}
    song_list = data.get("songList") or []

    tracks = []
    for idx, s in enumerate(song_list[:MAX_IMPORT_TRACKS]):
        sname = s.get("songName") or "未知曲目"
        singers = [sg.get("name") for sg in s.get("singerList") or [] if sg.get("name")]
        dur = int(s.get("duration") or 0) * 1000
        tracks.append({
            "index": idx + 1,
            "name": sname,
            "artist": "/".join(singers) or "未知歌手",
            "album": s.get("album") or title,
            "durationMillis": dur,
            "url": orig_url,
            "sourcePlatform": "mg",
        })

    return {
        "ok": True,
        "platform": "mg",
        "platformName": "咪咕音乐",
        "resourceType": "playlist",
        "resourceTypeLabel": "歌单",
        "id": str(item_id),
        "title": title,
        "curator": curator,
        "coverUrl": cover,
        "sourceUrl": orig_url,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 7: 酷狗音乐 / 酷狗概念版 (Kugou, 'kg')
# ========================================================

def import_kugou(res_type: str, item_id: str, orig_url: str) -> dict:
    """酷狗歌单 / 专辑 / 歌手单曲解析 (带官限 10 首提示)"""
    import hashlib

    notice = ""
    tracks = []
    title = "酷狗精选"
    curator = "酷狗音乐"
    cover = ""

    if res_type == "album":
        api_url = f"http://mobilecdnbj.kugou.com/api/v3/album/song?albumid={item_id}&page=1&pagesize=100"
        st, body, _, _ = net_pool.http_get(api_url, headers={"User-Agent": USER_AGENT}, timeout=8.0)
        if st != 200 or not body:
            raise ValueError(f"请求酷狗专辑接口失败 (HTTP {st})")
        data = json.loads(body.decode("utf-8", errors="ignore")).get("data") or {}
        info_list = data.get("info") or []
        for idx, item in enumerate(info_list[:MAX_IMPORT_TRACKS]):
            filename = item.get("filename") or ""
            parts = filename.split(" - ", 1)
            artist = parts[0].strip() if len(parts) > 1 else "未知歌手"
            song_name = parts[1].strip() if len(parts) > 1 else filename
            dur = int(item.get("duration") or 0) * 1000
            tracks.append({
                "index": idx + 1,
                "name": song_name,
                "artist": artist,
                "album": title,
                "durationMillis": dur,
                "url": orig_url,
                "sourcePlatform": "kg",
            })
    elif res_type == "artist":
        api_url = f"http://mobilecdnbj.kugou.com/api/v3/singer/song?singerid={item_id}&page=1&pagesize=100"
        st, body, _, _ = net_pool.http_get(api_url, headers={"User-Agent": USER_AGENT}, timeout=8.0)
        if st != 200 or not body:
            raise ValueError(f"请求酷狗歌手接口失败 (HTTP {st})")
        data = json.loads(body.decode("utf-8", errors="ignore")).get("data") or {}
        info_list = data.get("info") or []
        for idx, item in enumerate(info_list[:MAX_IMPORT_TRACKS]):
            filename = item.get("filename") or ""
            parts = filename.split(" - ", 1)
            artist = parts[0].strip() if len(parts) > 1 else "未知歌手"
            song_name = parts[1].strip() if len(parts) > 1 else filename
            dur = int(item.get("duration") or 0) * 1000
            tracks.append({
                "index": idx + 1,
                "name": song_name,
                "artist": artist,
                "album": title,
                "durationMillis": dur,
                "url": orig_url,
                "sourcePlatform": "kg",
            })
    else:
        # 歌单 / 概念版 special
        api_url = (
            f"http://gatewayretry.kugou.com/v2/get_other_list_file?"
            f"specialid={item_id}&need_sort=1&module=CloudMusic&clientver=11239&"
            f"pagesize=100&specalidpgc={item_id}&userid=0&page=1&type=0&area_code=1&appid=1005"
        )
        query_string = api_url.split("?", 1)[1]
        sorted_params = "".join(sorted(query_string.split("&")))
        raw_string = "OIlwieks28dk2k092lksi2UIkp" + sorted_params + "OIlwieks28dk2k092lksi2UIkp"
        sig = hashlib.md5(raw_string.encode("utf-8")).hexdigest()
        final_url = f"{api_url}&signature={sig}"
        headers = {
            "User-Agent": "Android9-AndroidPhone-11239-18-0-playlist-wifi",
            "x-router": "pubsongscdn.kugou.com",
            "mid": "239526275778893399526700786998289824956",
            "clienttime": str(int(time.time())),
        }
        st, body, _, _ = net_pool.http_get(final_url, headers=headers, timeout=8.0)
        if st == 200 and body:
            data = json.loads(body.decode("utf-8", errors="ignore")).get("data") or {}
            title = data.get("specialname") or title
            curator = data.get("nickname") or curator
            info_list = data.get("info") or []
            for idx, item in enumerate(info_list[:MAX_IMPORT_TRACKS]):
                raw_name = item.get("filename") or item.get("name") or ""
                parts = raw_name.split(" - ", 1)
                artist = parts[0].strip() if len(parts) > 1 else "未知歌手"
                song_name = parts[1].strip() if len(parts) > 1 else raw_name
                dur = int(item.get("duration") or 0) * 1000
                tracks.append({
                    "index": idx + 1,
                    "name": song_name,
                    "artist": artist,
                    "album": title,
                    "durationMillis": dur,
                    "url": orig_url,
                    "sourcePlatform": "kg",
                })

        if len(tracks) <= 10 and len(tracks) > 0:
            notice = "酷狗普通分享受官限仅展示前 10 首，建议使用酷狗概念版或专辑链接"

    return {
        "ok": True,
        "platform": "kg",
        "platformName": "酷狗音乐",
        "resourceType": res_type,
        "resourceTypeLabel": "专辑" if res_type == "album" else ("歌手热门单曲" if res_type == "artist" else "歌单"),
        "id": str(item_id),
        "title": title,
        "curator": curator,
        "coverUrl": cover,
        "sourceUrl": orig_url,
        "notice": notice,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 8: 海外平台 Spotify (免 OAuth 提取前 100 首)
# ========================================================

def import_spotify(res_type: str, item_id: str, orig_url: str) -> dict:
    """Spotify 免 OAuth 抓取公开歌单 / 专辑 / 歌手 (上限 100 首)"""
    embed_url = f"https://open.spotify.com/embed/{res_type}/{item_id}"
    st, body, _, _ = net_pool.http_get(
        embed_url,
        headers={"User-Agent": USER_AGENT},
        timeout=10.0,
        secure=True,
    )
    if st != 200 or not body:
        raise ValueError(f"请求 Spotify Embed 页面失败 (HTTP {st})")
    html_text = body.decode("utf-8", errors="ignore")
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">([^<]+)</script>', html_text)
    if not m:
        raise ValueError("无法提取 Spotify 页面结构数据")

    data = json.loads(m.group(1))
    entity = data.get("props", {}).get("pageProps", {}).get("state", {}).get("data", {}).get("entity", {})
    title = entity.get("title") or entity.get("name") or "Spotify Playlist"
    curator = entity.get("subtitle") or "Spotify"
    track_list = entity.get("trackList") or []

    tracks = []
    for idx, t in enumerate(track_list[:100]):
        tracks.append({
            "index": idx + 1,
            "name": t.get("title") or "Unknown Track",
            "artist": t.get("subtitle") or curator,
            "album": title,
            "durationMillis": int(t.get("duration") or 0),
            "url": f"https://open.spotify.com/track/{t.get('id')}" if t.get("id") else orig_url,
            "sourcePlatform": "spotify",
        })

    return {
        "ok": True,
        "platform": "spotify",
        "platformName": "Spotify",
        "resourceType": res_type,
        "resourceTypeLabel": "专辑" if res_type == "album" else ("歌手热门单曲" if res_type == "artist" else "歌单"),
        "id": str(item_id),
        "title": title,
        "curator": curator,
        "coverUrl": "",
        "sourceUrl": orig_url,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 9: 街声 (StreetVoice)
# ========================================================

def import_streetvoice(res_type: str, item_id: str, orig_url: str) -> dict:
    """街声精选歌单解析 (复用 streetvoice_catalog.py)"""
    res = fetch_sv_playlist_songs(item_id)
    raw_tracks = res.get("tracks") or []
    title = f"街声歌单 #{item_id}"
    curator = "StreetVoice"

    tracks = []
    for idx, t in enumerate(raw_tracks[:MAX_IMPORT_TRACKS]):
        tracks.append({
            "index": idx + 1,
            "name": t.get("name") or "未知曲目",
            "artist": t.get("artist") or curator,
            "album": t.get("album") or title,
            "durationMillis": t.get("durationMillis") or 0,
            "url": t.get("url") or orig_url,
            "sourcePlatform": "streetvoice",
            "platform": "streetvoice",
            "id": str(t.get("id") or ""),
        })

    return {
        "ok": True,
        "platform": "streetvoice",
        "platformName": "街声 StreetVoice",
        "resourceType": "playlist",
        "resourceTypeLabel": "歌单",
        "id": str(item_id),
        "title": title,
        "curator": curator,
        "coverUrl": "",
        "sourceUrl": orig_url,
        "total": len(tracks),
        "tracks": tracks,
    }


# ========================================================
# 区块 10: 统一导入调度中枢 (import_external_resource)
# ========================================================

def import_external_resource(input_text: str) -> dict:
    """
    全平台统一解析入口：
    支持中文分享文案、多跳重定向短链、官方长链接及平台短前缀
    """
    raw = (input_text or "").strip()
    if not raw:
        raise ValueError("输入内容为空")

    # 1. 优先检测平台短前缀 (如 wy:12345, qq:playlist:12345, kw:album:12345)
    prefix_match = re.match(r"^(wy|qq|tx|kw|kg|mg):(?:(playlist|album|artist):)?([a-zA-Z0-9_-]+)$", raw, re.I)
    if prefix_match:
        plat = prefix_match.group(1).lower()
        if plat == "qq":
            plat = "tx"
        rtype = (prefix_match.group(2) or "playlist").lower()
        item_id = prefix_match.group(3)

        if plat == "wy":
            return import_netease(rtype, item_id, raw)
        if plat == "tx":
            return import_qq(rtype, item_id, raw)
        if plat == "kw":
            return import_kuwo(rtype, item_id, raw)
        if plat == "kg":
            return import_kugou(rtype, item_id, raw)
        if plat == "mg":
            return import_migu(rtype, item_id, raw)

    # 2. 微信小程序分享口令与链接拦截与智能还原 (#小程序:// 或 wxaurl.cn)
    if "#小程序://" in raw or "wxaurl.cn" in raw or raw.startswith("小程序://"):
        # 尝试提取文本中携带的明文 ID 参数 (如 id=123456, disstid=123456, playlistId=123456)
        m_id = re.search(r"(?:[?&]|^|\b)(?:id|disstid|playlistId|pid|mid|tid)=(\d+)", raw)
        if m_id:
            pid = m_id.group(1)
            if "qq" in raw.lower() or "腾讯" in raw:
                return import_qq("playlist", pid, raw)
            return import_netease("playlist", pid, raw)

        # 微信闭环加密 Token (#小程序://网易云音乐/AbCdEf...)
        raise ValueError(
            "微信小程序生成的「#小程序://」为微信专属闭环加密口令，未暴露歌单真实 ID。"
            "请在对应音乐 App 内点击「分享」并选择「复制链接」（或在微信页面中选择“在浏览器中打开”），粘贴生成的公开网页链接即可秒级导入！"
        )

    # 3. 从文案中提取 URL
    target_url = extract_url_from_text(raw)
    if not target_url:
        # 若未提取到 http 链接但文本明确包含平台关键词与 ID (如 '网易云歌单 24381616' 或 'QQ歌单 8378904797')
        m_id = re.search(r"(?:id=|\b)(\d{6,12})\b", raw)
        if m_id:
            pid = m_id.group(1)
            if "qq" in raw.lower() or "腾讯" in raw:
                return import_qq("playlist", pid, raw)
            if "网易" in raw or "163" in raw:
                return import_netease("playlist", pid, raw)
        raise ValueError("未能识别出有效的音乐平台链接或分享口令")

    # 4. 逐跳安全追踪重定向 (拦截 SSRF)
    final_url, final_body, _ = resolve_safe_redirects(target_url)

    # 4. 根据 final_url 域名与路径分流
    parsed = urllib.parse.urlparse(final_url)
    host = (parsed.hostname or "").lower()
    path = parsed.path
    qs = urllib.parse.parse_qs(parsed.query)

    # A. 网易云音乐
    if "163.com" in host or "163cn.tv" in host:
        m_id = qs.get("id", [""])[0]
        if not m_id:
            m_path = re.search(r"/(playlist|album|artist)/(\d+)", path)
            if m_path:
                return import_netease(m_path.group(1), m_path.group(2), final_url)
        rtype = "playlist"
        if "album" in path:
            rtype = "album"
        elif "artist" in path:
            rtype = "artist"
        if m_id:
            return import_netease(rtype, m_id, final_url)
        raise ValueError("未能从网易云链接中解析出有效的资源 ID")

    # B. QQ 音乐
    if "qq.com" in host:
        # 歌单
        m_pl = re.search(r"/(?:playlist|diss)/(\d+)", path) or qs.get("id") or qs.get("disstid")
        if m_pl:
            pid = m_pl.group(1) if hasattr(m_pl, "group") else m_pl[0]
            return import_qq("playlist", pid, final_url)
        # 专辑
        m_al = re.search(r"/(?:albumDetail|album)/([a-zA-Z0-9]+)", path) or qs.get("albumMid")
        if m_al:
            amid = m_al.group(1) if hasattr(m_al, "group") else m_al[0]
            return import_qq("album", amid, final_url)
        # 歌手
        m_ar = re.search(r"/(?:singer|singerDetail)/([a-zA-Z0-9]+)", path) or qs.get("singerMid")
        if m_ar:
            smid = m_ar.group(1) if hasattr(m_ar, "group") else m_ar[0]
            return import_qq("artist", smid, final_url)
        raise ValueError("未能从 QQ 音乐链接中解析出有效的歌单/专辑/歌手 ID")

    # C. 酷我音乐
    if "kuwo.cn" in host:
        m_pl = re.search(r"/playlist(?:_detail)?/(\d+)", path) or qs.get("pid")
        if m_pl:
            pid = m_pl.group(1) if hasattr(m_pl, "group") else m_pl[0]
            return import_kuwo("playlist", pid, final_url)
        m_al = re.search(r"/album(?:_detail)?/(\d+)", path) or qs.get("albumId")
        if m_al:
            aid = m_al.group(1) if hasattr(m_al, "group") else m_al[0]
            return import_kuwo("album", aid, final_url)
        m_ar = re.search(r"/singer(?:_detail)?/(\d+)", path) or qs.get("artistId")
        if m_ar:
            arid = m_ar.group(1) if hasattr(m_ar, "group") else m_ar[0]
            return import_kuwo("artist", arid, final_url)
        raise ValueError("未能从酷我链接中解析出有效的歌单/专辑/歌手 ID")

    # D. 汽水音乐
    if "qishui.douyin.com" in host or "douyin.com" in host:
        return import_qishui(final_url, final_body)

    # E. 咪咕音乐
    if "migu.cn" in host:
        m_pl = re.search(r"/playlist/(\d+)", path) or qs.get("playlistId")
        if m_pl:
            pid = m_pl.group(1) if hasattr(m_pl, "group") else m_pl[0]
            return import_migu("playlist", pid, final_url)
        m_al = re.search(r"/album/(\d+)", path) or qs.get("albumId")
        if m_al:
            aid = m_al.group(1) if hasattr(m_al, "group") else m_al[0]
            return import_migu("album", aid, final_url)
        raise ValueError("未能从咪咕链接中解析出有效的歌单或专辑 ID")

    # F. 酷狗音乐 / 酷狗概念版
    if "kugou.com" in host:
        m_sp = re.search(r"/special/(?:single/)?(\d+)", path) or qs.get("specialid")
        if m_sp:
            pid = m_sp.group(1) if hasattr(m_sp, "group") else m_sp[0]
            return import_kugou("playlist", pid, final_url)
        m_al = re.search(r"/album/(?:single/)?(\d+)", path) or qs.get("albumid") or qs.get("album_id")
        if m_al:
            aid = m_al.group(1) if hasattr(m_al, "group") else m_al[0]
            return import_kugou("album", aid, final_url)
        m_ar = re.search(r"/singer/(?:home/)?(\d+)", path) or qs.get("singerid")
        if m_ar:
            arid = m_ar.group(1) if hasattr(m_ar, "group") else m_ar[0]
            return import_kugou("artist", arid, final_url)
        # 若为概念版活动/H5页，尝试从 HTML 或查询参数提取 specialid
        m_txt_id = re.search(r"(?:specialid|chain_id|id)=(\d+)", final_url)
        if m_txt_id:
            return import_kugou("playlist", m_txt_id.group(1), final_url)
        raise ValueError("未能从酷狗链接中提取有效的歌单或专辑 ID")

    # G. Spotify
    if "spotify.com" in host or "spotify.link" in host:
        m_sp = re.search(r"/(playlist|album|artist)/([a-zA-Z0-9]+)", path)
        if m_sp:
            return import_spotify(m_sp.group(1), m_sp.group(2), final_url)
        raise ValueError("未能从 Spotify 链接中提取有效的歌单/专辑/歌手 ID")

    # H. 街声 StreetVoice
    if "streetvoice.cn" in host or "streetvoice.com" in host:
        m_sv = re.search(r"/playlists/(\d+)", path)
        if m_sv:
            return import_streetvoice("playlist", m_sv.group(1), final_url)
        raise ValueError("未能从街声链接中提取有效的歌单 ID")

    raise ValueError(f"暂不支持解析该平台链接 ({host})")
