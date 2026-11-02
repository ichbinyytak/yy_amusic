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

def is_valid_adam_id(val):
    """判断是否为合法有效的 Apple Adam ID (以 pl. 开头或至少 6 位纯数字)"""
    if not val:
        return False
    s = str(val).strip()
    return s.startswith("pl.") or (s.isdigit() and len(s) >= 6)

def parse_card_item(it, sec_title=""):
    """统一解析 Apple Music 卡片项目，提取标题、副标、类型、直链和合法 storeAdamID"""
    desc = it.get('contentDescriptor') or {}
    raw_kind = (desc.get('kind') or it.get('itemKind') or '').strip()
    title = it.get('title') or (it.get('titleLinks', [{}])[0].get('title') if it.get('titleLinks') else '')
    subtitle = it.get('subtitle') or (it.get('subtitleLinks', [{}])[0].get('title') if it.get('subtitleLinks') else '')
    
    # 优先提取官方 storeAdamID，严禁接受 hero-list-shelf / brick-swoosh 等 DOM 内部标签
    raw_adam = desc.get('identifiers', {}).get('storeAdamID')
    adam_id = str(raw_adam).strip() if is_valid_adam_id(raw_adam) else ''
    
    # 获取有效 URL 直链
    url = desc.get('url') or ''
    if not url and it.get('titleLinks'):
        url = it['titleLinks'][0].get('segue', {}).get('destination', {}).get('contentDescriptor', {}).get('url', '')
    if not url and it.get('segue'):
        url = it['segue'].get('destination', {}).get('contentDescriptor', {}).get('url', '')
    if not url and it.get('contentDescriptor'):
        url = it['contentDescriptor'].get('url', '')

    # 若缺少 adam_id 则从真实 URL 中提取
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

    # 精确判断资源类型（严防将单曲 song 或视频、电台误归类为专辑）
    rk = raw_kind.lower()
    if rk == 'song' or '?i=' in url:
        kind = 'song'
    elif rk in ['playlist', 'uploaded-playlist'] or str(adam_id).startswith('pl.') or '/playlist/' in url:
        kind = 'playlist'
    elif rk in ['album', 'record'] or ('/album/' in url and '?i=' not in url):
        kind = 'album'
    elif rk in ['curator', 'applecurator'] or '/curator/' in url:
        kind = 'curator'
    elif rk in ['musicvideo', 'video', 'post', 'radiostation', 'station', 'artist', 'brick', 'artistuploadedvideo']:
        kind = rk
    else:
        if adam_id and str(adam_id).startswith('pl.'):
            kind = 'playlist'
        elif adam_id and str(adam_id).isdigit():
            kind = 'album'
        else:
            kind = 'playlist' if 'playlist' in url else ('album' if 'album' in url else (rk or 'other'))

    return {
        'type': kind,
        'kind': kind,
        'title': title,
        'curator': subtitle or 'Apple Music',
        'heading': it.get('heading', ''),
        'desc': sec_title if sec_title else '',
        'id': adam_id if is_valid_adam_id(adam_id) else None,
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
                    'title': sec_title,
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
                # 规则 2：专辑与歌单板块完整收录，严格过滤非音乐内容和无真实 ID 的宣传卡片
                valid_items = []
                for it in items:
                    card = parse_card_item(it, sec_title)
                    if card['kind'] in ['playlist', 'album'] and card['title'] and card.get('id'):
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
                    # 过滤已失效或无法作为 Web 专区访问的条目 (如 itunes 遗留链接或空链接)
                    if not card_url or 'itunes.apple.com' in card_url:
                        continue
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

            # 细分歌曲与歌单/专辑板块，严格过滤非音乐实体
            song_items = []
            collection_items = []
            for it in items:
                card = parse_card_item(it, sec_title)
                if not card['title']:
                    continue
                if card['kind'] == 'song':
                    song_items.append(card)
                elif card['kind'] in ['playlist', 'album'] and card.get('id'):
                    collection_items.append(card)

            if song_items:
                tracks_list = []
                for idx_tr, it in enumerate(song_items, 1):
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
            elif collection_items:
                sections_out.append({
                    'title': sec_title,
                    'items': collection_items
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
