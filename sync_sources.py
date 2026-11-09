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
import time
import json
from source_manager import SourceManager, BASE_DIR, RANKING_FILE


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
    sync()
