#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apple_catalog.py - Apple Music 页面解构与专区数据爬虫中枢
包含：
1. Apple SSR 结构化数据提取引擎 (extract_ssr_data)
2. 卡片与板块统一映射解析 (parse_card_item)
3. /new 页面官方精选与主推歌单解构 (fetch_apple_new_page)
4. /search 探索中枢 50+ 个音乐专区抓取 (fetch_apple_search_page)
5. 专区主页 / 排行榜真实板块抓取 (fetch_apple_curator_page)
6. 官方专题 Room 完整曲目抓取 (fetch_apple_room)
"""

import json
import re
import urllib.request
import urllib.parse

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

def http_get_html(url, timeout=15):
    """发起 HTTP GET 请求抓取 HTML 页面 (自动安全转义中文等非 ASCII URL)"""
    safe_url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=")
    req = urllib.request.Request(safe_url, headers={"User-Agent": USER_AGENT})
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
    if not url and it.get('segue'):
        url = it['segue'].get('destination', {}).get('contentDescriptor', {}).get('url', '')
    if not url and it.get('contentDescriptor'):
        url = it['contentDescriptor'].get('url', '')

    if not adam_id and url:
        m_pl = re.search(r'(pl\.[a-zA-Z0-9]+)', url)
        if m_pl:
            adam_id = m_pl.group(1)
        else:
            m_id = re.search(r'/(?:album|playlist|curator)/[^/]+/([0-9]{6,})', url)
            if m_id:
                adam_id = m_id.group(1)
            else:
                m_end = re.search(r'/([0-9]{6,})(?:\?|$)', url)
                if m_end:
                    adam_id = m_end.group(1)

    if not kind:
        if 'playlist' in url or (adam_id and str(adam_id).startswith('pl.')):
            kind = 'playlist'
        elif 'album' in url:
            kind = 'album'
        else:
            kind = 'playlist'

    return {
        'type': kind,
        'kind': kind,
        'title': title,
        'curator': subtitle or 'Apple Music',
        'heading': it.get('heading', ''),
        'desc': sec_title if sec_title else '',
        'id': adam_id,
        'url': url
    }

def fetch_apple_new_page(storefront="cn"):
    """
    抓取 /new 页面并严格重构为【歌单/专辑】聚合实体。
    单曲类板块（如新歌精选、正在流行中）自动升格为官方精选合集歌单。
    """
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

    return {"storefront": storefront, "sections": sections_out}

def fetch_apple_search_page(storefront="cn"):
    """
    抓取 /search 探索中枢，提取官方 50+ 个音乐专区 (Curator 与专区分类)
    """
    html = http_get_html(f"https://music.apple.com/{storefront}/search")
    d = extract_ssr_data(html, "data")
    categories = []

    if d:
        sections = d.get('data', [{}])[0].get('data', {}).get('sections', [])
        for sec in sections:
            for it in sec.get('items', []):
                card = parse_card_item(it)
                if card['title'] and card['id']:
                    card_url = card['url']
                    if card['title'] == '排行榜' or card['id'] == '1514706977' or 'viewTop' in card_url:
                        card_url = f"https://music.apple.com/{storefront}/new/top-charts"
                    categories.append({
                        'title': card['title'],
                        'id': card['id'],
                        'kind': card['kind'],
                        'url': card_url
                    })

    return {"storefront": storefront, "categories": categories}

def fetch_apple_curator_page(url):
    """
    深度抓取 Apple Music 官方专区主页 (如 /curator/apple-music-国语流行/1019400042 或 /new/top-charts 排行榜)
    100% 还原官网的焦点推荐、歌单、年度热门、明星曲目单与经典专辑等板块
    """
    if 'viewTop' in url or 'top-charts' in url or '1514706977' in url:
        m_sf = re.search(r'music\.apple\.com/([a-z]{2})/', url)
        sf = m_sf.group(1) if m_sf else 'cn'
        url = f"https://music.apple.com/{sf}/new/top-charts"

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
                if card['kind'] in ['playlist', 'album', 'song'] and card['title']:
                    valid_items.append(card)

            if valid_items:
                is_song_section = any(it['kind'] == 'song' for it in valid_items)
                if is_song_section:
                    tracks_list = []
                    for idx_tr, it in enumerate(valid_items, 1):
                        tracks_list.append({
                            'index': idx_tr,
                            'name': it['title'],
                            'artist': it['curator'],
                            'album': sec_title,
                            'durationMillis': 0,
                            'url': it['url']
                        })
                    sections_out.append({
                        'title': sec_title,
                        'items': [{
                            'kind': 'curated',
                            'type': 'curated',
                            'title': f"{sec_title} Top {len(tracks_list)}",
                            'curator': 'Apple Music 官方编辑',
                            'heading': '官方热门排行合集',
                            'desc': f"{sec_title} 完整收录 {len(tracks_list)} 首上榜热门金曲",
                            'trackCount': len(tracks_list),
                            'tracks': tracks_list,
                            'roomUrl': '',
                            'url': url
                        }]
                    })
                else:
                    sections_out.append({
                        'title': sec_title,
                        'items': valid_items
                    })

    return {"url": url, "sections": sections_out}

def fetch_apple_room(room_url):
    """
    抓取 Apple Music 官方专题 Room (如新歌精选 100 首曲目大合集)
    """
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

    return tracks
