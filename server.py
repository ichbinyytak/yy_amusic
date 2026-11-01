#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Amusic - Apple 音乐纯文本数据库浏览器本地服务
核心定位: 0 图片下载开销，直连 Apple Music 官方数据库与 SSR 渲染树，极速提取歌单与专辑。
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

# 官方 Web 播放器公共只读访客 Token (有效期至 2027 年)
DEFAULT_TOKEN = (
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ."
    "eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ."
    "wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw"
)

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# 内存缓存（TTL 5~10 分钟）
NEW_PAGE_CACHE = {}
ROOM_CACHE = {}
SEARCH_PAGE_CACHE = {}
CURATOR_PAGE_CACHE = {}

def http_get_html(url, timeout=15):
    """发起 HTTP GET 请求抓取 HTML 页面"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def extract_ssr_data(html, keyword="data"):
    """从 HTML 的 <script> 标签中精准提取 Apple SSR 结构化数据"""
    for s in re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL):
        if keyword in s and 'sections' in s:
            try:
                return json.loads(s)
            except Exception:
                continue
    return None

def parse_card_item(it, sec_title=""):
    """统一解析 Apple Music 卡片项目，提取标题、副标、类型、直链和 storeAdamID"""
    desc = it.get('contentDescriptor') or {}
    kind = desc.get('kind') or it.get('itemKind') or ''
    title = it.get('title') or (it.get('titleLinks', [{}])[0].get('title') if it.get('titleLinks') else '')
    subtitle = it.get('subtitle') or (it.get('subtitleLinks', [{}])[0].get('title') if it.get('subtitleLinks') else '')
    adam_id = desc.get('identifiers', {}).get('storeAdamID') or it.get('id')
    url = desc.get('url') or ''
    if not url and it.get('titleLinks'):
        url = it['titleLinks'][0].get('segue', {}).get('destination', {}).get('contentDescriptor', {}).get('url', '')

    return {
        'type': kind,
        'kind': kind,
        'title': title,
        'curator': subtitle or 'Apple Music',
        'heading': it.get('heading', ''),
        'desc': f'收录于【{sec_title}】板块' if sec_title else '',
        'id': adam_id,
        'url': url
    }

def fetch_apple_new_page(storefront="cn"):
    """
    抓取 /new 页面并严格重构为【歌单/专辑】聚合实体。
    单曲类板块（如新歌精选、正在流行中）自动升格为官方精选合集歌单。
    """
    now = time.time()
    if storefront in NEW_PAGE_CACHE:
        cached_time, cached_data = NEW_PAGE_CACHE[storefront]
        if now - cached_time < 300:
            return cached_data

    html = http_get_html(f"https://music.apple.com/{storefront}/new")
    d = extract_ssr_data(html, "BrowsePageIntent")
    sections_out = []

    if d:
        sections = d.get('data', [{}])[0].get('data', {}).get('sections', [])
        for idx, sec in enumerate(sections):
            hdr = sec.get('header') or {}
            item_hdr = hdr.get('item') or {}
            sec_title = item_hdr.get('titleLink', {}).get('title') or hdr.get('title') or (('🔥 焦点推荐与主推歌单') if idx == 0 else '')
            room_url = item_hdr.get('url') or ''
            if not sec_title:
                continue

            items = sec.get('items', [])
            if not items:
                continue

            kinds = [((it.get('contentDescriptor') or {}).get('kind') or it.get('itemKind')) for it in items]

            # 规则 1：单曲散装板块整体升格为【精选歌单】
            if any(k == 'song' for k in kinds):
                track_samples = []
                tracks_list = []
                for it_idx, it in enumerate(items, 1):
                    card = parse_card_item(it, sec_title)
                    if card['title']:
                        tracks_list.append({
                            'index': it_idx,
                            'name': card['title'],
                            'artist': card['curator'] or '群星',
                            'album': sec_title,
                            'durationMillis': it.get('durationInMillis', 0),
                            'url': card['url']
                        })
                        if len(track_samples) < 3:
                            track_samples.append(f"{card['title']} ({card['curator']})")

                desc_text = f"Apple Music 官方精选新歌，包含：" + '、'.join(track_samples) + f" 等共 {len(tracks_list)} 首"
                sections_out.append({
                    'title': '官方精选新歌合集',
                    'items': [{
                        'type': 'playlist',
                        'kind': 'playlist',
                        'isCurated': True,
                        'title': sec_title,
                        'curator': 'Apple Music 官方编辑',
                        'heading': '官方精选合集',
                        'desc': desc_text,
                        'trackCount': len(tracks_list),
                        'tracks': tracks_list,
                        'roomUrl': room_url,
                        'url': room_url or f"https://music.apple.com/{storefront}/new"
                    }]
                })
            else:
                # 规则 2：专辑与歌单板块完整收录，过滤非音乐内容
                valid_items = []
                for it in items:
                    card = parse_card_item(it, sec_title)
                    if card['kind'] in ['playlist', 'album'] and card['title']:
                        valid_items.append(card)

                if valid_items:
                    sections_out.append({
                        'title': sec_title,
                        'items': valid_items
                    })

    result = {"storefront": storefront, "sections": sections_out}
    NEW_PAGE_CACHE[storefront] = (now, result)
    return result

def fetch_apple_search_page(storefront="cn"):
    """
    抓取 /search 探索中枢，提取官方 50+ 个音乐专区 (Curator 与专区分类)
    """
    now = time.time()
    if storefront in SEARCH_PAGE_CACHE:
        cached_time, cached_data = SEARCH_PAGE_CACHE[storefront]
        if now - cached_time < 600:
            return cached_data

    html = http_get_html(f"https://music.apple.com/{storefront}/search")
    d = extract_ssr_data(html, "data")
    categories = []

    if d:
        sections = d.get('data', [{}])[0].get('data', {}).get('sections', [])
        for sec in sections:
            for it in sec.get('items', []):
                card = parse_card_item(it)
                if card['title'] and card['id']:
                    categories.append({
                        'title': card['title'],
                        'id': card['id'],
                        'kind': card['kind'],
                        'url': card['url']
                    })

    result = {"storefront": storefront, "categories": categories}
    SEARCH_PAGE_CACHE[storefront] = (now, result)
    return result

def fetch_apple_curator_page(url):
    """
    深度抓取 Apple Music 官方专区主页 (如 /curator/apple-music-国语流行/1019400042)
    100% 还原官网的焦点推荐、歌单、年度热门、明星曲目单与经典专辑等板块
    """
    now = time.time()
    if url in CURATOR_PAGE_CACHE:
        cached_time, cached_data = CURATOR_PAGE_CACHE[url]
        if now - cached_time < 300:
            return cached_data

    html = http_get_html(url)
    d = extract_ssr_data(html, "data")
    sections_out = []

    if d:
        sections = d.get('data', [{}])[0].get('data', {}).get('sections', [])
        for idx, sec in enumerate(sections):
            hdr = sec.get('header') or {}
            item_hdr = hdr.get('item') or {}
            sec_title = item_hdr.get('titleLink', {}).get('title') or hdr.get('title') or (('🌟 焦点推荐') if idx == 1 else '')
            if not sec_title:
                continue

            items = sec.get('items', [])
            if not items:
                continue

            valid_items = []
            for it in items:
                card = parse_card_item(it, sec_title)
                if card['kind'] in ['playlist', 'album'] and card['title']:
                    valid_items.append(card)

            if valid_items:
                sections_out.append({
                    'title': sec_title,
                    'items': valid_items
                })

    result = {"url": url, "sections": sections_out}
    CURATOR_PAGE_CACHE[url] = (now, result)
    return result

def fetch_apple_room(room_url):
    """
    抓取 Apple Music 官方专题 Room (如新歌精选 100 首曲目大合集)
    """
    now = time.time()
    if room_url in ROOM_CACHE:
        cached_time, cached_tracks = ROOM_CACHE[room_url]
        if now - cached_time < 300:
            return cached_tracks

    html = http_get_html(room_url)
    d = extract_ssr_data(html, "data")
    tracks = []

    if d:
        try:
            sec_items = d['data'][0]['data']['sections'][0].get('items', [])
            for idx, it in enumerate(sec_items, 1):
                card = parse_card_item(it)
                if card['title']:
                    tracks.append({
                        'index': idx,
                        'name': card['title'],
                        'artist': card['curator'] or '群星',
                        'album': '官方新歌精选',
                        'durationMillis': it.get('durationInMillis', 0),
                        'url': card['url']
                    })
        except Exception:
            pass

    ROOM_CACHE[room_url] = (now, tracks)
    return tracks

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def send_json(self, data, status=200):
        """统一 JSON 响应辅助函数"""
        res_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(res_bytes)))
        self.end_headers()
        self.wfile.write(res_bytes)

    def send_error_json(self, message, status=500):
        """统一错误 JSON 响应"""
        self.send_json({"error": str(message)}, status=status)

    def do_GET(self):
        # 1. /new 页面结构化抓取 (全歌单/专辑模式)
        if self.path.startswith("/api/apple_new"):
            parsed = urllib.parse.urlparse(self.path)
            sf = urllib.parse.parse_qs(parsed.query).get("storefront", ["cn"])[0]
            try:
                self.send_json(fetch_apple_new_page(sf))
            except Exception as e:
                self.send_error_json(e)
            return

        # 2. /search 探索中枢全部分类专区抓取
        if self.path.startswith("/api/apple_search_page"):
            parsed = urllib.parse.urlparse(self.path)
            sf = urllib.parse.parse_qs(parsed.query).get("storefront", ["cn"])[0]
            try:
                self.send_json(fetch_apple_search_page(sf))
            except Exception as e:
                self.send_error_json(e)
            return

        # 3. 专区官方主页真实板块抓取 (与官网 100% 对齐)
        if self.path.startswith("/api/apple_curator_page"):
            parsed = urllib.parse.urlparse(self.path)
            curator_url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
            if not curator_url:
                self.send_error_json("Missing url parameter", 400)
                return
            try:
                self.send_json(fetch_apple_curator_page(curator_url))
            except Exception as e:
                self.send_error_json(e)
            return

        # 4. 专题 Room 完整曲目抓取 (如 100 首完整合集)
        if self.path.startswith("/api/apple_room"):
            parsed = urllib.parse.urlparse(self.path)
            room_url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
            if not room_url:
                self.send_error_json("Missing url parameter", 400)
                return
            try:
                self.send_json({"tracks": fetch_apple_room(room_url)})
            except Exception as e:
                self.send_error_json(e)
            return

        # 5. 官方数据库请求代理转发 (附带 Bearer Token 与合法 Origin，突破浏览器限制)
        if self.path.startswith("/api/apple/"):
            apple_path = self.path[len("/api/apple/"):]
            apple_url = f"https://api.music.apple.com/{apple_path}"
            try:
                req = urllib.request.Request(apple_url, headers={
                    "Authorization": f"Bearer {DEFAULT_TOKEN}",
                    "Origin": "https://music.apple.com",
                    "User-Agent": USER_AGENT
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
                self.send_error_json(e)
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
