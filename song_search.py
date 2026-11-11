#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
========================================================
模块：song_search.py - 歌曲检索、系统级 OpenCC 繁简转换与多维容错打分过滤模块
核心接口：to_simple, calculate_song_match_score, search_candidates, get_song_lyric
依赖协同：系统原生 libopencc.so, source_manager.py, server.py
--------------------------------------------------------
核心原则：
  1. 极简与极轻量：纯 Python 标准库 + 原生 C 库直连，0 pip 外部依赖
  2. 系统原生 OpenCC 繁简自动转化：词组级繁简对齐，单次调用 < 0.05ms
  3. 工业级多维容错打分漏斗：
     - 支持错别字、漏字、多字（SequenceMatcher 模糊比对）
     - 支持歌手语序颠倒（无序 Token 集合交集对齐）
     - 负面词大额重罚 (-60 分，绝对拦截翻唱/伴奏/DJ)
  4. 双通道并发检索：酷我 + 网易云同时搜曲，耗时取决于最快通道
--------------------------------------------------------
功能目录：
  1. 系统原生 OpenCC 繁简转换与词条清洗 (to_simple / clean_brackets)
  2. 工业级多维加权打分模型 (calculate_song_match_score)
  3. 酷我与网易云双通道并发搜索 (search_candidates / _search_kuwo / _search_netease)
  4. 时间轴歌词直通提取与秒级解析 (get_song_lyric / _parse_lrc_text)
========================================================
"""

import os
import sys
import re
import json
import time
import ctypes
import threading
import difflib
import hashlib
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from net_pool import http_get
from lyric_service import get_song_lyric, _parse_lrc_text

# 咪咕容灾状态
_MG_SEARCH_FAILS = 0
_MG_SEARCH_LAST_FAIL = 0.0

# ========================================================
# 区块 1: 系统原生 OpenCC 繁简转换引擎 (调用 libopencc.so, 0.05ms)
# ========================================================
_opencc_lock = threading.Lock()
_opencc_convert = None

for _libname in ['libopencc.so.1.1', 'libopencc.so.1', 'libopencc.so']:
    try:
        _lib = ctypes.cdll.LoadLibrary(_libname)
        _new = _lib.opencc_open
        _new.restype = ctypes.c_void_p
        _new.argtypes = [ctypes.c_char_p]
        _conv = _lib.opencc_convert_utf8
        _conv.restype = ctypes.c_void_p
        _conv.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
        _free = _lib.opencc_convert_utf8_free
        _free.argtypes = [ctypes.c_void_p]

        _inst = _new(b't2s.json')  # 繁体转简体配置
        if _inst:
            def _c_opencc_worker(text: str) -> str:
                if not text:
                    return ""
                with _opencc_lock:
                    tb = text.encode('utf-8')
                    p = _conv(_inst, tb, len(tb))
                    if p:
                        s = ctypes.cast(p, ctypes.c_char_p).value.decode('utf-8')
                        _free(p)
                        return s
                return text
            _opencc_convert = _c_opencc_worker
            break
    except Exception:
        continue

# 6.2 备用应急流行音乐高频字典（在无 libopencc 环境下平滑降级，覆盖常见歌名、歌手与流行词汇）
FALLBACK_CHAR_MAP = {
    # 常用人称/虚词/疑问
    '愛': '爱', '聽': '听', '個': '个', '們': '们', '樂': '乐', '風': '风',
    '飛': '飞', '時': '时', '說': '说', '這': '这', '陽': '阳', '頭': '头',
    '點': '点', '為': '为', '與': '与', '華': '华', '語': '语', '開': '开',
    '闊': '阔', '轉': '转', '移': '移', '後': '后', '話': '话', '過': '过',
    '妳': '你', '祂': '他', '誰': '谁', '麼': '么', '幾': '几', '樣': '样',
    '給': '给', '從': '从', '著': '着', '裡': '里', '邊': '边', '還': '还',
    '讓': '让', '將': '将', '當': '当', '處': '处', '極': '极', '該': '该',
    # 音乐情感/歌名词汇
    '傑': '杰', '倫': '伦', '葉': '叶', '烏': '乌', '醬': '酱', '氣': '气',
    '體': '体', '認': '认', '紅': '红', '溫': '温', '廣': '广', '遠': '远',
    '蕭': '萧', '員': '员', '數': '数', '簡': '简', '單': '单', '約': '约',
    '楓': '枫', '臺': '台', '髮': '发', '長': '长', '電': '电', '課': '课',
    '寫': '写', '號': '号', '誇': '夸', '車': '车', '損': '损', '輪': '轮',
    '艷': '艳', '豔': '艳', '鍾': '钟', '戀': '恋', '續': '续', '歲': '岁', '輝': '辉',
    '歡': '欢', '軌': '轨', '跡': '迹', '無': '无', '虛': '虚', '遙': '遥',
    '傷': '伤', '執': '执', '願': '愿', '書': '书', '領': '领', '寬': '宽',
    '難': '难', '顏': '颜', '現': '现', '網': '网', '餓': '饿', '傳': '传',
    '蘭': '兰', '護': '护', '變': '变', '舊': '旧', '夢': '梦', '會': '会',
    '廳': '厅', '講': '讲', '見': '见', '霧': '雾', '捨': '舍', '練': '练',
    '習': '习', '謝': '谢', '對': '对', '動': '动', '喚': '唤', '櫻': '樱',
    '煉': '炼', '沒': '没', '險': '险', '擁': '拥', '凍': '冻', '窩': '窝',
    '寧': '宁', '絲': '丝', '親': '亲', '條': '条', '歐': '欧', '隱': '隐',
    '遺': '遗', '綠': '绿', '懷': '怀', '類': '类', '箏': '筝', '淚': '泪',
    '詩': '诗', '運': '运', '懸': '悬', '曉': '晓', '諷': '讽', '滿': '满',
    '貓': '猫', '熱': '热', '麗': '丽', '國': '国', '萬': '万', '觸': '触',
    '鳥': '鸟', '團': '团', '強': '强', '隊': '队', '嬌': '娇', '乾': '干',
    '幹': '干', '陣': '阵', '孫': '孙', '張': '张', '學': '学', '劉': '刘',
    '羅': '罗', '陳': '陈', '憶': '忆', '蓮': '莲', '鄧': '邓', '譚': '谭',
    '詠': '咏', '駒': '驹', '黃': '黄', '騰': '腾', '瑋': '玮', '謙': '谦',
    '榮': '荣', '瀧': '泷', '許': '许', '瑩': '莹', '緯': '纬', '兒': '儿',
    '鋒': '锋', '蘇': '苏', '吳': '吴', '東': '东', '褲': '裤', '權': '权',
    '龜': '龟', '蝟': '猬', '盤': '盘', '達': '达', '鯊': '鲨', '魚': '鱼',
    '雙': '双', '歷': '历', '戰': '战', '聲': '声', '譜': '谱', '響': '响',
    '義': '义', '諾': '诺', '擔': '担', '負': '负', '責': '责', '慶': '庆',
    '祝': '祝', '賀': '贺', '頌': '颂', '讚': '赞', '錄': '录', '載': '载',
    '頁': '页', '標': '标', '題': '题', '節': '节', '斷': '断', '規': '规',
    '則': '则', '態': '态', '圖': '图', '範': '范', '屬': '属', '門': '门',
    '階': '阶', '級': '级', '徑': '径', '街': '街', '鎮': '镇', '鄉': '乡',
    '區': '区', '際': '际', '置': '置', '積': '积', '價': '价', '費': '费',
    '錢': '钱', '幣': '币', '資': '资', '產': '产', '業': '业', '務': '务',
    '職': '职', '術': '术', '藝': '艺', '勞': '劳', '績': '绩', '滅': '灭',
    '興': '兴', '衰': '衰', '敗': '败', '增': '增', '減': '减', '損': '损',
    '優': '优', '惡': '恶', '剛': '刚', '貧': '贫', '聰': '聪', '裝': '装',
    '濤': '涛', '嶺': '岭', '樹': '树', '塵': '尘', '淺': '浅', '境': '境',
    '尋': '寻', '覓': '觅', '藏': '藏', '經': '经', '換': '换', '繫': '系',
    '結': '结', '釋': '释', '覺': '觉', '撐': '撑', '渡': '渡', '越': '越',
    '墜': '坠', '盪': '荡', '搖': '摇', '擺': '摆', '奏': '奏', '畫': '画',
    '繪': '绘', '識': '识', '辨': '辨', '濃': '浓', '涼': '凉', '實': '实',
    '潔': '洁', '殘': '残', '缺': '缺', '圓': '圆', '億': '亿', '隻': '只',
    '場': '场', '關': '关', '閃': '闪', '閉': '闭', '問': '问', '間': '间',
    '鬧': '闹', '聞': '闻', '閣': '阁', '閱': '阅', '閻': '阎', '闌': '阑',
    '闖': '闯', '颱': '台', '飄': '飘', '馬': '马', '馳': '驰', '駐': '驻',
    '駕': '驾', '騎': '骑', '騙': '骗', '驗': '验', '驚': '惊', '驛': '驿',
    '鳴': '鸣', '鳳': '凤', '鵝': '鹅', '鵑': '鹃', '鵬': '鹏', '鶴': '鹤',
    '鷹': '鹰', '鮮': '鲜', '鯉': '鲤', '鯨': '鲸', '齊': '齐', '龍': '龙',
    '龐': '庞', '計': '计', '訊': '讯', '討': '讨', '訓': '训', '託': '托',
    '記': '记', '訝': '讶', '訟': '讼', '訣': '诀', '設': '设', '訴': '诉',
    '診': '诊', '註': '注', '證': '证', '詞': '词', '詔': '诏', '譯': '译',
    '試': '试', '詳': '详', '誠': '诚', '誤': '误', '誦': '诵', '誰': '谁',
    '調': '调', '諒': '谅', '請': '请', '諸': '诸', '謀': '谋', '謊': '谎',
    '謎': '谜', '謠': '谣', '謗': '谤', '謹': '谨', '議': '议', '鋼': '钢',
    '鐵': '铁', '銅': '铜', '銀': '银', '鈴': '铃', '鍵': '键', '針': '针',
    '鉛': '铅', '鏡': '镜', '鎖': '锁', '鏈': '链', '鍋': '锅', '銳': '锐',
    '錄': '录', '錦': '锦', '錯': '错', '錫': '锡', '鑼': '锣', '錘': '锤'
}

def to_simple(text: str) -> str:
    """文本标准化：原生 OpenCC 繁转简 -> 小写 -> 剥离首尾空白"""
    if not text:
        return ""
    if _opencc_convert:
        try:
            return _opencc_convert(text).lower().strip()
        except Exception as e:
            # print("kw lyric error:", e)
            pass
    # 降级备用
    res = [FALLBACK_CHAR_MAP.get(ch, ch) for ch in text]
    return "".join(res).lower().strip()

def clean_brackets(text: str) -> str:
    """剔除括号及括号内的修饰词，剥离 Remastered / Live 等非核心词"""
    return re.sub(r'[\(（\[【].*?[\)）\]】]', '', text or '').strip()

def clean_punctuation(text: str) -> str:
    """剔除所有标点符号和空格，保留纯字词"""
    return re.sub(r'[\s\-_·\.,，。、!！?？~～:：/\\&+\'"]+', '', text or '')


# ========================================================
# 区块 2: 工业级多维加权打分模型 (0 ~ 100 分，及格线 60 分)
# ========================================================

def calculate_song_match_score(cand_title: str, cand_artist: str, cand_album: str = "",
                               target_title: str = "", target_artist: str = "",
                               cand_duration=None, target_duration=None) -> tuple:
    """
    加权综合评分：
    1. 负面词大额重罚 (-60 分)：凡命中 Cover/翻唱/伴奏/DJ，一票否决淘汰！
    2. 歌名核心词及模糊相似度 (最高 45 分)：
       - 完全相等 -> 45 分
       - 包含关系 -> 38 分
       - 字符相似度 (容忍错字/漏字，SequenceMatcher ratio >= 0.65) -> 25~35 分
    3. 歌手无序 Token 集合交集匹配 (最高 35 分，解决合唱、语序、多人别名)
    4. 专辑契合度 (最高 10 分)
    5. 音轨时长物理容差 (最高 10 分，误差 <= 5秒加分，偏差 > 25秒扣 25分)
    返回: (score: float, is_match: bool) -> score >= 60.0 为正版及格
    """
    t_simp = to_simple(cand_title)
    art_simp = to_simple(cand_artist)
    alb_simp = to_simple(cand_album)

    tgt_t_simp = to_simple(target_title)
    tgt_art_simp = to_simple(target_artist)

    score = 0.0

    # 1. 负面词重罚 (-60 分)
    forbidden_kws = [
        'cover', '翻唱', '伴奏', '伴奏版', '纯伴奏', 'instrumental',
        'remix', 'dj', '电音版', '慢摇', '降调', '升调', '片段', '铃声',
        '治愈版', '正式版', '抖音版', '热播版', '加速版'
    ]
    target_all = f"{tgt_t_simp} {tgt_art_simp}"
    for kw in forbidden_kws:
        if kw in f"{t_simp} {alb_simp} {art_simp}" and kw not in target_all:
            score -= 60.0
            break

    # 2. 歌名核心词及容错相似度 (最高 45 分)
    if target_title:
        c_clean = clean_punctuation(clean_brackets(t_simp))
        t_clean = clean_punctuation(clean_brackets(tgt_t_simp))

        if c_clean and t_clean:
            if c_clean == t_clean:
                score += 45.0
            elif c_clean in t_clean or t_clean in c_clean:
                score += 38.0
            else:
                # 兼容单字助词差异（如“雨后” vs “雨过后”）
                t_core = re.sub(r'[过后的之了]+', '', t_clean)
                c_core = re.sub(r'[过后的之了]+', '', c_clean)
                if t_core and c_core and (t_core in c_core or c_core in t_core):
                    score += 35.0
                else:
                    # SequenceMatcher 编辑相似度与字符集合重合度（解决错别字、漏字）
                    sim_ratio = difflib.SequenceMatcher(None, c_clean, t_clean).ratio()
                    common_set = set(c_clean) & set(t_clean)
                    jaccard = len(common_set) / max(len(set(c_clean)), len(set(t_clean)), 1)
                    best_sim = max(sim_ratio, jaccard)

                    if best_sim >= 0.5:
                        score += 35.0 * best_sim
    else:
        score += 25.0

    # 3. 歌手无序 Token 集合交集对齐 (最高 35 分)
    if target_artist:
        c_tokens = [a.strip() for a in re.split(r'[/,、&+\s\(\)（）]+', art_simp) if a.strip()]
        t_tokens = [a.strip() for a in re.split(r'[/,、&+\s\(\)（）]+', tgt_art_simp) if a.strip()]

        matched_tokens = 0
        for t in t_tokens:
            if any(t == ct or (len(t) >= 2 and (t in ct or ct in t)) for ct in c_tokens):
                matched_tokens += 1
            elif t in art_simp or art_simp in t:
                matched_tokens += 0.8
            else:
                # 歌手错别字容错
                if any(difflib.SequenceMatcher(None, t, ct).ratio() >= 0.75 for ct in c_tokens):
                    matched_tokens += 0.8

        token_ratio = min(1.0, matched_tokens / max(1, len(t_tokens))) if t_tokens else 0.5
        score += 35.0 * token_ratio
    else:
        score += 20.0

    # 4. 专辑契合度 (最高 10 分)
    if cand_album and len(alb_simp) > 1:
        score += 10.0

    # 5. 音轨时长物理容差 (借鉴 UnblockNeteaseMusic 时长门禁)
    if cand_duration and target_duration:
        try:
            c_d = float(cand_duration)
            t_d = float(target_duration)
            if c_d > 0 and t_d > 0:
                diff = abs(c_d - t_d)
                if diff <= 4:
                    score += 10.0
                elif diff <= 8:
                    score += 5.0
                elif diff > 15:
                    score -= 80.0  # 绝对拦截翻唱、加长版、DJ版、Live现场与截断残卷
                elif diff > 10:
                    score -= 25.0
        except Exception as e:
            pass

    return score, (score >= 60.0)


# ========================================================
# 区块 3: 五大天王全息并发检索与聚合打分 (QQ + 酷我 + 网易 + 酷狗 + 咪咕)
# ========================================================

def _search_kuwo(query_k: str, target_title: str, target_artist: str, limit: int, target_duration = None) -> list:
    """酷我轻量检索通道"""
    res = []
    # 1. 优先官方轻量接口 (放宽至 1.8s 消除跨洋假超时，Keep-Alive 复用)
    try:
        url_kw = f"https://search.kuwo.cn/r.s?client=kt&all={urllib.parse.quote(query_k)}&pn=0&rn={limit}&uid=794762528&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newsearch=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1"
        st, raw_bytes, _, _ = http_get(url_kw, headers={'User-Agent': 'okhttp/3.10.0'}, timeout=1.8)
        if st == 200 and raw_bytes:
            data = json.loads(raw_bytes.decode('utf-8', errors='ignore'))
            for it in data.get('abslist', []):
                sname = it.get('SONGNAME', '')
                sart = it.get('ARTIST', '')
                salb = it.get('ALBUM', '')
                sdur = it.get('DURATION')
                rid = it.get('MUSICRID', '').replace('MUSIC_', '')
                score, ok = calculate_song_match_score(sname, sart, salb, target_title, target_artist, sdur, target_duration=target_duration)
                if ok and rid:
                    res.append({
                        "platform": "kw",
                        "id": rid,
                        "title": sname,
                        "artist": sart,
                        "album": salb,
                        "duration": sdur,
                        "score": round(score, 1)
                    })
    except Exception:
        pass

    # 2. 若官方接口受跨国机房阻断，平滑调用海外高可用通道
    if not res:
        try:
            url_yh = f"https://api.yaohud.cn/api/music/kuwo?key=nvgKtvzw7CFSNFrDhA6&action=search&msg={urllib.parse.quote(query_k)}&n=1"
            st, raw_bytes, _, _ = http_get(url_yh, headers={'User-Agent': 'Mozilla/5.0'}, timeout=1.5)
            if st == 200 and raw_bytes:
                data = json.loads(raw_bytes.decode('utf-8', errors='ignore'))
                d = data.get("data", {})
                if d and d.get("name"):
                    sname = d.get("name", "")
                    sart = d.get("songname", "")
                    salb = d.get("album", "")
                    score, ok = calculate_song_match_score(sname, sart, salb, target_title, target_artist, target_duration=target_duration)
                    if ok:
                        res.append({
                            "platform": "kw",
                            "id": f"kw_{hashlib.md5(f'{sname}_{sart}'.encode()).hexdigest()[:8]}",
                            "title": sname,
                            "artist": sart,
                            "album": salb,
                            "score": round(score, 1)
                        })
        except Exception:
            pass
    return res

def _search_netease(query_k: str, target_title: str, target_artist: str, limit: int, target_duration = None) -> list:
    """网易云轻量检索通道"""
    res = []
    try:
        url_ne = f"https://music.163.com/api/search/get?s={urllib.parse.quote(query_k)}&type=1&offset=0&limit={limit}"
        st, raw_bytes, _, _ = http_get(url_ne, headers={'User-Agent': 'Mozilla/5.0'}, timeout=2.0)
        if st == 200 and raw_bytes:
            data = json.loads(raw_bytes.decode('utf-8', errors='ignore'))
            for s in data.get('result', {}).get('songs', []):
                sname = s.get('name', '')
                sart = "/".join([a.get('name', '') for a in s.get('artists', []) if a.get('name')])
                salb = s.get('album', {}).get('name', '')
                sdur = round(s.get('duration', 0) / 1000) if s.get('duration') else None
                sid = str(s.get('id', ''))
                score, ok = calculate_song_match_score(sname, sart, salb, target_title, target_artist, sdur, target_duration=target_duration)
                if ok and sid:
                    res.append({
                        "platform": "wy",
                        "id": sid,
                        "title": sname,
                        "artist": sart,
                        "album": salb,
                        "duration": sdur,
                        "score": round(score, 1)
                    })
    except Exception:
        pass
    return res

def _search_qq(query_k: str, target_title: str, target_artist: str, limit: int = 5, target_duration = None) -> list:
    """QQ 音乐轻量公开检索通道 (TME 旗舰核心，张艺兴等独家正版，海外极稳)"""
    res = []
    try:
        url_qq = f"https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n={limit}&w={urllib.parse.quote(query_k)}&format=json"
        st, raw_bytes, _, _ = http_get(url_qq, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}, timeout=2.0)
        if st == 200 and raw_bytes:
            data = json.loads(raw_bytes.decode('utf-8', errors='ignore'))
            for s in data.get('data', {}).get('song', {}).get('list', []):
                sname = s.get('songname', '')
                sart = "/".join([a.get('name', '') for a in s.get('singer', []) if a.get('name')])
                salb = s.get('albumname', '')
                sdur = s.get('interval')
                smid = s.get('songmid', '')
                if not smid:
                    continue
                score, ok = calculate_song_match_score(sname, sart, salb, target_title, target_artist, sdur, target_duration=target_duration)
                if ok:
                    res.append({
                        "platform": "tx",
                        "id": smid,
                        "songmid": smid,
                        "title": sname,
                        "artist": sart,
                        "album": salb,
                        "duration": sdur,
                        "score": round(score, 1)
                    })
    except Exception:
        pass
    return res

def _search_kugou(query_k: str, target_title: str, target_artist: str, limit: int = 5, target_duration = None) -> list:
    """酷狗音乐轻量公开检索通道"""
    res = []
    try:
        url_kg = f"https://songsearch.kugou.com/song_search_v2?keyword={urllib.parse.quote(query_k)}&page=1&pagesize={limit}&filter=2&iscorrection=1"
        st, raw_bytes, _, _ = http_get(url_kg, headers={'User-Agent': 'Mozilla/5.0'}, timeout=2.0)
        if st == 200 and raw_bytes:
            data = json.loads(raw_bytes.decode('utf-8', errors='ignore'))
            for item in data.get('data', {}).get('lists', []):
                sname = re.sub(r'<.*?>', '', item.get('SongName', '')).strip()
                sart = re.sub(r'<.*?>', '', item.get('SingerName', '')).strip()
                salb = re.sub(r'<.*?>', '', item.get('AlbumName', '')).strip()
                sdur = item.get('Duration')
                fhash = item.get('FileHash', '')
                if not fhash:
                    continue
                score, ok = calculate_song_match_score(sname, sart, salb, target_title, target_artist, sdur, target_duration=target_duration)
                if ok:
                    res.append({
                        "platform": "kg",
                        "id": fhash,
                        "songmid": fhash,
                        "title": sname,
                        "artist": sart,
                        "album": salb,
                        "duration": sdur,
                        "score": round(score, 1)
                    })
    except Exception:
        pass
    return res

def _search_migu(query_k: str, target_title: str, target_artist: str, limit: int = 5, target_duration = None) -> list:
    """咪咕音乐国家队检索通道 (带海外阻断快速熔断)"""
    global _MG_SEARCH_FAILS, _MG_SEARCH_LAST_FAIL
    if _MG_SEARCH_FAILS >= 2 and (time.time() - _MG_SEARCH_LAST_FAIL) < 300:
        return []
    res = []
    try:
        url_mg = f"https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?runmode=prod&text={urllib.parse.quote(query_k)}&pageNo=1&pageSize={limit}&searchSwitch=%7B%22song%22%3A1%7D"
        st, raw_bytes, _, _ = http_get(url_mg, headers={'User-Agent': 'Mozilla/5.0', 'channel': '0146951'}, timeout=1.5)
        if st == 200 and raw_bytes:
            data = json.loads(raw_bytes.decode('utf-8', errors='ignore'))
            _MG_SEARCH_FAILS = 0
            for item in data.get('songResultData', {}).get('result', []):
                sname = item.get('name', '').strip()
                sart = "/".join([a.get('name', '') for a in item.get('singers', []) if a.get('name')]).strip()
                salb = item.get('albums', [{}])[0].get('name', '') if item.get('albums') else ''
                sdur = item.get('interval')
                cid = item.get('copyrightId') or item.get('id', '')
                if not cid:
                    continue
                score, ok = calculate_song_match_score(sname, sart, salb, target_title, target_artist, sdur, target_duration=target_duration)
                if ok:
                    res.append({
                        "platform": "mg",
                        "id": str(cid),
                        "songmid": str(cid),
                        "title": sname,
                        "artist": sart,
                        "album": salb,
                        "duration": sdur,
                        "score": round(score, 1)
                    })
        else:
            _MG_SEARCH_FAILS += 1
            _MG_SEARCH_LAST_FAIL = time.time()
    except Exception:
        _MG_SEARCH_FAILS += 1
        _MG_SEARCH_LAST_FAIL = time.time()
    return res

def search_candidates(keyword: str, target_artist: str = "", limit: int = 8, target_title: str = "", target_duration = None) -> list:
    """
    轻量快速检索歌曲候选列表，全链路经过繁转简与高容错打分清洗
    【五路全息并发】：QQ(tx) + 酷我(kw) + 网易云(wy) + 酷狗(kg) + 咪咕(mg) 同时并发冲刺，单次超时 2.0s
    彻底废除原地打转重试，耗时仅由最快返回的通道决定 (通常仅需 200~400ms)
    """
    # 1. 规范化输入：OpenCC 繁转简
    simplified_k = to_simple(clean_brackets(keyword))
    if not simplified_k:
        return []

    # 2. 智能提取目标标题与目标歌手（支持短横线 -、空格、下划线、斜杠等分隔符）
    if target_title:
        target_title = to_simple(clean_brackets(target_title))
        target_artist = to_simple(target_artist) if target_artist else ""
    elif not target_artist:
        split_parts = re.split(r'\s*[\-_/|]\s*|\s+', simplified_k)
        split_parts = [p.strip() for p in split_parts if p.strip()]
        if len(split_parts) >= 2:
            target_title = " ".join(split_parts[:-1])
            target_artist = split_parts[-1]
        else:
            target_title = simplified_k
            target_artist = ""
    else:
        target_title = simplified_k
        target_artist = to_simple(target_artist)

    # 清理查询词中的连接符号与减号，避免音源平台将 "-" 误判为逻辑 NOT 排除词导致搜空
    query_k = re.sub(r'[\-_&/、+|]+', ' ', simplified_k).strip()
    if not query_k:
        query_k = simplified_k

    # 核心优化：若包含目标歌手且检索词中尚未显式包含，自动追加歌手名以确保五大平台首位命中正版原唱
    if target_artist and target_artist not in query_k:
        query_k = f"{query_k} {target_artist}".strip()

    # 3. 极速全息三路并发检索 (酷我 + 网易云 + 酷狗 原生秒开通道，严控 2.0s 预算，互为同门与跨版权备份)
    results = []
    try:
        with ThreadPoolExecutor(max_workers=3) as executor:
            f_kw = executor.submit(_search_kuwo, query_k, target_title, target_artist, limit, target_duration)
            f_ne = executor.submit(_search_netease, query_k, target_title, target_artist, limit, target_duration)
            f_kg = executor.submit(_search_kugou, query_k, target_title, target_artist, limit, target_duration)
            try:
                results.extend(f_kw.result(timeout=2.0))
            except Exception:
                pass
            try:
                results.extend(f_ne.result(timeout=2.0))
            except Exception:
                pass
            try:
                results.extend(f_kg.result(timeout=2.0))
            except Exception:
                pass
    except Exception:
        pass

    # 若酷我与网易云首轮均搜空（如独家版权或冷门专区），平滑查询 QQ 音乐补漏
    if not results:
        try:
            results.extend(_search_qq(query_k, target_title, target_artist, 5, target_duration=target_duration))
        except Exception:
            pass

    # 智能降维：针对多歌手合唱、长括号修饰词或 feat 合作曲目，提取主艺人与纯净歌名进行重试
    if not results and target_artist:
        primary_artist = re.split(r'[,/&、]|feat\.?', target_artist, flags=re.IGNORECASE)[0].strip()
        primary_artist = clean_brackets(primary_artist).strip()
        clean_t = clean_brackets(target_title).strip()
        if primary_artist and clean_t and (primary_artist != target_artist or clean_t != target_title):
            sub_k = f"{clean_t} {primary_artist}"
            try:
                results.extend(_search_kuwo(sub_k, clean_t, primary_artist, limit, target_duration))
            except Exception:
                pass
            if not results:
                try:
                    results.extend(_search_netease(sub_k, clean_t, primary_artist, limit, target_duration))
                except Exception:
                    pass
            if not results:
                try:
                    results.extend(_search_qq(sub_k, clean_t, primary_artist, 5, target_duration=target_duration))
                except Exception:
                    pass

    # 排序权重：打分绝对优先；同分情况下，免 Node 原生极速通道优先调度 (kw > wy > tx > kg > mg)
    plat_priority = {"kw": 10, "wy": 8, "tx": 5, "kg": 2, "mg": 1}
    results.sort(key=lambda x: (x["score"], plat_priority.get(x["platform"], 0)), reverse=True)
    return results


def search_candidates_fallback(keyword: str, target_artist: str = "", limit: int = 5, target_title: str = "", target_duration = None) -> list:
    """
    策略 A 第二阶梯兜底检索：
    当第一阶梯（酷我/网易云/酷狗）虽然搜到但全为假音频或死链时，
    并发向 QQ 音乐与咪咕音乐发起精准补漏，挽救独家版权与老歌！
    """
    simplified_k = to_simple(clean_brackets(keyword))
    if not simplified_k:
        return []
    if target_title:
        target_title = to_simple(clean_brackets(target_title))
        target_artist = to_simple(target_artist) if target_artist else ""
    elif not target_artist:
        split_parts = re.split(r'\s*[\-_/|]\s*|\s+', simplified_k)
        split_parts = [p.strip() for p in split_parts if p.strip()]
        if len(split_parts) >= 2:
            target_title = " ".join(split_parts[:-1])
            target_artist = split_parts[-1]
        else:
            target_title = simplified_k
            target_artist = ""
    else:
        target_title = simplified_k
        target_artist = to_simple(target_artist)

    query_k = re.sub(r'[\-_&/、+|]+', ' ', simplified_k).strip() or simplified_k
    if target_artist and target_artist not in query_k:
        query_k = f"{query_k} {target_artist}".strip()

    cands = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        f_qq = executor.submit(_search_qq, query_k, target_title, target_artist, limit, target_duration)
        f_mg = executor.submit(_search_migu, query_k, target_title, target_artist, limit, target_duration)
        try:
            cands.extend(f_qq.result(timeout=2.2))
        except Exception:
            pass
        try:
            cands.extend(f_mg.result(timeout=1.8))
        except Exception:
            pass

    if not cands and target_artist:
        primary_artist = re.split(r'[,/&、]|feat\.?', target_artist, flags=re.IGNORECASE)[0].strip()
        primary_artist = clean_brackets(primary_artist).strip()
        clean_t = clean_brackets(target_title).strip()
        if primary_artist and clean_t and (primary_artist != target_artist or clean_t != target_title):
            sub_k = f"{clean_t} {primary_artist}"
            cands = _search_qq(sub_k, clean_t, primary_artist, limit, target_duration=target_duration)
            if not cands:
                cands = _search_migu(sub_k, clean_t, primary_artist, limit, target_duration=target_duration)
    cands.sort(key=lambda x: x["score"], reverse=True)
    return cands

