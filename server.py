#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Amusic - Apple 音乐纯文本数据库浏览器本地服务
运行方式: python3 server.py
访问地址: http://127.0.0.1:8088
"""

import http.server
import socketserver
import os
import sys
import json
import time
import re
import urllib.request
import urllib.error
import urllib.parse

PORT = 8088
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# 官方 Web 播放器公共只读访客 Token
DEFAULT_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw"

NEW_PAGE_CACHE = {}

def fetch_apple_new_page(storefront="cn"):
    now = time.time()
    if storefront in NEW_PAGE_CACHE:
        cached_time, cached_data = NEW_PAGE_CACHE[storefront]
        if now - cached_time < 300:  # 5 分钟内存缓存
            return cached_data

    url = f"https://music.apple.com/{storefront}/new"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="ignore")

    sections_out = []
    scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
    for s in scripts:
        if 'BrowsePageIntent' in s:
            data = json.loads(s)
            sections = data.get('data', [{}])[0].get('data', {}).get('sections', [])
            for idx, sec in enumerate(sections):
                hdr = sec.get('header') or {}
                title = (hdr.get('item', {}).get('titleLink', {}).get('title') 
                         or hdr.get('title') 
                         or (('🔥 焦点推荐与主推歌单') if idx == 0 else ''))
                if not title:
                    continue
                
                items = []
                for it in sec.get('items', []):
                    t = it.get('title') or (it.get('titleLinks', [{}])[0].get('title') if it.get('titleLinks') else '')
                    st = it.get('subtitle') or (it.get('subtitleLinks', [{}])[0].get('title') if it.get('subtitleLinks') else '')
                    heading = it.get('heading') or ''
                    desc = it.get('contentDescriptor') or {}
                    url_item = desc.get('url') or ''
                    if not url_item and it.get('titleLinks'):
                        url_item = it['titleLinks'][0].get('segue', {}).get('destination', {}).get('contentDescriptor', {}).get('url', '')
                    adam_id = desc.get('identifiers', {}).get('storeAdamID') or it.get('id')
                    kind = desc.get('kind') or it.get('itemKind') or 'item'
                    if t:
                        items.append({
                            'title': t,
                            'subtitle': st,
                            'heading': heading,
                            'kind': kind,
                            'id': adam_id,
                            'url': url_item
                        })
                if items:
                    sections_out.append({
                        'title': title,
                        'items': items
                    })
            break

    result = {
        "storefront": storefront,
        "sections": sections_out
    }
    NEW_PAGE_CACHE[storefront] = (now, result)
    return result

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        # 1. 抓取与解析 music.apple.com/new 页面
        if self.path.startswith("/api/apple_new"):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            sf = qs.get("storefront", ["cn"])[0]
            try:
                data = fetch_apple_new_page(sf)
                res_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(res_bytes)))
                self.end_headers()
                self.wfile.write(res_bytes)
            except Exception as e:
                err_bytes = json.dumps({"error": str(e)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(err_bytes)))
                self.end_headers()
                self.wfile.write(err_bytes)
            return

        # 2. 代理转发给 Apple Music 官方数据库（解决浏览器禁止伪造 Origin 头部的 401 限制）
        if self.path.startswith("/api/apple/"):
            apple_path = self.path[len("/api/apple/"):]
            apple_url = f"https://api.music.apple.com/{apple_path}"
            try:
                req = urllib.request.Request(apple_url, headers={
                    "Authorization": f"Bearer {DEFAULT_TOKEN}",
                    "Origin": "https://music.apple.com",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                })
                with urllib.request.urlopen(req, timeout=12) as resp:
                    data = resp.read()
                    self.send_response(resp.status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
            except urllib.error.HTTPError as e:
                err_data = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(err_data)))
                self.end_headers()
                self.wfile.write(err_data)
            except Exception as e:
                err_msg = json.dumps({"error": str(e)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(err_msg)))
                self.end_headers()
                self.wfile.write(err_msg)
            return

        super().do_GET()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def log_message(self, format, *args):
        sys.stdout.write(f"[Amusic] {self.address_string()} - {format % args}\n")

if __name__ == "__main__":
    os.chdir(DIRECTORY)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"==================================================")
        print(f"🍎 Amusic (Apple 音乐纯文本数据库浏览器) 已就绪！")
        print(f"本地访问地址: http://127.0.0.1:{PORT}")
        print(f"局域网地址:   http://0.0.0.0:{PORT}")
        print(f"==================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已平滑关闭。")
