/**
 * ========================================================
 * 模块：player.js - 核心音乐播放引擎 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.player (MusicPlayer 单例实例)
 * 依赖协同：window.Shell, window.RightPanel, 后端 /api/resolve 与 /api/lyric
 * --------------------------------------------------------
 * 核心架构与功能目录：
 *   1. 基础音频驱动 (HTML5 Audio 实例初始化与移动端静音解锁 unlockAudio)
 *   2. W3C MediaSession 集成 (锁屏专辑封面、曲目名展示与系统/耳机硬件媒体键响应)
 *   3. 错误自愈与容灾回退 (403/超时自动切换至流媒体代理重试，连续失败智能步进下一首)
 *   4. 智能定向预拉取引擎 (70% 播放进度静默拉取下一首直链存入 LRU 缓存，实现 0ms 秒切)
 *   5. 毫秒级时间轴歌词驱动 (当前句高亮、下一句预告与双行平滑滚动同步)
 *   6. 播控状态机与历史回溯栈 (播放/暂停/上一曲/下一曲/循环模式/双向回退栈)
 * ========================================================
 */

(function (window) {
  'use strict';

  // 1. 默认播放队列初始化为空（由首次访问或记忆歌单动态注入）
  const DEFAULT_PLAYLIST = [];

  // 前端短效直链与歌词缓存配置 (直链缓存收紧至 15 分钟，彻底避免 CDN 防盗链 Token 过期导致复听 403 挂起)
  const RESOLVE_CACHE_TTL_MS = 15 * 60 * 1000;
  const RESOLVE_CACHE_MAX_ENTRIES = 50;
  const SESSION_CACHE_STORAGE_KEY = 'amusic_resolve_cache_v1';

  // 格式化秒数为 mm:ss
  const formatTime = (sec) => window.AmusicUtils ? window.AmusicUtils.formatTimeSec(sec) : "00:00";

  class MusicPlayer {
    constructor() {
      // 核心 HTML5 Audio 实例 (优先复用 DOM 上的 #mainAudio 以兼容移动端 Safari / Chrome 行内播放)
      const domAudio = typeof document !== 'undefined' ? document.getElementById("mainAudio") : null;
      this.audio = domAudio || new Audio();
      this.audio.preload = "auto";
      this.unlocked = false;
      this.savedVolume = 0.8;

      try {
        const savedVol = localStorage.getItem('amusic_volume');
        if (savedVol !== null) {
          this.audio.volume = Math.max(0, Math.min(1, parseFloat(savedVol)));
          this.savedVolume = this.audio.volume;
        } else {
          this.audio.volume = 0.8;
        }
      } catch (e) {
        this.audio.volume = 0.8;
      }

      // 歌单状态 (初始为空队列，待歌单加载后动态填入)
      this.playlist = [];
      this.currentIndex = -1;
      this.isDefaultList = false;

      // 播放模式: 'loop' (列表循环) | 'single' (单曲循环) | 'shuffle' (随机播放)
      this.playMode = 'loop';
      this.shuffledNextIndex = null;
      this.historyStack = [];

      // 状态标志
      this.isResolving = false;
      this.isPlaying = false;

      // 歌词状态
      this.lyrics = [];
      this.currentLyricIdx = -1;

      // 直链预解析与短效复听缓存 (Map: songKey -> { url, bytes, sourceName, costMs, ts, lyrics })
      this.resolveCache = new Map();
      this._loadSessionCache();
      this.prefetchTimer = null;
      this._autoSkipTimer = null;
      this._retriedProxy = false;

      // 双 Audio 预载器体系与自愈容灾 (借鉴洛雪音乐 usePreloadNextMusic.ts，实现 0ms 秒播与静默自愈)
      this.preloadAudio = null;
      this.preloadedKey = null;
      this._currentPreloadingKey = null;
      this._selfHealRetries = 0;
      this.hlsInstance = null;
      this._currentMediaSrc = "";

      // 回调钩子 (用于更新 UI)
      this.listeners = {
        trackChange: [],
        stateChange: [],
        timeUpdate: [],
        lyricUpdate: [],
        playlistChange: []
      };

      this._bindAudioEvents();
      this._initMediaSession();
    }

    // 解锁移动端与浏览器音频限制 (由用户手势触摸同步触发)
    unlockAudio() {
      if (this.unlocked || !this.audio) return;
      try {
        if (!this.audio.src) {
          this.audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
        }
        const p = this.audio.play();
        if (p && p.then) {
          p.then(() => {
            this.unlocked = true;
          }).catch(() => {});
        }
      } catch (e) {}
    }

    // 4.1 集成 W3C 标准 navigator.mediaSession 媒体中枢 (锁屏/车载/蓝牙切歌与封面)
    _initMediaSession() {
      if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

      const handlers = [
        ['play', () => this.togglePlay()],
        ['pause', () => this.togglePlay()],
        ['previoustrack', () => this.prev()],
        ['nexttrack', () => this.next()],
        ['stop', () => { try { this.audio.pause(); this.audio.currentTime = 0; } catch (e) {} }],
        ['seekto', (details) => {
          if (details && details.seekTime !== undefined && this.audio.duration) {
            this.audio.currentTime = Math.min(Math.max(0, details.seekTime), this.audio.duration);
            this._updateMediaPositionState();
          }
        }],
        ['seekbackward', (details) => {
          const skip = (details && details.seekOffset) || 10;
          this.audio.currentTime = Math.max(0, this.audio.currentTime - skip);
          this._updateMediaPositionState();
        }],
        ['seekforward', (details) => {
          const skip = (details && details.seekOffset) || 10;
          if (this.audio.duration) {
            this.audio.currentTime = Math.min(this.audio.duration, this.audio.currentTime + skip);
            this._updateMediaPositionState();
          }
        }]
      ];

      for (const [action, handler] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch (e) {
          // 浏览器未实现该特定 action，忽略
        }
      }
    }

    _updateMediaMetadata(song) {
      if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;
      if (!song) return;

      const MetaClass = window.MediaMetadata || (typeof MediaMetadata !== 'undefined' ? MediaMetadata : null);
      if (!MetaClass) return;

      const title = song.title || song.name || "未知曲目";
      const artist = song.artist || "Apple Music";
      const album = song.album || "Amusic";
      const artworkUrl = song.artwork || song.cover || song.picUrl || "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍎</text></svg>";

      try {
        navigator.mediaSession.metadata = new MetaClass({
          title: title,
          artist: artist,
          album: album,
          artwork: [
            { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '128x128', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '256x256', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }
          ]
        });
      } catch (e) {
        try {
          navigator.mediaSession.metadata = new MetaClass({
            title: title,
            artist: artist,
            album: album
          });
        } catch (err) {}
      }
    }

    _updateMediaPlaybackState(isPlaying) {
      if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;
      try {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      } catch (e) {}
    }

    _updateMediaPositionState() {
      if (typeof window === 'undefined' || !('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
      try {
        const dur = this.audio.duration;
        if (dur && !isNaN(dur) && isFinite(dur) && dur > 0) {
          navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: this.audio.playbackRate || 1.0,
            position: Math.min(Math.max(0, this.audio.currentTime || 0), dur)
          });
        }
      } catch (e) {}
    }

    _destroyHls() {
      if (this.hlsInstance) {
        try {
          this.hlsInstance.destroy();
        } catch (e) {}
        this.hlsInstance = null;
      }
    }

    _ensureHlsLoaded() {
      if (typeof window === 'undefined') return Promise.resolve(false);
      if (window.Hls) return Promise.resolve(true);
      if (this._hlsLoadPromise) return this._hlsLoadPromise;
      this._hlsLoadPromise = new Promise((resolve) => {
        const existing = document.querySelector('script[src*="hls.min.js"]');
        if (existing) {
          existing.addEventListener('load', () => resolve(!!window.Hls), { once: true });
          existing.addEventListener('error', () => resolve(false), { once: true });
          setTimeout(() => resolve(!!window.Hls), 5000);
          return;
        }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
        s.async = true;
        s.onload = () => resolve(!!window.Hls);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });
      return this._hlsLoadPromise;
    }

    _setAudioSource(url) {
      this._destroyHls();
      this._currentMediaSrc = url || "";
      if (!url) {
        try {
          this.audio.removeAttribute('src');
          this.audio.load();
        } catch (e) {}
        return;
      }

      const isHls = String(url).includes('.m3u8');
      if (isHls) {
        if (typeof window !== 'undefined' && window.Hls && window.Hls.isSupported()) {
          const hls = new window.Hls({ enableWorker: true });
          this.hlsInstance = hls;
          hls.on(window.Hls.Events.ERROR, (event, data) => {
            if (data && data.fatal) {
              console.warn("[Player] HLS fatal error:", data.type, data.details);
              this._destroyHls();
              this._handleAudioError(new Error(data.details || "HLS fatal error"));
            }
          });
          hls.loadSource(url);
          hls.attachMedia(this.audio);
          return;
        }
        if (this.audio.canPlayType && this.audio.canPlayType('application/vnd.apple.mpegurl')) {
          this.audio.src = url;
          return;
        }
        // 若 async hls.min.js 仍在下载中，异步就绪后挂载并续播
        this._ensureHlsLoaded().then((ok) => {
          if (ok && this._currentMediaSrc === url && window.Hls && window.Hls.isSupported()) {
            this._setAudioSource(url);
            this.audio.play().catch(() => {});
          }
        });
        return;
      }

      this.audio.src = url;
    }

    _handleAudioError(e) {
      const code = this.audio.error ? this.audio.error.code : 0;
      if (code === 1) return; // MEDIA_ERR_ABORTED (正常切歌中断，忽略)

      const song = this.playlist[this.currentIndex];
      const songName = song ? (song.title || song.name || "当前曲目") : "当前曲目";
      const songKey = song ? this._getSongKey(song) : null;
      if (songKey) {
        // 清除失效的直链缓存，避免后续切歌再次命中失效死链
        this._removeCachedResolve(songKey);
      }

      // 借鉴洛雪音乐自愈机制：当音频流因 403 / 防盗链 Token 失效时，静默向后端发起带 force_refresh 的换链自愈
      if (song && (this._selfHealRetries || 0) < 2) {
        this._selfHealRetries = (this._selfHealRetries || 0) + 1;
        console.warn(`[Player] 音频直链播放异常(code=${code})，尝试第 ${this._selfHealRetries} 次换链自愈: ${songName}`);
        if (typeof window !== 'undefined' && window.Shell?.showToast) {
          window.Shell.showToast(`《${songName}》音频流刷新中，正在自愈恢复...`);
        }

        const payload = {
          title: song.title || song.name || "",
          name: song.name || song.title || "",
          artist: song.artist || "",
          album: song.album || "",
          id: song.id || "",
          platform: song.platform || "",
          isrc: song.isrc || "",
          url: song.url || "",
          durationMillis: song.durationMillis,
          duration: song.duration || (song.durationMillis ? Math.round(song.durationMillis / 1000) : undefined),
          force_refresh: true
        };

        fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(r => r.json()).then(data => {
          if (data && data.success && data.url) {
            this._setAudioSource(data.url);
            const retryPlay = this.audio.play();
            if (retryPlay !== undefined) {
              retryPlay.catch(err => {
                console.warn("[Player] 自愈换链起播受限:", err);
              });
            }
            if (songKey) {
              this._setCachedResolve(songKey, {
                url: data.url,
                bytes: data.bytes,
                sourceName: data.source_name,
                costMs: 0,
                ts: Date.now(),
                lyrics: data.lyrics || this.lyrics || []
              });
            }
          } else {
            this._handleStreamFallback(song, songName, code, e);
          }
        }).catch(() => {
          this._handleStreamFallback(song, songName, code, e);
        });
        return;
      }

      this._handleStreamFallback(song, songName, code, e);
    }

    // 绑定底层音频事件
    _bindAudioEvents() {
      this.audio.addEventListener('play', () => {
        this.isPlaying = true;
        this._updateMediaPlaybackState(true);
        this._updateMediaPositionState();
        this._emit('stateChange', { isPlaying: true, isResolving: this.isResolving });
      });

      this.audio.addEventListener('playing', () => {
        this.isPlaying = true;
        this._selfHealRetries = 0; // 起播成功，重置自愈计数器
        this.autoSkipCount = 0;
        this._updateMediaPlaybackState(true);
        this._updateMediaPositionState();
      });

      this.audio.addEventListener('pause', () => {
        this.isPlaying = false;
        this._updateMediaPlaybackState(false);
        this._emit('stateChange', { isPlaying: false, isResolving: this.isResolving });
      });

      this.audio.addEventListener('timeupdate', () => {
        const cur = this.audio.currentTime || 0;
        const dur = this.audio.duration || 0;
        const pct = dur > 0 ? (cur / dur) * 100 : 0;
        this._emit('timeUpdate', {
          currentTime: cur,
          duration: dur,
          percent: pct,
          formattedCurrent: formatTime(cur),
          formattedDuration: formatTime(dur)
        });

        this._syncLyrics(cur);
        this._updateMediaPositionState();

        // 借鉴洛雪音乐机制：歌曲剩余时间小于 15 秒且下一首尚未就绪时，静默触发下一首预载
        if (dur > 20 && (dur - cur) <= 15 && !this.preloadedKey && !this.isResolving) {
          this._schedulePrefetch();
        }
      });

      this.audio.addEventListener('ended', () => {
        if (this.isResolving) return;
        this._handleTrackEnded();
      });

      this.audio.addEventListener('error', (e) => {
        if (!this.audio.src || this.audio.src.startsWith('data:') || this.audio.src === (typeof window !== 'undefined' ? window.location.href : '')) return;
        this._handleAudioError(e);
      });
    }

    // 音频流降级代理与多曲目顺延兜底
    _handleStreamFallback(song, songName, code, e) {
      const currentSrc = this._currentMediaSrc || this.audio.src;
      const isHls = (currentSrc && currentSrc.includes('.m3u8')) || (song && song.platform === 'streetvoice');
      // 1. 若当前是普通直链且尚未走过中继代理，尝试自动走 stream_proxy 中继流 (禁止对 .m3u8 走清单代理)
      if (!isHls && currentSrc && !currentSrc.includes('/api/stream_proxy') && !this._retriedProxy) {
        this._retriedProxy = true;
        console.warn(`[Player] 音频直链播放异常(code=${code})，尝试走安全中继流代理:`, currentSrc);
        this._setAudioSource(`/api/stream_proxy?url=${encodeURIComponent(currentSrc)}`);
        const retryPlay = this.audio.play();
        if (retryPlay !== undefined) {
          retryPlay.catch(err => {
            console.warn("[Player] 中继代理自动起播受限:", err);
          });
        }
        return;
      }

      this._retriedProxy = false;
      console.warn(`[Player] 音频流加载彻底异常(code=${code}):`, e);

      // 2. 歌单多曲目自动顺延下一首容灾
      if (this.playlist.length > 1 && (this.autoSkipCount || 0) < 3) {
        this.autoSkipCount = (this.autoSkipCount || 0) + 1;
        if (typeof window !== 'undefined' && window.Shell?.showToast) {
          window.Shell.showToast(`《${songName}》音频流失效，已自动顺延下一首`);
        }
        this._emit('stateChange', { isPlaying: false, isResolving: false, error: `《${songName}》音频流失效，已顺延` });
        if (this._autoSkipTimer) {
          clearTimeout(this._autoSkipTimer);
          this._autoSkipTimer = null;
        }
        const skipToken = this.resolveToken;
        this._autoSkipTimer = setTimeout(() => {
          this._autoSkipTimer = null;
          if (this.resolveToken !== skipToken) return;
          if (this.playMode === 'shuffle') {
            const candidates = [];
            for (let i = 0; i < this.playlist.length; i++) {
              if (i !== this.currentIndex) candidates.push(i);
            }
            const nextIdx = candidates.length > 0
              ? candidates[Math.floor(Math.random() * candidates.length)]
              : 0;
            this.playIndex(nextIdx, true);
          } else {
            const nextIdx = (this.currentIndex + 1) % this.playlist.length;
            this.playIndex(nextIdx, true);
          }
        }, 800);
      } else {
        this._emit('stateChange', { isPlaying: false, isResolving: false, error: "音频流加载异常" });
      }
    }

    // 借鉴洛雪音乐：初始化隐藏预载 Audio 实例 (用于向浏览器底层预取首段音频缓冲流)
    _initPreloadAudio() {
      if (this.preloadAudio) return;
      this.preloadAudio = new Audio();
      this.preloadAudio.controls = false;
      this.preloadAudio.preload = "auto";
      this.preloadAudio.muted = true;
      this.preloadAudio.volume = 0;
      this.preloadAudio.autoplay = false;

      this.preloadAudio.addEventListener('canplay', () => {
        // 浏览器底层已完成元数据与前置音频切片拉取，写入了浏览器 HTTP Cache
        if (this._currentPreloadingKey) {
          this.preloadedKey = this._currentPreloadingKey;
        }
      });

      this.preloadAudio.addEventListener('error', () => {
        // 预载时发现死链（例如 403 或 Token 过期），静默清理失效缓存并准备重新拉取
        if (this._currentPreloadingKey) {
          const deadKey = this._currentPreloadingKey;
          this._removeCachedResolve(deadKey);
          this.preloadedKey = null;
          this._currentPreloadingKey = null;
        }
      });
    }

    _preloadAudioBuffer(key, url) {
      if (!url || url.startsWith('data:') || String(url).includes('.m3u8') || this.preloadedKey === key) return;
      this._initPreloadAudio();
      this._currentPreloadingKey = key;
      try {
        this.preloadAudio.src = url;
        this.preloadAudio.load(); // 触发底层 HTTP Range 分片拉取
      } catch (e) {}
    }

    _resetPreloadAudio() {
      if (this.preloadAudio) {
        try {
          this.preloadAudio.pause();
          this.preloadAudio.removeAttribute('src');
          this.preloadAudio.load();
        } catch (e) {}
      }
      this._currentPreloadingKey = null;
    }

    // 歌轨自然结束时的处理
    _handleTrackEnded() {
      if (this.isResolving) return;
      if (this.playMode === 'single') {
        this.audio.currentTime = 0;
        this.audio.play().catch(() => {});
      } else {
        // 4.3 列表循环或随机播放模式下自然播完统一调用 next()，随机模式下直接复用已预解析的 shuffledNextIndex
        this.next();
      }
    }

    // 毫秒级歌词同步 (带 150ms 听觉-视觉感知前置补偿；纯文本无时间戳歌词保持首行)
    _syncLyrics(currentTime) {
      if (!this.lyrics || this.lyrics.length === 0) return;

      const isUntimed = this.lyrics.some(l => l && l.untimed) ||
        (this.lyrics.length > 1 && this.lyrics.every(l => !l || !l.time));

      let idx = -1;
      if (isUntimed) {
        idx = 0;
      } else {
        // 引入 150ms 听觉感知前置补偿，抵消 HTML5 audio timeupdate 事件 250ms 采样周期滞后感
        const syncTime = (currentTime || 0) + 0.15;

        for (let i = 0; i < this.lyrics.length; i++) {
          if (syncTime >= this.lyrics[i].time) {
            idx = i;
          } else {
            break;
          }
        }
      }

      if (idx !== this.currentLyricIdx) {
        this.currentLyricIdx = idx;
        const currentLine = idx >= 0 ? this.lyrics[idx].text : "";
        const nextLine = (idx + 1 < this.lyrics.length) ? this.lyrics[idx + 1].text : "";
        this._emit('lyricUpdate', {
          index: idx,
          currentLine,
          nextLine,
          allLines: this.lyrics
        });
      }
    }

    // 缓存持久化与生命周期维护
    _loadSessionCache() {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return;
        const raw = window.sessionStorage.getItem(SESSION_CACHE_STORAGE_KEY);
        if (!raw) return;
        const list = JSON.parse(raw);
        const now = Date.now();
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.key && item.data && (now - (item.data.ts || 0) < RESOLVE_CACHE_TTL_MS)) {
              this.resolveCache.set(item.key, item.data);
            }
          }
        }
      } catch (e) {}
    }

    _saveSessionCache() {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return;
        const now = Date.now();
        const list = [];
        for (const [key, data] of this.resolveCache.entries()) {
          if (data && (now - (data.ts || 0) < RESOLVE_CACHE_TTL_MS)) {
            list.push({ key, data });
          }
        }
        const trimmed = list.slice(-RESOLVE_CACHE_MAX_ENTRIES);
        window.sessionStorage.setItem(SESSION_CACHE_STORAGE_KEY, JSON.stringify(trimmed));
      } catch (e) {}
    }

    _getCachedResolve(songKey) {
      if (!songKey) return null;
      const cached = this.resolveCache.get(songKey);
      if (!cached) return null;
      if (Date.now() - (cached.ts || 0) > RESOLVE_CACHE_TTL_MS) {
        this.resolveCache.delete(songKey);
        this._saveSessionCache();
        return null;
      }
      return cached;
    }

    _setCachedResolve(songKey, data) {
      if (!songKey || !data || !data.url) return;
      data.ts = data.ts || Date.now();
      this.resolveCache.set(songKey, data);
      if (this.resolveCache.size > RESOLVE_CACHE_MAX_ENTRIES) {
        const oldestKey = this.resolveCache.keys().next().value;
        this.resolveCache.delete(oldestKey);
      }
      this._saveSessionCache();
    }

    _removeCachedResolve(songKey) {
      if (!songKey) return;
      this.resolveCache.delete(songKey);
      this._saveSessionCache();
    }

    // 获取当前歌词
    async fetchLyrics(song) {
      const currentToken = this.resolveToken;
      this.lyrics = [];
      this.currentLyricIdx = -1;
      this._emit('lyricUpdate', { index: -1, currentLine: "正在匹配歌词...", nextLine: "", allLines: [] });

      try {
        const plat = encodeURIComponent(song.platform || '');
        const sid = encodeURIComponent(song.id || '');
        const title = encodeURIComponent(song.title || song.name || '');
        const artist = encodeURIComponent(song.artist || '');
        const res = await fetch(`/api/lyric?platform=${plat}&id=${sid}&title=${title}&artist=${artist}`);
        const lines = await res.json();
        if (this.resolveToken !== currentToken) return; // 快速切歌防竞态覆盖
        this.lyrics = lines || [];
        if (this.lyrics.length === 0) {
          this._emit('lyricUpdate', { index: -1, currentLine: "纯音乐，请欣赏", nextLine: "", allLines: [] });
        } else {
          this._syncLyrics(this.audio.currentTime || 0);
        }

        // 将歌词关联同步至短效缓存池，复听 0 网络请求
        const songKey = this._getSongKey(song);
        const entry = this._getCachedResolve(songKey);
        if (entry && this.lyrics.length > 0) {
          entry.lyrics = this.lyrics;
          this._saveSessionCache();
        }
      } catch (e) {
        if (this.resolveToken !== currentToken) return;
        this.lyrics = [];
        this._emit('lyricUpdate', { index: -1, currentLine: "暂无歌词", nextLine: "", allLines: [] });
      }
    }

    // 获取曲目唯一 Key (以标准化的 歌名+歌手 为核心主键，杜绝不同歌单 ID 差异)
    _getSongKey(song) {
      if (!song) return "";
      const title = (song.title || song.name || "").trim().toLowerCase();
      const artist = (song.artist || "").trim().toLowerCase();
      if (song.platform && ["kw", "wy", "tx", "kg", "mg", "streetvoice"].includes(song.platform) && (song.id || song.songmid)) {
        return `${song.platform}_${song.id || song.songmid}_${title}_${artist}`;
      }
      return `${title}_${artist}`;
    }

    // 后台静默预解析下一首曲目直链 (实现下一曲 0 毫秒秒切)
    _schedulePrefetch() {
      if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
      if (!this.playlist || this.playlist.length <= 1) return;

      this.prefetchTimer = setTimeout(() => {
        let nextIdx;
        if (this.playMode === 'shuffle') {
          // 4.3 随机模式：提前锁定随机下一首曲目目标（排除当前播放中的曲目）
          const candidates = [];
          for (let i = 0; i < this.playlist.length; i++) {
            if (i !== this.currentIndex) candidates.push(i);
          }
          nextIdx = candidates.length > 0 
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : 0;
          this.shuffledNextIndex = nextIdx;
        } else if (this.playMode === 'single') {
          nextIdx = this.currentIndex;
        } else {
          nextIdx = (this.currentIndex + 1) % this.playlist.length;
        }

        const nextSong = this.playlist[nextIdx];
        if (!nextSong) return;
        const key = this._getSongKey(nextSong);
        const cached = this._getCachedResolve(key);
        if (cached && cached.url) {
          // 若已有解析结果但尚未预载音频流，向浏览器底层发起音频预缓冲
          if (this.preloadedKey !== key) {
            this._preloadAudioBuffer(key, cached.url);
          }
          return;
        }

        const payload = {
          title: nextSong.title || nextSong.name || "",
          name: nextSong.name || nextSong.title || "",
          artist: nextSong.artist || "",
          album: nextSong.album || "",
          id: nextSong.id || "",
          platform: nextSong.platform || "",
          isrc: nextSong.isrc || "",
          url: nextSong.url || "",
          durationMillis: nextSong.durationMillis,
          duration: nextSong.duration || (nextSong.durationMillis ? Math.round(nextSong.durationMillis / 1000) : undefined)
        };

        fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(r => r.json()).then(data => {
          if (data && data.success && data.url) {
            this._setCachedResolve(key, {
              url: data.url,
              bytes: data.bytes,
              sourceName: data.source_name,
              costMs: 0,
              ts: Date.now(),
              lyrics: data.lyrics || []
            });
            // 借鉴洛雪音乐：将解析出的音频直链静默送入预载 Audio 实例，触发 Range 缓冲
            this._preloadAudioBuffer(key, data.url);
          }
        }).catch(() => {});
      }, 1200); // 歌曲起播 1.2 秒后平稳静默预取
    }

    // 播放指定索引的曲目 (首曲支持最长 5 秒寻链缓冲，中间曲目支持秒级预解析与快速顺延)
    async playIndex(idx, isAutoSkip = false, isPlaylistFirstTrack = false, isHistoryBack = false) {
      if (idx < 0 || idx >= this.playlist.length) return;
      if (!isAutoSkip) {
        this.autoSkipCount = 0;
      }
      if (this._autoSkipTimer) {
        clearTimeout(this._autoSkipTimer);
        this._autoSkipTimer = null;
      }
      this._retriedProxy = false;
      if (this.currentAbortController) {
        try { this.currentAbortController.abort(); } catch (e) {}
      }
      this.currentAbortController = new AbortController();
      const abortSignal = this.currentAbortController.signal;
      this.resolveToken = (this.resolveToken || 0) + 1;
      const currentToken = this.resolveToken;

      // 4.4 维护播放历史栈：非历史回退触发时，将当前有效歌曲索引压入栈
      if (!isHistoryBack && this.currentIndex >= 0 && this.currentIndex !== idx && this.currentIndex < this.playlist.length) {
        if (!this.historyStack) this.historyStack = [];
        this.historyStack.push(this.currentIndex);
        if (this.historyStack.length > 50) {
          this.historyStack.shift();
        }
      }

      this.unlockAudio();
      this.currentIndex = idx;
      this.shuffledNextIndex = null;
      const song = this.playlist[idx];

      // 立即停止正在播放的上一首音频，彻底切断前一首歌的声音、HLS 拉流与 ended 事件
      this._destroyHls();
      this._currentMediaSrc = "";
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
      } catch (e) {}
      this.isPlaying = false;

      // 1. 毫秒级即时视觉反馈：第 0 毫秒立即高亮与切歌名，杜绝卡顿感
      this._emit('trackChange', { index: idx, song });
      this._updateMediaMetadata(song);

      const songKey = this._getSongKey(song);
      const cached = this._getCachedResolve(songKey);

      // 2. 命中前端短效缓存：0 毫秒秒切出声，零 Vercel 网络开销！
      if (cached && cached.url) {
        this.autoSkipCount = 0;
        const isPreloadHit = (this.preloadedKey === songKey);
        this._resetPreloadAudio();
        this.preloadedKey = null;
        this._setAudioSource(cached.url);

        // 若缓存已有解析好的歌词，直接装配，彻底免除 /api/lyric 请求
        if (cached.lyrics && cached.lyrics.length > 0) {
          this.lyrics = cached.lyrics;
          this.currentLyricIdx = -1;
          this._syncLyrics(0);
          this._emit('lyricUpdate', {
            index: 0,
            currentLine: this.lyrics[0] ? this.lyrics[0].text : "",
            nextLine: this.lyrics[1] ? this.lyrics[1].text : "",
            allLines: this.lyrics
          });
        } else if (cached.lyricsResolved || song.platform === 'streetvoice') {
          this.lyrics = [];
          this.currentLyricIdx = -1;
          this._emit('lyricUpdate', { index: -1, currentLine: "纯音乐 / 暂无歌词", nextLine: "", allLines: [] });
        } else {
          this.fetchLyrics(song);
        }

        const sourceTag = isPreloadHit ? ' ⚡预载秒播' : ' ⚡快取秒开';
        const playPromise = this.audio.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            this._emit('stateChange', {
              isPlaying: true,
              isResolving: false,
              song,
              sourceName: (cached.sourceName || '') + sourceTag,
              costMs: 0,
              bytes: cached.bytes
            });
          }).catch(e => {
            console.warn("自动出声受限(等待用户点击播控):", e);
            this._emit('stateChange', {
              isPlaying: false,
              isResolving: false,
              song,
              sourceName: (cached.sourceName || '') + sourceTag,
              costMs: 0,
              bytes: cached.bytes
            });
          });
        }
        // 静默调度下一首的预解析
        this._schedulePrefetch();
        return;
      }

      // 未命中缓存时，先展示加载占位；/api/resolve 接口已内置音画同源正版歌词提取，避免并发冗余请求
      this.lyrics = [];
      this.currentLyricIdx = -1;
      this._emit('lyricUpdate', { index: -1, currentLine: "正在匹配曲目与歌词...", nextLine: "", allLines: [] });
      this.isResolving = true;
      this._emit('stateChange', { isPlaying: false, isResolving: true, song });

      const startTime = performance.now();
      const maxWaitMs = isPlaylistFirstTrack ? 5000 : 0;
      let data = null;
      let cost = 0;

      while (true) {
        if (this.resolveToken !== currentToken) return;
        try {
          const t0 = performance.now();
          const payload = {
            title: song.title || song.name || "",
            name: song.name || song.title || "",
            artist: song.artist || "",
            album: song.album || "",
            id: song.id || "",
            platform: song.platform || "",
            isrc: song.isrc || "",
            url: song.url || "",
            durationMillis: song.durationMillis,
            duration: song.duration || (song.durationMillis ? Math.round(song.durationMillis / 1000) : undefined)
          };
          const res = await fetch('/api/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: abortSignal
          });
          data = await res.json();
          cost = (performance.now() - t0).toFixed(0);
          if (data) {
            break; // 服务端已完成多源并发冲刺，直接使用结果
          }
        } catch (err) {
          if (err.name === 'AbortError') return; // 用户快速切歌已主动终止该请求
        }

        // 仅在网络异常抛错时对歌单首曲启用最多 3 秒重试窗口
        const elapsed = performance.now() - startTime;
        if (isPlaylistFirstTrack && elapsed < 3000) {
          const remain = 3000 - elapsed;
          await new Promise(r => setTimeout(r, Math.min(800, remain)));
        } else {
          break;
        }
      }

      if (this.resolveToken !== currentToken) return;

      try {
        if (data && data.success && data.url) {
          this.autoSkipCount = 0;
          this._resetPreloadAudio();
          this.preloadedKey = null;

          // 音画同源原子化：优先直接装配随 resolve 一并下发的高精同源正版歌词
          if (data.lyrics && Array.isArray(data.lyrics) && data.lyrics.length > 0) {
            this.lyrics = data.lyrics;
            this.currentLyricIdx = -1;
            this._syncLyrics(0);
            this._emit('lyricUpdate', {
              index: 0,
              currentLine: this.lyrics[0] ? this.lyrics[0].text : "",
              nextLine: this.lyrics[1] ? this.lyrics[1].text : "",
              allLines: this.lyrics
            });
          } else if (song.platform === 'streetvoice') {
            this.lyrics = [];
            this.currentLyricIdx = -1;
            this._emit('lyricUpdate', { index: -1, currentLine: "纯音乐 / 暂无歌词", nextLine: "", allLines: [] });
          } else {
            // 后端未能提取到同源歌词时，异步兜底独立抓取
            this.fetchLyrics(song);
          }

          // 写入前端短效缓存供回切与复听使用 (15分钟TTL)
          this._setCachedResolve(songKey, {
            url: data.url,
            bytes: data.bytes,
            sourceName: data.source_name,
            costMs: cost,
            ts: Date.now(),
            lyrics: this.lyrics || [],
            lyricsResolved: song.platform === 'streetvoice'
          });

          this._setAudioSource(data.url);
          const playPromise = this.audio.play();
          if (playPromise !== undefined) {
            playPromise.then(() => {
              this._emit('stateChange', {
                isPlaying: true,
                isResolving: false,
                song,
                sourceName: data.source_name,
                costMs: cost,
                bytes: data.bytes
              });
            }).catch(e => {
              console.warn("自动出声受限(等待用户点击播控):", e);
              this._emit('stateChange', {
                isPlaying: false,
                isResolving: false,
                song,
                sourceName: data.source_name,
                costMs: cost,
                bytes: data.bytes
              });
            });
          }
          // 调度下一首预解析
          this._schedulePrefetch();
        } else {
          // 当前曲目无可用音源（或歌单首曲等待满 5 秒仍无可用流）：智能跳到下一首
          if (this.playlist.length > 1 && (this.autoSkipCount || 0) < 3) {
            this.autoSkipCount = (this.autoSkipCount || 0) + 1;
            const songName = song.title || song.name || "当前曲目";
            if (typeof window !== 'undefined' && window.Shell && window.Shell.showToast) {
              const reason = isPlaylistFirstTrack ? "加载超时" : "暂无有效音源";
              window.Shell.showToast(`《${songName}》${reason}，已自动跳到下一首`);
            }
            const nextIdx = (idx + 1) % this.playlist.length;
            this._autoSkipTimer = setTimeout(() => {
              this._autoSkipTimer = null;
              if (this.resolveToken === currentToken) {
                this.playIndex(nextIdx, true, false); // 第二首及之后不再是歌单首曲，不重复等待 5 秒
              }
            }, 500);
            return;
          }

          // 达到跳过上限或单曲播放失败：明确停止音频，保持状态机同步
          this.autoSkipCount = 0;
          try { this.audio.pause(); } catch (e) {}
          this._emit('stateChange', {
            isPlaying: false,
            isResolving: false,
            song,
            error: `《${song.title || song.name || '曲目'}》暂无可用音源`
          });
        }
      } catch (err) {
        if (this.resolveToken !== currentToken) return;
        this.autoSkipCount = 0;
        try { this.audio.pause(); } catch (e) {}
        this._emit('stateChange', {
          isPlaying: false,
          isResolving: false,
          song,
          error: "网络连接异常，无法解析音频流"
        });
      } finally {
        if (this.resolveToken === currentToken) {
          this.isResolving = false;
        }
      }
    }

    // 播控方法
    togglePlay() {
      this.unlockAudio();
      if (!this.audio.src || this.audio.src.startsWith('data:')) {
        if (this.playlist.length > 0) {
          this.playIndex(this.currentIndex >= 0 ? this.currentIndex : 0);
        }
        return;
      }

      if (this.audio.paused) {
        this.audio.play().catch(() => {});
      } else {
        this.audio.pause();
        // 清理挂起的自动顺延定时器，避免阻塞正在异步加载的当前歌曲歌词
        if (this._autoSkipTimer) {
          clearTimeout(this._autoSkipTimer);
          this._autoSkipTimer = null;
        }
      }
    }

    next() {
      if (this.playlist.length === 0) return;
      this.unlockAudio();
      if (this.playMode === 'shuffle') {
        // 4.3 优先使用预解析阶段锁定的随机目标，确保秒开
        let nextIdx;
        if (this.shuffledNextIndex !== null && this.shuffledNextIndex >= 0 && this.shuffledNextIndex < this.playlist.length && this.shuffledNextIndex !== this.currentIndex) {
          nextIdx = this.shuffledNextIndex;
        } else {
          const candidates = [];
          for (let i = 0; i < this.playlist.length; i++) {
            if (i !== this.currentIndex) candidates.push(i);
          }
          nextIdx = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : 0;
        }
        this.shuffledNextIndex = null;
        this.playIndex(nextIdx);
      } else {
        const nextIdx = (this.currentIndex + 1) % this.playlist.length;
        this.playIndex(nextIdx);
      }
    }

    prev() {
      if (this.playlist.length === 0) return;
      this.unlockAudio();
      // 4.4 优先从播放历史回退栈中出栈（完美支持随机播放及任意切歌的回溯）
      if (this.historyStack && this.historyStack.length > 0) {
        const prevIdx = this.historyStack.pop();
        if (prevIdx >= 0 && prevIdx < this.playlist.length && prevIdx !== this.currentIndex) {
          this.playIndex(prevIdx, false, false, true); // isHistoryBack = true
          return;
        }
      }
      // 历史栈为空时的兜底逻辑（线性上一首）
      let prevIdx = this.currentIndex - 1;
      if (prevIdx < 0) prevIdx = this.playlist.length - 1;
      this.playIndex(prevIdx);
    }

    previous() {
      this.prev();
    }

    seek(percent) {
      if (!this.audio.duration) return;
      const pct = Math.max(0, Math.min(1, percent));
      this.audio.currentTime = pct * this.audio.duration;
    }

    setVolume(percent) {
      const v = Math.max(0, Math.min(1, percent));
      this.savedVolume = v;
      try {
        this.audio.volume = v;
        this.audio.muted = (v === 0);
      } catch (e) {}
      try { localStorage.setItem('amusic_volume', v.toString()); } catch (e) {}
    }

    toggleMute() {
      this.audio.muted = !this.audio.muted;
      try {
        if (this.audio.muted) {
          this.savedVolume = this.audio.volume || 0.8;
          this.audio.volume = 0;
        } else {
          this.audio.volume = this.savedVolume || 0.8;
        }
      } catch (e) {}
      return this.audio.muted;
    }

    getVolume() {
      return this.audio.muted ? 0 : this.audio.volume;
    }

    // 播放外部传入的整套曲目列表 (如 Apple Music 当前歌单) 并立即从指定索引播放
    playTracklist(tracks, startIndex = 0) {
      if (!Array.isArray(tracks) || tracks.length === 0) return;
      this._resetPreloadAudio();
      this.preloadedKey = null;
      this.historyStack = [];
      this.shuffledNextIndex = null;
      this.playlist = tracks.map((t, idx) => ({
        index: idx + 1,
        title: t.name || t.title || "未知歌曲",
        name: t.name || t.title || "未知歌曲",
        artist: t.artist || "未知歌手",
        album: t.album || "",
        durationMillis: t.durationMillis,
        duration: t.duration || (t.durationMillis ? Math.round(t.durationMillis / 1000) : undefined),
        id: t.id || "",
        platform: t.platform || "",
        cover: t.cover || t.artwork || "",
        artwork: t.artwork || t.cover || "",
        url: t.url || ""
      }));
      this.isDefaultList = false;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: false });
      const idx = Math.max(0, Math.min(startIndex, this.playlist.length - 1));
      this.playIndex(idx, false, false);
    }

    // 切换循环模式
    cycleMode() {
      if (this.playMode === 'loop') {
        this.playMode = 'single';
      } else if (this.playMode === 'single') {
        this.playMode = 'shuffle';
      } else {
        this.playMode = 'loop';
      }
      this.shuffledNextIndex = null;
      this._schedulePrefetch();
      this._emit('modeChange', this.playMode);
      return this.playMode;
    }

    setMode(mode) {
      if (['loop', 'single', 'shuffle', 'list-loop', 'single-loop'].includes(mode)) {
        let newMode = mode;
        if (mode === 'list-loop') newMode = 'loop';
        else if (mode === 'single-loop') newMode = 'single';
        if (this.playMode !== newMode) {
          this.playMode = newMode;
          this.shuffledNextIndex = null;
          this._schedulePrefetch();
          this._emit('modeChange', this.playMode);
        }
      }
    }

    getModeLabel() {
      if (this.playMode === 'loop') return { mode: 'loop', icon: '🔁', label: '列表循环' };
      if (this.playMode === 'single') return { mode: 'single', icon: '🔂', label: '单曲循环' };
      return { mode: 'shuffle', icon: '🔀', label: '随机播放' };
    }

    // 替换/设置当前播放列表（如歌单曲目加载后同步至队列，或搜索结果直接成为当前列表）
    setPlaylist(newList, autoPlayIndex = -1) {
      if (!Array.isArray(newList)) return;
      this._resetPreloadAudio();
      this.preloadedKey = null;
      this.historyStack = [];
      this.shuffledNextIndex = null;
      this.playlist = newList.map((t, idx) => ({
        index: idx + 1,
        title: t.name || t.title || "未知歌曲",
        name: t.name || t.title || "未知歌曲",
        artist: t.artist || "未知歌手",
        album: t.album || "",
        durationMillis: t.durationMillis,
        duration: t.duration || (t.durationMillis ? Math.round(t.durationMillis / 1000) : undefined),
        id: t.id || "",
        platform: t.platform || "",
        cover: t.cover || t.artwork || "",
        artwork: t.artwork || t.cover || "",
        url: t.url || ""
      }));
      this.isDefaultList = false;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: false });

      if (autoPlayIndex >= 0 && autoPlayIndex < this.playlist.length) {
        this.playIndex(autoPlayIndex);
      } else if (!this.isPlaying) {
        this.currentIndex = 0;
      }
    }

    // 插入并立即播放一首歌
    insertAndPlay(song) {
      const existingIdx = this.playlist.findIndex(s => s.platform === song.platform && s.id === song.id);
      if (existingIdx >= 0) {
        this.playIndex(existingIdx);
      } else {
        this.playlist.splice(this.currentIndex + 1, 0, song);
        this._emit('playlistChange', { playlist: this.playlist, isDefault: false });
        this.playIndex(this.currentIndex + 1);
      }
    }

    // 清空或重置播放队列
    loadDefaultPlaylist() {
      this._resetPreloadAudio();
      this.preloadedKey = null;
      this.playlist = [];
      this.isDefaultList = false;
      this.currentIndex = -1;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: false });
    }

    // 事件监听与派发
    on(event, callback) {
      if (this.listeners[event]) {
        this.listeners[event].push(callback);
      }
    }

    _emit(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(cb => {
          try { cb(data); } catch (e) { console.error(e); }
        });
      }
    }
  }

  // 挂载到全局并实例化单例播放内核
  window.MusicPlayer = MusicPlayer;
  if (!window.player) {
    window.player = new MusicPlayer();
  }

})(window);
