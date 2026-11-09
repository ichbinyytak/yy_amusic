#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
========================================================
模块：source_manager.py - 纯 Python 原生高性能音源中枢
命名空间：source_hub (SourceManager 单例)
依赖协同：net_pool.py, song_search.py, server.py
--------------------------------------------------------
核心原则：
  1. 纯 Python 原生通道：0 Node.js 运行时依赖，0 外部进程 fork/exec，0ms 冷启动
  2. 严格执行“零试听”与“防串曲”：
     - 严格过滤 < 1.2MB 的试听截断残卷
     - 拦截 81KB/181KB 假语音/下架提示音
     - 对 Chunked/无大小音频首包嗅探音频文件魔数
  3. 单一事实来源 (Single Source of Truth)：
     - 音源平台与探针能力严格由代码定义，排班 JSON 仅记录观测延迟与健康状态
  4. 动态自适应奖惩模型：
     - 胜者毫秒级记录与 EMA 平滑提速，失败避让，宕机自动降级
========================================================
"""

import os
import sys
import time
import json
import socket
import threading
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from net_pool import http_get, verify_audio_stream, MIN_VALID_BYTES, FAKE_AUDIO_LENGTHS

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

# 标准测速基准曲目（按平台严格对齐歌曲ID与元数据，杜绝跨平台ID错配）
TEST_TRACKS = {
    "kw": {"id": "5886682", "songmid": "5886682", "title": "海阔天空", "artist": "Beyond"},
    "wy": {"id": "347230", "songmid": "347230", "title": "海阔天空", "artist": "Beyond"},
    "tx": {"id": "002WkUkN2L0dqm", "songmid": "002WkUkN2L0dqm", "title": "海阔天空", "artist": "Beyond"},
    "kg": {"id": "596E403326AFD24A38E95A5225E1A139", "songmid": "596E403326AFD24A38E95A5225E1A139", "title": "海阔天空", "artist": "Beyond"},
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RANKING_FILE = os.path.join(BASE_DIR, "sources_ranking.json")


def verify_audio_url(url: str, timeout: float = 2.0) -> tuple:
    """轻量秒级校验音频有效性（基于连接池 Keep-Alive 极速嗅探）"""
    return verify_audio_stream(url, timeout=timeout)


def _extract_id(song_info):
    if isinstance(song_info, dict):
        return str(song_info.get("id") or song_info.get("songmid") or "")
    return str(song_info or "")


# ========================================================
# 原生纯 Python 音源探针定义 (0 进程开销，毫秒级响应)
# ========================================================

def _probe_kw_haitang(song_info, target_platform="kw", timeout: float = 2.0):
    """酷我海棠 SVIP 穿透通道 (输出官方 320k 完整音频)"""
    song_id = _extract_id(song_info)
    if not song_id or not song_id.isdigit():
        return None
    url = f"https://musicapi.haitangw.net/music/kw.php?type=mp3&id={song_id}&level=standard"
    ok, sz, purl = verify_audio_url(url, timeout=timeout)
    if ok and 'haitangw.net' not in purl:
        return {"url": purl, "bytes": sz, "source": "海棠SVIP穿透通道"}
    return None


def _probe_kw_nxinxz(song_info, target_platform="kw", timeout: float = 2.0):
    """酷我念心车机穿透通道"""
    song_id = _extract_id(song_info)
    if not song_id or not song_id.isdigit():
        return None
    url = f"http://music.nxinxz.com/kw.php?id={song_id}&level=standard&type=mp3"
    ok, sz, purl = verify_audio_url(url, timeout=timeout)
    if ok and 'music.nxinxz.com' not in purl:
        return {"url": purl, "bytes": sz, "source": "念心车机穿透通道"}
    return None


def _probe_wy_oiapi(song_info, target_platform="wy", timeout: float = 2.0):
    """网易云极速原生直通通道 (输出 320k 官方无损直出)"""
    song_id = _extract_id(song_info)
    if not song_id or not song_id.isdigit():
        return None
    url = f"https://oiapi.net/api/Music_163?id={song_id}"
    st, data_bytes, _, _ = http_get(url, timeout=timeout)
    if st == 200 and data_bytes:
        try:
            data = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            items = data.get("data", [])
            if items and isinstance(items, list):
                audio_url = items[0].get("url")
                if audio_url and audio_url.startswith("http"):
                    ok, sz, purl = verify_audio_url(audio_url, timeout=1.5)
                    if ok:
                        return {"url": purl, "bytes": sz, "source": "网易云官方极速通道"}
        except Exception:
            pass
    return None


def _probe_kw_yaohu(song_info, target_platform="kw", timeout: float = 2.0):
    """妖狐酷我直通通道 (带严格歌名歌手一致性防线，杜绝翻唱/串曲)"""
    title = song_info.get("title", "") if isinstance(song_info, dict) else ""
    artist = song_info.get("artist", "") if isinstance(song_info, dict) else ""
    q = f"{title} {artist}".strip()
    if not q:
        sid = _extract_id(song_info)
        q = sid
    if not q or not title:
        return None
    import urllib.parse
    url = f"https://api.yaohud.cn/api/music/kuwo?key=nvgKtvzw7CFSNFrDhA6&action=search&msg={urllib.parse.quote(q)}&n=1"
    st, data_bytes, _, _ = http_get(url, timeout=timeout)
    if st == 200 and data_bytes:
        try:
            data = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            m_data = data.get("data", {})
            ret_name = m_data.get("name", "")
            ret_artist = m_data.get("songname", "")
            # 严格防串曲门禁：检查歌名与歌手是否匹配
            from song_search import calculate_song_match_score
            score, ok = calculate_song_match_score(
                ret_name, ret_artist, m_data.get("album", ""),
                target_title=title, target_artist=artist
            )
            if not ok:
                return None  # 判定为翻唱/不同曲目，一票否决
            vm = m_data.get("vipmusic", {})
            audio_url = vm.get("url", "")
            if audio_url and audio_url.startswith("http"):
                ok, sz, purl = verify_audio_url(audio_url, timeout=1.5)
                if ok:
                    return {"url": purl, "bytes": sz, "source": "妖狐酷我直通通道"}
        except Exception:
            pass
    return None


def _probe_kg_official(song_info, target_platform="kg", timeout: float = 2.0):
    """酷狗官方直通通道 (sharefs 官方 128k/320k 完整音频，TME 独立备用)"""
    fhash = _extract_id(song_info)
    if not fhash or len(fhash) < 16:
        return None
    url = f"https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash={fhash}"
    st, data_bytes, _, _ = http_get(url, headers={'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)'}, timeout=timeout)
    if st == 200 and data_bytes:
        try:
            data = json.loads(data_bytes.decode('utf-8', errors='ignore'))
            audio_url = data.get("url")
            if audio_url and audio_url.startswith("http"):
                ok, sz, purl = verify_audio_url(audio_url, timeout=1.8)
                if ok:
                    return {"url": purl, "bytes": sz, "source": "酷狗官方直通通道"}
        except Exception:
            pass
    return None


# ========================================================
# AudioSource 实体与排班模型
# ========================================================

class AudioSource:
    """音源模型实体：保持代码定义的单一事实来源，动态更新健康指标"""
    def __init__(self, source_id, name, platforms, probe_func, test_track_id):
        self.id = source_id
        self.name = name
        self.platforms = [platforms] if isinstance(platforms, str) else list(platforms)
        self.platform = self.platforms[0] if self.platforms else "kw"
        self.probe_func = probe_func
        self.test_track_id = test_track_id

        # 状态与动态统计
        self.latency_ms = 9999.0
        self.status = "untested"
        self.success_count = 0
        self.fail_count = 0
        self.consecutive_fails = 0
        self.platform_latencies = {}
        self.platform_status = {}
        self.platform_fails = {}
        self.platform_successes = {}

    def test_health(self) -> dict:
        """执行本地真实探活打测"""
        best_plat = self.platforms[0]
        best_ms = 9999.0
        overall_ok = False

        for plat in self.platforms:
            track_info = TEST_TRACKS.get(plat, TEST_TRACKS.get("kw"))
            t0 = time.perf_counter()
            try:
                res = self.probe_func(track_info, plat, timeout=3.0)
                ms = round((time.perf_counter() - t0) * 1000, 1)
                if res and res.get('url'):
                    self.platform_latencies[plat] = ms
                    self.platform_status[plat] = "ok"
                    self.platform_fails[plat] = 0
                    overall_ok = True
                    if ms < best_ms:
                        best_ms = ms
                        best_plat = plat
                else:
                    self.platform_latencies[plat] = 9999.0
                    self.platform_status[plat] = "failed"
                    self.platform_fails[plat] = self.platform_fails.get(plat, 0) + 1
            except Exception:
                self.platform_latencies[plat] = 9999.0
                self.platform_status[plat] = "failed"
                self.platform_fails[plat] = self.platform_fails.get(plat, 0) + 1

        if overall_ok:
            self.status = "ok"
            self.platform = best_plat
            self.latency_ms = best_ms
            self.consecutive_fails = 0
        else:
            self.status = "failed"
            self.latency_ms = 9999.0
            self.consecutive_fails += 1

        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "latency_ms": self.latency_ms,
            "platform_latencies": self.platform_latencies,
            "platform_status": self.platform_status
        }

    def record_hit(self, platform: str = None, cost_ms: float = None):
        """成功取歌出声：实战奖励与动态平滑提速"""
        self.success_count += 1
        self.consecutive_fails = 0
        if platform:
            self.platform_fails[platform] = 0
            self.platform_successes[platform] = self.platform_successes.get(platform, 0) + 1
        if cost_ms and cost_ms > 0:
            self.latency_ms = round(self.latency_ms * 0.7 + cost_ms * 0.3, 1)
            if platform and platform in self.platform_latencies:
                self.platform_latencies[platform] = round(self.platform_latencies[platform] * 0.7 + cost_ms * 0.3, 1)

    def record_miss(self, platform: str = None):
        """找不到歌 / 报错：实战温和避让"""
        self.fail_count += 1
        self.consecutive_fails = min(5, self.consecutive_fails + 1)
        if platform:
            self.platform_fails[platform] = min(5, self.platform_fails.get(platform, 0) + 1)

    def get_sort_weight(self, platform: str = None) -> float:
        """计算排序综合权重（越小越优先）"""
        if platform:
            if platform not in self.platforms:
                return 999999.0

            p_fails = self.platform_fails.get(platform, 0)
            if platform not in self.platform_latencies:
                p_lat = 1000.0
                p_status = "ok"
            else:
                p_lat = self.platform_latencies[platform]
                p_status = self.platform_status.get(platform, "ok")

            if p_status == "failed" or p_lat >= 9000.0:
                return 80000.0 + min(5000.0, p_fails * 500.0)

            penalty = min(2000.0, p_fails * 400.0)
            p_succ = self.platform_successes.get(platform, 0)
            bonus = min(2500.0, p_succ * 500.0) + min(300.0, self.success_count * 20.0)
            return max(1.0, p_lat + penalty - bonus)

        if self.status == "failed" or self.latency_ms >= 9000.0:
            return 80000.0 + min(5000.0, self.consecutive_fails * 500.0)
        penalty = min(2000.0, self.consecutive_fails * 300.0)
        bonus = min(300.0, self.success_count * 25.0)
        return max(1.0, self.latency_ms + penalty - bonus)


# ========================================================
# SourceManager 核心调度中枢 (纯 Python 原生)
# ========================================================

class SourceManager:
    """音源调度总管：纯 Python 原生并发竞速调度"""
    def __init__(self):
        self.sources = {}
        self.tested_at = None
        self._test_lock = threading.Lock()
        self._is_testing = False
        self._init_builtin_sources()

    def _init_builtin_sources(self):
        """初始化全部原生音源通道，严格限定所属平台单一事实来源"""
        s_haitang = AudioSource("kw_haitang", "海棠SVIP穿透源 (酷我)", ["kw"], _probe_kw_haitang, "5886682")
        s_haitang.status = "ok"
        s_haitang.latency_ms = 430.0
        s_haitang.platform_latencies = {"kw": 430.0}
        s_haitang.platform_status = {"kw": "ok"}
        s_haitang.success_count = 30
        self.register(s_haitang)

        s_nxinxz = AudioSource("kw_nxinxz", "念心车机穿透源 (酷我)", ["kw"], _probe_kw_nxinxz, "5886682")
        s_nxinxz.status = "ok"
        s_nxinxz.latency_ms = 680.0
        s_nxinxz.platform_latencies = {"kw": 680.0}
        s_nxinxz.platform_status = {"kw": "ok"}
        s_nxinxz.success_count = 15
        self.register(s_nxinxz)

        s_wy_oi = AudioSource("wy_oiapi", "网易云极速源 (网易)", ["wy"], _probe_wy_oiapi, "347230")
        s_wy_oi.status = "ok"
        s_wy_oi.latency_ms = 350.0
        s_wy_oi.platform_latencies = {"wy": 350.0}
        s_wy_oi.platform_status = {"wy": "ok"}
        s_wy_oi.success_count = 25
        self.register(s_wy_oi)

        s_yaohu = AudioSource("kw_yaohu", "妖狐直通源 (酷我)", ["kw"], _probe_kw_yaohu, "5886682")
        s_yaohu.status = "ok"
        s_yaohu.latency_ms = 1100.0
        s_yaohu.platform_latencies = {"kw": 1100.0}
        s_yaohu.platform_status = {"kw": "ok"}
        s_yaohu.success_count = 5
        self.register(s_yaohu)

        s_kg = AudioSource("kg_official", "酷狗官方直通源 (酷狗)", ["kg"], _probe_kg_official, "596E403326AFD24A38E95A5225E1A139")
        s_kg.status = "ok"
        s_kg.latency_ms = 450.0
        s_kg.platform_latencies = {"kg": 450.0}
        s_kg.platform_status = {"kg": "ok"}
        s_kg.success_count = 20
        self.register(s_kg)

        # 载入持久化测速指标
        self.load_local_cached_sources()

    def load_local_cached_sources(self):
        """纯本地极速载入 sources_ranking.json 的实测延迟指标（严禁覆盖代码中的平台定义）"""
        if not os.path.exists(RANKING_FILE):
            return
        try:
            with open(RANKING_FILE, "r", encoding="utf-8") as f:
                data = json.loads(f.read())
            self.tested_at = data.get("testedAt") or data.get("generatedAt")
            for s_info in data.get("sources", []):
                sid = s_info.get("id")
                if sid in self.sources:
                    src = self.sources[sid]
                    if s_info.get("latency_ms") is not None:
                        src.latency_ms = float(s_info["latency_ms"])
                    if s_info.get("status"):
                        src.status = s_info["status"]
                    if s_info.get("consecutive_fails") is not None:
                        src.consecutive_fails = int(s_info["consecutive_fails"])
                    if s_info.get("success_count") is not None:
                        src.success_count = int(s_info["success_count"])
                    if s_info.get("platform_latencies"):
                        src.platform_latencies.update(s_info["platform_latencies"])
                    if s_info.get("platform_status"):
                        src.platform_status.update(s_info["platform_status"])
        except Exception:
            pass

    def register(self, source: AudioSource):
        self.sources[source.id] = source

    def get_ordered_sources(self, platform: str = None) -> list:
        """获取按综合健康度从优到劣排序的音源队列"""
        cands = list(self.sources.values())
        if platform:
            cands = [s for s in cands if platform in s.platforms]
            cands.sort(key=lambda s: s.get_sort_weight(platform=platform))
        else:
            cands.sort(key=lambda s: s.get_sort_weight())
        return cands

    def test_all(self) -> list:
        """并发就地测试所有音源，按实测延迟与健康度重新排序"""
        with self._test_lock:
            if self._is_testing:
                return [{
                    "id": s.id, "name": s.name, "platform": s.platform,
                    "platforms": s.platforms, "status": s.status,
                    "latency_ms": s.latency_ms,
                    "consecutive_fails": s.consecutive_fails,
                    "success_count": s.success_count
                } for s in self.get_ordered_sources()]
            self._is_testing = True

        try:
            tasks = []
            with ThreadPoolExecutor(max_workers=min(6, len(self.sources))) as executor:
                for s in self.sources.values():
                    tasks.append(executor.submit(s.test_health))
                for f in as_completed(tasks):
                    try:
                        f.result()
                    except Exception:
                        pass
            self.tested_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        finally:
            self._is_testing = False

        ordered = self.get_ordered_sources()
        return [{
            "id": s.id,
            "name": s.name,
            "platform": s.platform,
            "platforms": s.platforms,
            "status": s.status,
            "latency_ms": s.latency_ms,
            "consecutive_fails": s.consecutive_fails,
            "success_count": s.success_count
        } for s in ordered]

    def resolve_best_stream(self, cand_song: dict, timeout_budget: float = None) -> dict:
        """
        纯 Python 零进程超轻量并发冲刺调度：
        1. 针对目标平台精准派出支持该平台的音源，严禁跨平台乱投 ID；
        2. 派出前 2~4 个最优原生源并发冲刺，任一源返回有效全曲（> 1.2MB 且通过音频魔数嗅探）即刻短路秒开出声；
        3. 彻底消除 Node.js 子进程启动开销，0ms 冷启动，极速出声。
        """
        target_plat = cand_song.get("platform", "kw")
        song_id = cand_song.get("id", "")
        if not song_id:
            return {"error": "缺少歌曲内部有效 ID"}

        # 精确派出支持目标平台的音源
        batch = self.get_ordered_sources(platform=target_plat)[:4]
        if not batch:
            # 兼容具备聚合能力的源
            batch = [s for s in self.get_ordered_sources() if target_plat in s.platforms][:4]

        if not batch:
            return {"success": False, "error": f"暂无支持 {target_plat} 平台的原生音源"}

        rounds_log = []
        round_t0 = time.perf_counter()
        names = [s.name for s in batch]
        r_log = {
            "round": 1,
            "sources": names,
            "winner": None,
            "status": "miss"
        }

        single_probe_timeout = 2.5
        round_timeout = 3.2
        if timeout_budget is not None:
            if timeout_budget < 0.6:
                return {"success": False, "error": "时间预算耗尽"}
            round_timeout = min(round_timeout, timeout_budget)
            single_probe_timeout = min(2.5, max(0.5, round_timeout - 0.3))

        exec_pool = ThreadPoolExecutor(max_workers=len(batch))
        try:
            future_map = {
                exec_pool.submit(s.probe_func, cand_song, target_plat, single_probe_timeout): s
                for s in batch
            }
            for f in as_completed(future_map, timeout=round_timeout):
                src = future_map[f]
                try:
                    res = f.result()
                    if res and res.get("url"):
                        cost_ms = (time.perf_counter() - round_t0) * 1000.0
                        src.record_hit(platform=target_plat, cost_ms=cost_ms)
                        r_log["winner"] = src.name
                        r_log["status"] = "hit"
                        rounds_log.append(r_log)
                        exec_pool.shutdown(wait=False, cancel_futures=True)
                        return {
                            "success": True,
                            "url": res["url"],
                            "bytes": res.get("bytes", 0),
                            "source_id": src.id,
                            "source_name": src.name,
                            "title": cand_song.get("title", ""),
                            "artist": cand_song.get("artist", ""),
                            "round": 1,
                            "total_rounds_tried": 1,
                            "rounds_log": rounds_log
                        }
                    else:
                        src.record_miss(platform=target_plat)
                except Exception:
                    src.record_miss(platform=target_plat)
        except Exception:
            pass
        finally:
            exec_pool.shutdown(wait=False, cancel_futures=True)

        rounds_log.append(r_log)
        return {
            "success": False,
            "error": "本命源冲刺完毕，未能获得有效音频直链",
            "rounds_log": rounds_log
        }


# 单例实例，方便跨模块引用
source_hub = SourceManager()
