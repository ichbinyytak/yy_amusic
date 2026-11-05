#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_sources.py - 每日自动同步并落地 lx-hub 最新验活音源脚本
职责：
1. 从 https://ichbinyytak.github.io/lx-hub/data.json 拉取当天最新沙箱验活通过的精选音源池
2. 逐一并发/容灾下载全量可用 JS 脚本到 sources_cache/ 目录
3. 清理已失效或过期的老旧音源脚本，确保云端部署（如 Vercel）能打包最新活源
4. 可由 GitHub Actions 每日定时调用，也可由本地或服务端一键触发
"""

import os
import re
import time
import json
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

HUB_URL = "https://ichbinyytak.github.io/lx-hub/data.json"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "sources_cache")

def safe_url_encode(url: str) -> str:
    """编码 URL 路径中的中文与特殊字符，防止 urllib 报 UnicodeEncodeError"""
    try:
        parts = urllib.parse.urlsplit(url)
        quoted_path = urllib.parse.quote(parts.path)
        return urllib.parse.urlunsplit((parts.scheme, parts.netloc, quoted_path, parts.query, parts.fragment))
    except Exception:
        return url

def sanitize_filename(name: str) -> str:
    """清理特殊字符，生成跨平台安全的文件名"""
    # 替换 Windows / Linux 非法字符
    clean = re.sub(r'[\\/*?:"<>|~()（）\s]+', '_', name)
    clean = clean.strip('_')
    return clean[:28] or "source"

def download_script(item: dict) -> tuple:
    """下载单个音源脚本，支持主 URL 与多镜像源自动容灾降级"""
    sid = item.get("id", "")[:8]
    seq = item.get("seq", 0)
    raw_name = item.get("name", "未命名音源")
    safe_name = sanitize_filename(raw_name)
    filename = f"{seq:02d}_{safe_name}_{sid}.js"
    target_path = os.path.join(CACHE_DIR, filename)

    urls = []
    if item.get("url"):
        urls.append(item["url"])
    if item.get("mirrors") and isinstance(item["mirrors"], list):
        for m in item["mirrors"]:
            if m and m not in urls:
                urls.append(m)

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (YY-Amusic-Sync)'
    }

    content = None
    for u in urls:
        try:
            safe_u = safe_url_encode(u)
            req = urllib.request.Request(safe_u, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status == 200:
                    data = resp.read()
                    # 校验是否为合法 JS 文本内容（排除 HTML 404 错误页）
                    text = data.decode('utf-8', errors='ignore')
                    if "lx" in text or "function" in text or "musicUrl" in text or "url" in text:
                        content = data
                        break
        except Exception:
            continue

    if content:
        try:
            with open(target_path, "wb") as f:
                f.write(content)
            return True, sid, filename, "ok"
        except Exception as e:
            return False, sid, filename, str(e)

    return False, sid, filename, "全镜像均无法下载"

def sync() -> dict:
    """执行音源池同步与落地"""
    print(f"=== 开始同步 lx-hub 云端音源池 ===")
    print(f"源头地址: {HUB_URL}")
    os.makedirs(CACHE_DIR, exist_ok=True)

    try:
        req = urllib.request.Request(HUB_URL, headers={'User-Agent': 'Mozilla/5.0 (YY-Amusic-Sync)'})
        with urllib.request.urlopen(req, timeout=12) as r:
            hub_data = json.loads(r.read().decode('utf-8'))
    except Exception as e:
        print(f"❌ 获取 lx-hub 数据失败: {e}")
        return {"success": False, "error": str(e)}

    generated_at = hub_data.get("generatedAt", "未知")
    usable_items = [it for it in hub_data.get("items", []) if it.get("status") == "ok"]
    print(f"数据生成时间: {generated_at}，验活可用音源数: {len(usable_items)}")

    if not usable_items:
        print("⚠️ 未发现可用音源，跳过文件替换以保护现有缓存。")
        return {"success": False, "error": "lx-hub items 为空"}

    # 并发下载最新脚本
    downloaded_files = set()
    success_count = 0
    fail_count = 0

    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(download_script, it): it for it in usable_items}
        for fut in as_completed(futures):
            ok, sid, fname, msg = fut.result()
            if ok:
                success_count += 1
                downloaded_files.add(fname)
                print(f"  ✓ [{sid}] {fname}")
            else:
                fail_count += 1
                print(f"  ✗ [{sid}] 下载失败: {msg}")

    # 清理陈旧孤儿文件（如果已不在最新可用池内）
    cleaned_count = 0
    current_files = os.listdir(CACHE_DIR)
    active_sids = {it.get("id", "")[:8] for it in usable_items if it.get("id")}

    for f in current_files:
        if not f.endswith(".js"):
            continue
        # 如果文件中的 sid 已经不在当前可用列表中
        f_sid_match = re.search(r'([a-f0-9]{8})\.js$', f)
        if f_sid_match:
            sid = f_sid_match.group(1)
            if sid not in active_sids:
                try:
                    os.remove(os.path.join(CACHE_DIR, f))
                    cleaned_count += 1
                    print(f"  🗑️ 已清理过期音源: {f}")
                except Exception:
                    pass

    print(f"=== 同步完成: 成功 {success_count} 个，失败 {fail_count} 个，清理过期 {cleaned_count} 个 ===")

    # 就地沙箱真实测速与智能排班
    print(f"=== 开始全量音源沙箱测速与排班 ===")
    try:
        from source_manager import SourceManager
        sm = SourceManager()
        test_results = sm.test_all()
        ranking_file = os.path.join(BASE_DIR, "sources_ranking.json")
        ranking_data = {
            "generatedAt": generated_at,
            "testedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total": len(test_results),
            "sources": test_results
        }
        with open(ranking_file, "w", encoding="utf-8") as f:
            json.dump(ranking_data, f, ensure_ascii=False, indent=2)
        print(f"✓ 已成功生成最新测速排班表: {ranking_file} (共 {len(test_results)} 个)")
    except Exception as e:
        print(f"⚠️ 测速排班生成异常: {e}")

    summary = {
        "success": True,
        "generatedAt": generated_at,
        "totalUsable": len(usable_items),
        "downloaded": success_count,
        "failed": fail_count,
        "cleaned": cleaned_count
    }
    return summary

if __name__ == "__main__":
    sync()
