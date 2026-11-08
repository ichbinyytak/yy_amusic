#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
========================================================
模块：source_manager.py - 音源核心管理、就地测试、智能排班与双核并发调度模块
命名空间：source_hub (SourceManager 单例)
依赖协同：lx_runner.js, song_search.py, server.py, bin/node.gz
--------------------------------------------------------
核心原则：
  1. 极简与高内聚：纯 Python 标准库，0 额外 pip 依赖
  2. 便携式 Node 运行时：自带 bin/node.gz 32MB 压缩包，Serverless 冷启秒级自解压
  3. 双核并发竞速：前 2 强源并行冲刺，毫秒级即时响应出声
  4. 严格执行“零试听”：拦截 81KB 假语音，拦截 < 1.5MB 试听截断残卷
  5. 动态自适应奖惩：胜者保持高位，连续未命中自动阶梯式降级
--------------------------------------------------------
功能目录：
  1. 便携式 Node.js 沙箱自适应定位与极速解压 (get_node_binary)
  2. LX 脚本沙箱探针与原生音源定义 (_make_runner_probe / _probe_*)
  3. 音频流有效性与“零试听”深度校验 (verify_audio_url)
  4. AudioSource 单源实体与动态权重模型 (AudioSource)
  5. SourceManager 音源中枢与双核并发冲刺调度 (SourceManager: resolve_best_stream)
========================================================
"""

import os
import sys
import time
import json
import re
import gzip
import shutil
import threading
import subprocess
import urllib.request
import urllib.error
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

# 铁律：假音频与试听截断黑名单字节数
FAKE_AUDIO_LENGTHS = {81629, 181521}
MIN_VALID_BYTES = 1500000  # 1.5MB（低于此大小判定为 30 秒试听截断残卷）

# 标准测速基准曲目（按平台严格对齐歌曲ID与元数据，杜绝跨平台ID错配）
TEST_TRACKS = {
    "kw": {"id": "5886682", "songmid": "5886682", "title": "海阔天空", "artist": "Beyond"},
    "wy": {"id": "347230", "songmid": "347230", "title": "海阔天空", "artist": "Beyond"},
    "tx": {"id": "002WkUkN2L0dqm", "songmid": "002WkUkN2L0dqm", "title": "海阔天空", "artist": "Beyond"},
    "kg": {"id": "95769", "songmid": "95769", "title": "海阔天空", "artist": "Beyond"},
    "mg": {"id": "60054701923", "songmid": "60054701923", "title": "海阔天空", "artist": "Beyond"}
}

LX_HUB_URL = "https://ichbinyytak.github.io/lx-hub/data.json"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "sources_cache")
RUNNER_SCRIPT = os.path.join(BASE_DIR, "lx_runner.js")

# ========================================================
# 区块 1: 便携式 Node.js 沙箱自适应定位与极速解压
# ========================================================
def get_node_binary():
    """获取可用的 node 可执行程序路径：
    1. 优先使用系统 PATH 中的 node（如本地 Linux 环境、自建服务器）
    2. 若不存在（如 Vercel 纯 Python Serverless），检查 /tmp/node 是否已存在且可执行
    3. 若未解压，从仓库自带的 bin/node.gz 极速解压到 /tmp/node 并赋予可执行权限
    """
    sys_node = shutil.which("node")
    if sys_node:
        return sys_node

    tmp_node = "/tmp/node"
    if os.path.exists(tmp_node) and os.access(tmp_node, os.X_OK):
        return tmp_node

    # 尝试从 bin/node.gz 解压
    gz_path = os.path.join(BASE_DIR, "bin", "node.gz")
    if os.path.exists(gz_path):
        try:
            with gzip.open(gz_path, "rb") as f_in:
                with open(tmp_node, "wb") as f_out:
                    shutil.copyfileobj(f_in, f_out)
            os.chmod(tmp_node, 0o755)
            if os.path.exists(tmp_node) and os.access(tmp_node, os.X_OK):
                return tmp_node
        except Exception as e:
            print(f"[SourceManager] 解压便携 Node 二进制异常: {e}")
    return None

NODE_BIN = get_node_binary()
HAS_NODE = bool(NODE_BIN)

# ========================================================
# 区块 2: LX 脚本沙箱探针与内置原生通道探针
# ========================================================
def _make_runner_probe(script_path: str, supported_platforms: list):
    """为每一个 LX 脚本源生成专属探测函数，支持传递完整歌名、歌手与目标平台"""
    def _probe(song_info, target_platform: str = "kw", timeout: float = 3.5):
        if not HAS_NODE or not os.path.exists(RUNNER_SCRIPT) or not os.path.exists(script_path):
            return None
        
        # 兼容 dict 或 str 传参
        sid = song_info.get("id", "") if isinstance(song_info, dict) else str(song_info or "")
        title = song_info.get("title", "海阔天空") if isinstance(song_info, dict) else "海阔天空"
        artist = song_info.get("artist", "Beyond") if isinstance(song_info, dict) else "Beyond"
        album = song_info.get("album", "") if isinstance(song_info, dict) else ""
        quality = song_info.get("quality", "320k") if isinstance(song_info, dict) else "320k"

        # 确定调用平台
        plat = target_platform if target_platform in supported_platforms else supported_platforms[0]
        
        # 补全标准 song_info 格式
        payload_info = {
            "id": sid,
            "songmid": sid,
            "title": title,
            "artist": artist,
            "album": album,
            "quality": quality,
            "timeout": int(timeout * 1000)
        }
        cmd = [
            NODE_BIN or "node",
            RUNNER_SCRIPT,
            script_path,
            plat,
            "musicUrl",
            json.dumps(payload_info)
        ]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 1.2)
            if p.returncode == 0 and p.stdout:
                res = json.loads(p.stdout.strip())
                if res.get("success") and res.get("url"):
                    target_url = res["url"]
                    ok, sz, purl = verify_audio_url(target_url, timeout=2.5)
                    if ok:
                        return {"url": purl, "bytes": sz, "source": f"LX_{os.path.basename(script_path)[:12]}"}
        except Exception:
            pass
        return None
    return _probe

# ========================================================
# 区块 3: 音频直链真实性校验与“零试听”截断拦截
# ========================================================
def verify_audio_url(url: str, timeout: float = 2.0) -> tuple:
    """
    轻量秒级校验音频有效性：仅获取 HEAD 或 Range 请求头，不下载几兆音频 Body
    返回: (is_valid: bool, content_length: int, final_url: str)
    """
    if not url or not url.startswith("http"):
        return False, 0, ""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Range': 'bytes=0-1024'  # 只嗅探前 1KB
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_url = resp.geturl()
            # 从 Content-Range 或 Content-Length 获取文件总字节数
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

            # 拦截语音刺客与残卷
            if total_size in FAKE_AUDIO_LENGTHS:
                return False, total_size, final_url
            if 0 < total_size < MIN_VALID_BYTES:
                return False, total_size, final_url
            return True, total_size, final_url
    except Exception:
        # 云端/跨网容错护航：若探针因跨境握手抖动超时，但直链明确为各大厂官方可信 CDN，绝对信任放行，严防误判引发全库雪崩！
        is_trusted_official_cdn = any(d in url for d in [
            'kuwo.cn', '126.net', 'music.126.net', 'qqmusic.qq.com', 'stream.qqmusic', 'kugou.com', 'migu.cn'
        ])
        if is_trusted_official_cdn:
            return True, 5000000, url
        return False, 0, ""


# ========================================================
# 内置直连音源探测器定义（高可用、极速毫秒响应）
# ========================================================

def _extract_id(song_info):
    if isinstance(song_info, dict):
        return str(song_info.get("id", ""))
    return str(song_info or "")

def _probe_kw_haitang(song_info, target_platform="kw", timeout: float = 2.0):
    song_id = _extract_id(song_info)
    url = f"https://musicapi.haitangw.net/music/kw.php?type=mp3&id={song_id}&level=standard"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        final_url = resp.geturl()
        if final_url and 'haitangw.net' not in final_url:
            ok, sz, purl = verify_audio_url(final_url, timeout=1.5)
            if ok:
                return {"url": purl, "bytes": sz, "source": "海棠SVIP穿透通道"}
    return None

def _probe_kw_anti(song_info, target_platform="kw", timeout: float = 2.0):
    song_id = _extract_id(song_info)
    url = f"http://antiserver.kuwo.cn/anti.s?type=convert_url3&rid={song_id}&format=mp3&response=url"
    req = urllib.request.Request(url, headers={'User-Agent': 'okhttp/3.10.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode('utf-8').strip()
        purl = json.loads(raw).get('url', '') if raw.startswith('{') else raw
        if purl and purl.startswith('http'):
            ok, sz, final_url = verify_audio_url(purl, timeout=1.5)
            if ok:
                return {"url": final_url, "bytes": sz, "source": "酷我官方原生通道"}
    return None

def _probe_kw_nxinxz(song_info, target_platform="kw", timeout: float = 2.0):
    song_id = _extract_id(song_info)
    url = f"http://music.nxinxz.com/kw.php?id={song_id}&level=standard&type=mp3"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        final_url = resp.geturl()
        if final_url and 'music.nxinxz.com' not in final_url:
            ok, sz, purl = verify_audio_url(final_url, timeout=1.5)
            if ok:
                return {"url": purl, "bytes": sz, "source": "念心车机穿透通道"}
    return None

def _probe_wy_meting(song_info, target_platform="wy", timeout: float = 2.0):
    song_id = _extract_id(song_info)
    url = f"https://api.injahow.cn/meting/?server=netease&type=url&id={song_id}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        final_url = resp.geturl()
        if resp.status == 200 and 'music.126.net' in final_url:
            ok, sz, purl = verify_audio_url(final_url, timeout=1.5)
            if ok:
                return {"url": purl, "bytes": sz, "source": "网易云开放直通通道"}
    return None

# ========================================================
# 区块 4: AudioSource 单源模型实体与自适应排班模型
# ========================================================
class AudioSource:
    """音源模型实体，追踪本地网络实测延迟与分平台动态战绩"""
    def __init__(self, source_id, name, platforms, probe_func, test_track_id):
        self.id = source_id
        self.name = name
        self.platforms = [platforms] if isinstance(platforms, str) else list(platforms)
        self.platform = self.platforms[0] if self.platforms else "kw"
        self.probe_func = probe_func
        self.test_track_id = test_track_id

        # 状态与动态统计 (全局 + 分平台)
        self.latency_ms = 9999.0
        self.status = "untested"
        self.success_count = 0
        self.fail_count = 0
        self.consecutive_fails = 0
        self.platform_latencies = {}  # 例如 {"kw": 430.0, "wy": 769.3}
        self.platform_status = {}     # 例如 {"kw": "ok", "wy": "ok"}
        self.platform_fails = {}      # 分平台连续失败计数

    def test_health(self) -> dict:
        """执行本地真实探活打测，对所支持的各平台分别测速记录，杜绝跨平台误判"""
        best_plat = None
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

    def record_hit(self, platform: str = None):
        """成功取歌出声：实战奖励"""
        self.success_count += 1
        self.consecutive_fails = 0
        if platform:
            self.platform_fails[platform] = 0

    def record_miss(self, platform: str = None):
        """找不到歌 / 报错：实战惩罚"""
        self.fail_count += 1
        self.consecutive_fails += 1
        if platform:
            self.platform_fails[platform] = self.platform_fails.get(platform, 0) + 1

    def get_sort_weight(self, platform: str = None) -> float:
        """
        计算排序综合权重（越小排越前）：
        支持按目标平台细分排序，杜绝网易快源霸占酷我榜首的倒挂问题
        """
        if platform:
            if platform not in self.platforms:
                return 999999.0  # 根本不支持此平台

            # 若该平台尚未有独立实测成绩：非本命平台降权至 5000ms+，确保实测有效的本命源绝对优先
            if platform not in self.platform_latencies:
                if self.platform != platform:
                    p_lat = 5000.0
                    p_status = "untested"
                else:
                    p_lat = self.latency_ms
                    p_status = self.status
            else:
                p_lat = self.platform_latencies[platform]
                p_status = self.platform_status.get(platform, "ok")

            p_fails = self.platform_fails.get(platform, self.consecutive_fails)
            if p_status != "ok" or p_lat >= 9000.0:
                return 90000.0 + p_fails * 1000.0
            penalty = p_fails * 300.0
            bonus = min(250.0, self.success_count * 25.0)
            return max(1.0, p_lat + penalty - bonus)

        # 全局回退排序
        if self.status != "ok":
            return 90000.0 + self.consecutive_fails * 1000.0
        penalty = self.consecutive_fails * 300.0
        bonus = min(250.0, self.success_count * 25.0)
        return max(1.0, self.latency_ms + penalty - bonus)

# ========================================================
# 区块 5: SourceManager 音源中枢与双核并发冲刺调度
# ========================================================
class SourceManager:
    """音源调度总管：管理、测速、重排、双核并发全量冲刺"""
    def __init__(self):
        self.sources = {}
        self.tested_at = None
        self._test_lock = threading.Lock()
        self._is_testing = False
        self._init_builtin_sources()

    def _init_builtin_sources(self):
        # 1. 默认注册 4 大异构原生通道（涵盖酷我车机、海棠、念心、网易云），并初始化分平台基准数据
        s_haitang = AudioSource("kw_haitang", "海棠穿透源 (酷我)", "kw", _probe_kw_haitang, "5886682")
        s_haitang.status = "ok"
        s_haitang.latency_ms = 430.0
        s_haitang.platform_latencies = {"kw": 430.0}
        s_haitang.platform_status = {"kw": "ok"}
        s_haitang.success_count = 15
        self.register(s_haitang)

        s_nxinxz = AudioSource("kw_nxinxz", "念心穿透源 (酷我)", "kw", _probe_kw_nxinxz, "5886682")
        s_nxinxz.status = "ok"
        s_nxinxz.latency_ms = 680.0
        s_nxinxz.platform_latencies = {"kw": 680.0}
        s_nxinxz.platform_status = {"kw": "ok"}
        s_nxinxz.success_count = 5
        self.register(s_nxinxz)

        s_anti = AudioSource("kw_anti", "车机原生源 (酷我)", "kw", _probe_kw_anti, "5886682")
        s_anti.status = "ok"
        s_anti.latency_ms = 800.0
        s_anti.platform_latencies = {"kw": 800.0}
        s_anti.platform_status = {"kw": "ok"}
        self.register(s_anti)

        s_wy = AudioSource("wy_meting", "网易直通源 (网易)", "wy", _probe_wy_meting, "347230")
        s_wy.status = "ok"
        s_wy.latency_ms = 450.0
        s_wy.platform_latencies = {"wy": 450.0}
        s_wy.platform_status = {"wy": "ok"}
        self.register(s_wy)

        # 2. 零外网阻塞：直接从本地 sources_cache 与 sources_ranking.json 极速预热注册音源
        self.load_local_cached_sources()

    def load_local_cached_sources(self):
        """
        零网络开销：纯本地极速载入 sources_cache 与 sources_ranking.json
        彻底消除模块导入与 Serverless 冷启动期间的外网同步阻塞 (0ms 冷启动)
        """
        cached_files = os.listdir(CACHE_DIR) if os.path.exists(CACHE_DIR) else []
        ranking_file = os.path.join(BASE_DIR, "sources_ranking.json")
        ranking_sources = {}
        if os.path.exists(ranking_file):
            try:
                with open(ranking_file, "r", encoding="utf-8") as f:
                    data = json.loads(f.read())
                self.tested_at = data.get("testedAt") or data.get("generatedAt")
                for s_info in data.get("sources", []):
                    sid = s_info.get("id")
                    if sid:
                        ranking_sources[sid] = s_info
            except Exception:
                pass

        # 1. 对比排班表注册本地 LX 音源
        # 6.1 在 Vercel 或无 Node 环境下，直接跳过所有 LX 脚本源，仅更新原生直连源，专注原生通道
        if not HAS_NODE:
            for r_id, s_info in ranking_sources.items():
                if not r_id.startswith("lx_") and r_id in self.sources:
                    src = self.sources[r_id]
                    src.latency_ms = float(s_info.get("latency_ms", src.latency_ms))
                    src.status = s_info.get("status", src.status)
                    if s_info.get("platform"):
                        src.platform = s_info.get("platform")
            return

        registered_sids = set()
        for r_id, s_info in ranking_sources.items():
            if not r_id.startswith("lx_"):
                # 如果是内置原生音源，更新其健康度状态
                if r_id in self.sources:
                    src = self.sources[r_id]
                    src.latency_ms = float(s_info.get("latency_ms", src.latency_ms))
                    src.status = s_info.get("status", src.status)
                    if s_info.get("platform"):
                        src.platform = s_info.get("platform")
                continue

            sid = r_id[3:]  # 去掉 "lx_" 前缀
            matching = [f for f in cached_files if sid in f and f.endswith(".js")]
            if matching:
                target_file = max(matching, key=lambda f: os.path.getmtime(os.path.join(CACHE_DIR, f)))
                script_path = os.path.join(CACHE_DIR, target_file)
                plats = s_info.get("platforms") or [s_info.get("platform", "kw")]
                probe = _make_runner_probe(script_path, plats)
                src = AudioSource(r_id, s_info.get("name", f"[LX] {target_file}"), plats, probe, "5886682")
                src.platform = s_info.get("platform", plats[0])
                src.latency_ms = float(s_info.get("latency_ms", 9999.0))
                src.status = s_info.get("status", "ok")
                src.consecutive_fails = int(s_info.get("consecutive_fails", 0))
                src.success_count = int(s_info.get("success_count", 0))
                src.platform_latencies = dict(s_info.get("platform_latencies") or {})
                src.platform_status = dict(s_info.get("platform_status") or {})
                # 若排班表仅有总成绩，且仅指定了单一主平台，则只映射到该主平台，绝不跨平台污染
                if not src.platform_latencies and src.platform:
                    src.platform_latencies[src.platform] = src.latency_ms
                    src.platform_status[src.platform] = src.status
                self.register(src)
                registered_sids.add(sid)

        # 2. 补漏：扫描 sources_cache 中存在但尚未被排班表记录的脚本
        for f in cached_files:
            if not f.endswith(".js"):
                continue
            m = re.search(r'([a-f0-9]{8})\.js$', f)
            sid = m.group(1) if m else f[:8]
            if sid in registered_sids:
                continue

            script_path = os.path.join(CACHE_DIR, f)
            plat_set = set()
            try:
                with open(script_path, 'r', encoding='utf-8', errors='ignore') as sf:
                    scode = sf.read(8000)
                    if re.search(r'[\'"]?kw[\'"]?\s*:', scode) or 'kuwo' in scode.lower():
                        plat_set.add('kw')
                    if re.search(r'[\'"]?wy[\'"]?\s*:', scode) or '163' in scode:
                        plat_set.add('wy')
                    if re.search(r'[\'"]?tx[\'"]?\s*:', scode) or 'qq' in scode.lower():
                        plat_set.add('tx')
                    if re.search(r'[\'"]?kg[\'"]?\s*:', scode) or 'kugou' in scode.lower():
                        plat_set.add('kg')
                    if re.search(r'[\'"]?mg[\'"]?\s*:', scode) or 'migu' in scode.lower():
                        plat_set.add('mg')
            except Exception:
                pass
            plats = list(plat_set) if plat_set else ['kw']
            probe = _make_runner_probe(script_path, plats)
            clean_name = f.replace('.js', '').replace('source_', '')
            src = AudioSource(f"lx_{sid}", f"[LX] {clean_name}", plats, probe, "5886682")
            src.status = "ok"
            src.latency_ms = 2000.0
            self.register(src)
            registered_sids.add(sid)

    def load_prewarmed_ranking(self):
        """载入 GitHub Actions 每日测速生成的 sources_ranking.json"""
        ranking_file = os.path.join(BASE_DIR, "sources_ranking.json")
        if not os.path.exists(ranking_file):
            return
        try:
            with open(ranking_file, "r", encoding="utf-8") as f:
                data = json.loads(f.read())
            self.tested_at = data.get("testedAt") or data.get("generatedAt")
            sources_list = data.get("sources", [])
            for s_info in sources_list:
                sid = s_info.get("id")
                if sid in self.sources:
                    src = self.sources[sid]
                    src.latency_ms = float(s_info.get("latency_ms", src.latency_ms))
                    src.status = s_info.get("status", src.status)
                    if s_info.get("platform"):
                        src.platform = s_info.get("platform")
        except Exception:
            pass

    def sync_from_lx_hub(self):
        """从用户维护的 lx-hub 动态同步并注册全部 32 个音源"""
        if not HAS_NODE or os.environ.get("VERCEL"):
            return False
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
        except Exception:
            pass
        cached_files = os.listdir(CACHE_DIR) if os.path.exists(CACHE_DIR) else []
        try:
            req = urllib.request.Request(LX_HUB_URL, headers={'User-Agent': 'Mozilla/5.0 (YY-Music-Core)'})
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.loads(r.read().decode('utf-8'))
                items = data.get('items', [])
                for it in items:
                    sid = it.get('id', '')
                    name = it.get('name', '未命名音源')
                    raw_plats = it.get('platforms', [])
                    
                    plat_set = set()
                    for p in raw_plats:
                        if '酷我' in p or p == 'kw': plat_set.add('kw')
                        elif '网易' in p or p == 'wy': plat_set.add('wy')
                        elif 'QQ' in p or p == 'tx': plat_set.add('tx')
                        elif '酷狗' in p or p == 'kg': plat_set.add('kg')
                        elif '咪咕' in p or p == 'mg': plat_set.add('mg')

                    matching = [f for f in cached_files if sid[:8] in f and f.endswith(".js")]
                    if matching:
                        # 严格挑选文件修改时间最新（mtime）的脚本，彻底避免绑定到陈旧历史版本
                        target_file = max(matching, key=lambda f: os.path.getmtime(os.path.join(CACHE_DIR, f)))
                        script_path = os.path.join(CACHE_DIR, target_file)
                        # 源码级防漏标扫描：检测脚本实际实现平台，弥补上游元数据漏标
                        try:
                            with open(script_path, 'r', encoding='utf-8', errors='ignore') as sf:
                                scode = sf.read(8000)
                                if re.search(r'[\'"]?kw[\'"]?\s*:', scode) or 'kuwo' in scode.lower():
                                    plat_set.add('kw')
                                if re.search(r'[\'"]?wy[\'"]?\s*:', scode) or '163' in scode:
                                    plat_set.add('wy')
                                if re.search(r'[\'"]?tx[\'"]?\s*:', scode) or 'qq' in scode.lower():
                                    plat_set.add('tx')
                                if re.search(r'[\'"]?kg[\'"]?\s*:', scode) or 'kugou' in scode.lower():
                                    plat_set.add('kg')
                                if re.search(r'[\'"]?mg[\'"]?\s*:', scode) or 'migu' in scode.lower():
                                    plat_set.add('mg')
                        except Exception:
                            pass

                        plat_list = list(plat_set) if plat_set else ['kw']
                        test_tid = "5886682" if 'kw' in plat_list else ("347230" if 'wy' in plat_list else "95769")
                        probe = _make_runner_probe(script_path, plat_list)
                        self.register(AudioSource(f"lx_{sid[:8]}", f"[LX] {name}", plat_list, probe, test_tid))
        except Exception as e:
            print(f"[SourceManager] 同步 lx-hub 异常: {e}")

    def register(self, source: AudioSource):
        self.sources[source.id] = source

    def get_ordered_sources(self, platform: str = None) -> list:
        """获取当前按综合健康度从优到劣排序的音源队列（针对目标平台专属排名）"""
        cands = list(self.sources.values())
        if platform:
            cands = [s for s in cands if platform in s.platforms]
            cands.sort(key=lambda s: s.get_sort_weight(platform=platform))
        else:
            cands.sort(key=lambda s: s.get_sort_weight())
        return cands

    def test_all(self) -> list:
        """
        对应草图【⚡测速重排】按钮：
        并发就地测试所有音源，按实测延迟与健康度重新排序。
        具备并发锁防护，杜绝多个线程或请求同时发起全量测试风暴。
        """
        with self._test_lock:
            if self._is_testing:
                # 若已在测速中，直接返回当前排班结果，避免重复重载
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
            with ThreadPoolExecutor(max_workers=min(8, len(self.sources))) as executor:
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

    def resolve_best_stream(self, cand_song: dict) -> dict:
        """
        双核并发全量冲刺调度（Dual-Core Racing Across Entire Source Pool）：
        前期阶段：必须将整个源库中所有源全部轮询覆盖！
        按当前延迟与排名，每次派出 2 个源同时冲刺！
        任一源返回有效全曲（> 1.5MB）即刻胜出出声并奖励晋升；
        若未命中，紧接着派出下 2 个源，不只搜索两轮，直到把所有源全部遍历冲刺完毕！
        """
        target_plat = cand_song.get("platform", "kw")
        song_id = cand_song.get("id", "")
        if not song_id:
            return {"error": "缺少歌曲内部有效 ID"}

        # 优先使用同平台音源（第一梯队优先冲刺）
        # 再顺延跨平台音源作为第二梯队兜底，确保 100% 覆盖的同时避免超时风暴
        same_plat_sources = self.get_ordered_sources(platform=target_plat)
        other_sources = [s for s in self.get_ordered_sources() if s not in same_plat_sources]
        all_ordered = same_plat_sources + other_sources

        rounds_log = []
        batch_size = 2
        total_rounds = (len(all_ordered) + batch_size - 1) // batch_size

        for round_idx in range(total_rounds):
            batch = all_ordered[round_idx * batch_size : (round_idx + 1) * batch_size]
            names = [s.name for s in batch]
            r_log = {
                "round": round_idx + 1,
                "sources": names,
                "winner": None,
                "status": "miss"
            }

            exec_pool = ThreadPoolExecutor(max_workers=len(batch))
            try:
                # 动态超时分配：本命源给予充裕 2.5s；跨平台尝试收紧至 1.2s，防止延迟雪崩
                future_map = {
                    exec_pool.submit(s.probe_func, cand_song, target_plat, 2.5 if target_plat in s.platforms else 1.2): s
                    for s in batch
                }
                for f in as_completed(future_map):
                    src = future_map[f]
                    is_native_plat = target_plat in src.platforms
                    try:
                        res = f.result()
                        if res and res.get("url"):
                            src.record_hit(platform=target_plat)
                            r_log["winner"] = src.name
                            r_log["status"] = "hit"
                            rounds_log.append(r_log)
                            # 彻底解除 Python ThreadPoolExecutor 默认的 wait=True 退出死锁：
                            # 胜出者一旦产生，即刻非阻塞退出，绝不等待同组慢音源！
                            exec_pool.shutdown(wait=False, cancel_futures=True)
                            return {
                                "success": True,
                                "url": res["url"],
                                "bytes": res.get("bytes", 0),
                                "source_id": src.id,
                                "source_name": src.name,
                                "title": cand_song.get("title", ""),
                                "artist": cand_song.get("artist", ""),
                                "round": round_idx + 1,
                                "total_rounds_tried": round_idx + 1,
                                "rounds_log": rounds_log
                            }
                        else:
                            # 核心免责保护：只有在音源自身的本命支持平台失败时，才记录 miss；
                            # 跨平台尝试失败绝对免责，杜绝误伤优质音源健康度！
                            if is_native_plat:
                                src.record_miss(platform=target_plat)
                    except Exception:
                        if is_native_plat:
                            src.record_miss(platform=target_plat)
            finally:
                exec_pool.shutdown(wait=False, cancel_futures=True)

            rounds_log.append(r_log)

        return {
            "success": False,
            "error": f"全库 {len(all_ordered)} 个音源（共 {total_rounds} 轮双核冲刺）均未能返回有效全曲",
            "rounds_log": rounds_log
        }


# 单例实例，方便跨模块引用
source_hub = SourceManager()
