#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_sources.py - 音源健康度全量并发测速与智能排班生成器
职责：
1. 纯 Python 原生通道并发测速 (0 Node.js 进程依赖)
2. 更新 sources_ranking.json 供本地与 Vercel 生产环境 0ms 秒级预热
3. 由 GitHub Actions 定时调用，也可由本地或服务端一键触发
"""

import os
import sys
import time
import json
import urllib.request
import api_crypto
from source_manager import SourceManager, BASE_DIR, RANKING_FILE, EXTRACTED_APIS_ENC_FILE

DEFAULT_LXHUB_ENC_URL = "https://github.com/ichbinyytak/yy-lx-hub/releases/download/sync-latest/extracted_apis.enc"


def pull_encrypted_apis(url: str = None) -> bool:
    """从 yy-lx-hub 拉取强加密的 extracted_apis.enc，验签解密通过后再原子覆盖本地密文"""
    target_url = (url or os.environ.get("LXHUB_ENC_URL") or DEFAULT_LXHUB_ENC_URL).strip()
    secret = api_crypto.get_sync_secret()
    if not secret:
        print("⚠️ 未配置 AMUSIC_SYNC_KEY，跳过拉取远端密文（沿用本地缓存）")
        return False

    print(f"正在从 yy-lx-hub 拉取加密 API 包: {target_url}")
    try:
        req = urllib.request.Request(target_url, headers={"User-Agent": "Amusic-Sync/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
        # 必须先在内存校验 MAC 并成功解密为有效 endpoints 清单，才允许覆盖本地密文
        payload = api_crypto.decrypt_json(raw, secret)
        endpoints = payload.get("endpoints") if isinstance(payload, dict) else None
        if not isinstance(endpoints, list):
            raise ValueError("解密内容缺少 endpoints 列表")

        tmp_path = EXTRACTED_APIS_ENC_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(raw)
        os.replace(tmp_path, EXTRACTED_APIS_ENC_FILE)
        print(f"✓ 密文校验解密成功，已更新本地 {os.path.basename(EXTRACTED_APIS_ENC_FILE)}（共 {len(endpoints)} 个端点）")
        return True
    except Exception as e:
        print(f"⚠️ 拉取或校验远端密文失败（保留现存文件）: {e}")
        return False


def sync() -> dict:
    """执行音源池测速与最新健康度排班生成"""
    print("=== 开始全量音源纯 Python 原生健康度测速与排班 ===")
    t0 = time.perf_counter()
    sm = SourceManager()
    test_results = sm.test_all()
    tested_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    ranking_data = {
        "generatedAt": tested_at,
        "testedAt": tested_at,
        "total": len(test_results),
        "sources": test_results
    }

    try:
        with open(RANKING_FILE, "w", encoding="utf-8") as f:
            json.dump(ranking_data, f, ensure_ascii=False, indent=2)
        elapsed = round(time.perf_counter() - t0, 2)
        print(f"✓ 已成功生成最新原生测速排班表: {RANKING_FILE} (共 {len(test_results)} 个源，耗时 {elapsed}s)")
        for s in test_results:
            print(f"   [{s['id']}] {s['name']} -> {s['status']} ({s['latency_ms']}ms)")
        return {
            "success": True,
            "testedAt": tested_at,
            "total": len(test_results),
            "sources": test_results
        }
    except Exception as e:
        print(f"❌ 测速排班文件写入失败: {e}")
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    if "--pull" in sys.argv:
        pull_encrypted_apis()
    sync()
