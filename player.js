/**
 * player.js - 独立音乐播放模块
 * 包含：
 * 1. 默认精选歌单与播放队列管理 (PlaylistManager)
 * 2. 播控状态机 (PlaybackController: 播放/暂停/上一曲/下一曲/循环模式/进度拖拽)
 * 3. 毫秒级歌词同步引擎 (LyricEngine: LRC时间轴对齐、当前句高亮与下一句预告)
 */

(function (window) {
  'use strict';

  // 1. 默认播放队列初始化为空（由首次访问或记忆歌单动态注入）
  const DEFAULT_PLAYLIST = [];

  // 格式化秒数为 mm:ss
  function formatTime(sec) {
    if (!sec || isNaN(sec)) return "00:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

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

      // 状态标志
      this.isResolving = false;
      this.isPlaying = false;

      // 歌词状态
      this.lyrics = [];
      this.currentLyricIdx = -1;

      // 直链预解析缓存 (Map: songKey -> { url, bytes, sourceName, costMs })
      this.resolveCache = new Map();
      this.prefetchTimer = null;

      // 回调钩子 (用于更新 UI)
      this.listeners = {
        trackChange: [],
        stateChange: [],
        timeUpdate: [],
        lyricUpdate: [],
        playlistChange: []
      };

      this._bindAudioEvents();
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

    // 绑定底层音频事件
    _bindAudioEvents() {
      this.audio.addEventListener('play', () => {
        this.isPlaying = true;
        this._emit('stateChange', { isPlaying: true, isResolving: this.isResolving });
      });

      this.audio.addEventListener('pause', () => {
        this.isPlaying = false;
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
      });

      this.audio.addEventListener('ended', () => {
        this._handleTrackEnded();
      });

      this.audio.addEventListener('error', (e) => {
        if (!this.audio.src || this.audio.src === (typeof window !== 'undefined' ? window.location.href : '')) return;
        const code = this.audio.error ? this.audio.error.code : 0;
        if (code === 1) return; // MEDIA_ERR_ABORTED
        console.warn("音频播放异常, code:", code, e);
        this._emit('stateChange', { isPlaying: false, isResolving: false, error: "音频流加载异常" });
      });
    }

    // 歌轨自然结束时的处理
    _handleTrackEnded() {
      if (this.playMode === 'single') {
        this.audio.currentTime = 0;
        this.audio.play().catch(() => {});
      } else if (this.playMode === 'shuffle') {
        const nextIdx = Math.floor(Math.random() * this.playlist.length);
        this.playIndex(nextIdx);
      } else {
        // 默认列表循环
        this.next();
      }
    }

    // 毫秒级歌词同步
    _syncLyrics(currentTime) {
      if (!this.lyrics || this.lyrics.length === 0) return;

      let idx = -1;
      for (let i = 0; i < this.lyrics.length; i++) {
        if (currentTime >= this.lyrics[i].time) {
          idx = i;
        } else {
          break;
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

    // 获取当前歌词
    async fetchLyrics(song) {
      this.lyrics = [];
      this.currentLyricIdx = -1;
      this._emit('lyricUpdate', { index: -1, currentLine: "正在匹配歌词...", nextLine: "", allLines: [] });

      try {
        const plat = encodeURIComponent(song.platform || 'kw');
        const sid = encodeURIComponent(song.id || '');
        const title = encodeURIComponent(song.title || song.name || '');
        const artist = encodeURIComponent(song.artist || '');
        const res = await fetch(`/api/lyric?platform=${plat}&id=${sid}&title=${title}&artist=${artist}`);
        const lines = await res.json();
        this.lyrics = lines || [];
        if (this.lyrics.length === 0) {
          this._emit('lyricUpdate', { index: -1, currentLine: "纯音乐，请欣赏", nextLine: "", allLines: [] });
        } else {
          this._syncLyrics(this.audio.currentTime || 0);
        }
      } catch (e) {
        this.lyrics = [];
        this._emit('lyricUpdate', { index: -1, currentLine: "暂无歌词", nextLine: "", allLines: [] });
      }
    }

    // 获取曲目唯一 Key
    _getSongKey(song) {
      if (!song) return "";
      const sid = song.id || song.songmid || "";
      const title = (song.title || song.name || "").trim().toLowerCase();
      const artist = (song.artist || "").trim().toLowerCase();
      return `${sid}_${title}_${artist}`;
    }

    // 后台静默预解析下一首曲目直链 (实现下一曲 0 毫秒秒切)
    _schedulePrefetch() {
      if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
      if (!this.playlist || this.playlist.length <= 1) return;

      this.prefetchTimer = setTimeout(() => {
        const nextIdx = (this.currentIndex + 1) % this.playlist.length;
        const nextSong = this.playlist[nextIdx];
        if (!nextSong) return;
        const key = this._getSongKey(nextSong);
        if (this.resolveCache.has(key)) return;

        const payload = {
          title: nextSong.title || nextSong.name || "",
          name: nextSong.name || nextSong.title || "",
          artist: nextSong.artist || "",
          album: nextSong.album || "",
          id: nextSong.id || "",
          platform: nextSong.platform || "",
          durationMillis: nextSong.durationMillis,
          duration: nextSong.duration || (nextSong.durationMillis ? Math.round(nextSong.durationMillis / 1000) : undefined)
        };

        fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(r => r.json()).then(data => {
          if (data && data.success && data.url) {
            this.resolveCache.set(key, {
              url: data.url,
              bytes: data.bytes,
              sourceName: data.source_name,
              costMs: 0
            });
            // 缓存上限 30 首，超额淘汰老数据
            if (this.resolveCache.size > 30) {
              const firstKey = this.resolveCache.keys().next().value;
              this.resolveCache.delete(firstKey);
            }
          }
        }).catch(() => {});
      }, 1200); // 歌曲起播 1.2 秒后平稳静默预取
    }

    // 播放指定索引的曲目 (首曲支持最长 5 秒寻链缓冲，中间曲目支持秒级预解析与快速顺延)
    async playIndex(idx, isAutoSkip = false, isPlaylistFirstTrack = false) {
      if (idx < 0 || idx >= this.playlist.length) return;
      if (!isAutoSkip) {
        this.autoSkipCount = 0;
      }
      this.resolveToken = (this.resolveToken || 0) + 1;
      const currentToken = this.resolveToken;

      this.unlockAudio();
      this.currentIndex = idx;
      const song = this.playlist[idx];

      // 1. 毫秒级即时视觉反馈：第 0 毫秒立即高亮与切歌名，杜绝卡顿感
      this._emit('trackChange', { index: idx, song });

      // 并行请求歌词
      this.fetchLyrics(song);

      const songKey = this._getSongKey(song);
      const cached = this.resolveCache.get(songKey);

      // 2. 命中预解析直链缓存：0 毫秒秒切出声！
      if (cached && cached.url) {
        this.autoSkipCount = 0;
        this.audio.src = cached.url;
        const playPromise = this.audio.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            this._emit('stateChange', {
              isPlaying: true,
              isResolving: false,
              song,
              sourceName: cached.sourceName + ' ⚡秒开',
              costMs: 0,
              bytes: cached.bytes
            });
          }).catch(e => {
            console.warn("自动出声受限(等待用户点击播控):", e);
            this._emit('stateChange', {
              isPlaying: false,
              isResolving: false,
              song,
              sourceName: cached.sourceName + ' ⚡秒开',
              costMs: 0,
              bytes: cached.bytes
            });
          });
        }
        // 静默调度下一首的预解析
        this._schedulePrefetch();
        return;
      }

      // 3. 未命中缓存时，走正常寻链流程
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
            durationMillis: song.durationMillis,
            duration: song.duration || (song.durationMillis ? Math.round(song.durationMillis / 1000) : undefined)
          };
          const res = await fetch('/api/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          data = await res.json();
          cost = (performance.now() - t0).toFixed(0);
          if (data && data.success && data.url) {
            break; // 成功解析出有效音频流！
          }
        } catch (err) {
          // 捕获网络或瞬态异常
        }

        // 仅对歌单首曲启用最长 5 秒缓冲等待与重试窗口
        const elapsed = performance.now() - startTime;
        if (isPlaylistFirstTrack && elapsed < maxWaitMs) {
          const remain = maxWaitMs - elapsed;
          await new Promise(r => setTimeout(r, Math.min(800, remain)));
        } else {
          break; // 中间曲目单次失败直接退出，或首曲已满 5 秒
        }
      }

      if (this.resolveToken !== currentToken) return;

      try {
        if (data && data.success && data.url) {
          this.autoSkipCount = 0;
          // 写入缓存供回切使用
          this.resolveCache.set(songKey, {
            url: data.url,
            bytes: data.bytes,
            sourceName: data.source_name,
            costMs: cost
          });

          this.audio.src = data.url;
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
            setTimeout(() => {
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
        this.isResolving = false;
      }
    }

    // 播控方法
    togglePlay() {
      this.unlockAudio();
      if (!this.audio.src) {
        if (this.playlist.length > 0) {
          this.playIndex(this.currentIndex >= 0 ? this.currentIndex : 0);
        }
        return;
      }

      if (this.audio.paused) {
        this.audio.play().catch(() => {});
      } else {
        this.audio.pause();
      }
    }

    next() {
      if (this.playlist.length === 0) return;
      this.unlockAudio();
      if (this.playMode === 'shuffle') {
        const nextIdx = Math.floor(Math.random() * this.playlist.length);
        this.playIndex(nextIdx);
      } else {
        const nextIdx = (this.currentIndex + 1) % this.playlist.length;
        this.playIndex(nextIdx);
      }
    }

    prev() {
      if (this.playlist.length === 0) return;
      this.unlockAudio();
      let prevIdx = this.currentIndex - 1;
      if (prevIdx < 0) prevIdx = this.playlist.length - 1;
      this.playIndex(prevIdx);
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
      this.playlist = tracks.map((t, idx) => ({
        index: idx + 1,
        title: t.name || t.title || "未知歌曲",
        name: t.name || t.title || "未知歌曲",
        artist: t.artist || "未知歌手",
        album: t.album || "",
        durationMillis: t.durationMillis,
        duration: t.duration || (t.durationMillis ? Math.round(t.durationMillis / 1000) : undefined),
        id: t.id || "",
        platform: t.platform || ""
      }));
      this.isDefaultList = false;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: false });
      const idx = Math.max(0, Math.min(startIndex, this.playlist.length - 1));
      this.playIndex(idx, false, idx === 0);
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
      this._emit('modeChange', this.playMode);
      return this.playMode;
    }

    setMode(mode) {
      if (['loop', 'single', 'shuffle', 'list-loop', 'single-loop'].includes(mode)) {
        if (mode === 'list-loop') this.playMode = 'loop';
        else if (mode === 'single-loop') this.playMode = 'single';
        else this.playMode = mode;
        this._emit('modeChange', this.playMode);
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
      this.playlist = newList.map((t, idx) => ({
        index: idx + 1,
        title: t.name || t.title || "未知歌曲",
        name: t.name || t.title || "未知歌曲",
        artist: t.artist || "未知歌手",
        album: t.album || "",
        durationMillis: t.durationMillis,
        duration: t.duration || (t.durationMillis ? Math.round(t.durationMillis / 1000) : undefined),
        id: t.id || "",
        platform: t.platform || ""
      }));
      this.isDefaultList = false;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: false });

      if (autoPlayIndex >= 0 && autoPlayIndex < this.playlist.length) {
        this.playIndex(autoPlayIndex);
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
