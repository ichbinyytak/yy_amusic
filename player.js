/**
 * player.js - 独立音乐播放模块
 * 包含：
 * 1. 默认精选歌单与播放队列管理 (PlaylistManager)
 * 2. 播控状态机 (PlaybackController: 播放/暂停/上一曲/下一曲/循环模式/进度拖拽)
 * 3. 毫秒级歌词同步引擎 (LyricEngine: LRC时间轴对齐、当前句高亮与下一句预告)
 */

(function (window) {
  'use strict';

  // 1. 默认精选正版歌单 (页面初始化直接开箱即用)
  const DEFAULT_PLAYLIST = [
    {
      platform: "kw",
      id: "332301462",
      title: "海阔天空 (Edit)",
      artist: "BEYOND",
      album: "Beyond 20th Anniversary",
      duration: 239,
      score: 90.0
    },
    {
      platform: "kw",
      id: "254426",
      title: "晴天",
      artist: "周杰伦",
      album: "叶惠美",
      duration: 269,
      score: 90.0
    },
    {
      platform: "kw",
      id: "5046200",
      title: "平凡之路",
      artist: "朴树",
      album: "平凡之路",
      duration: 301,
      score: 90.0
    },
    {
      platform: "kw",
      id: "345094",
      title: "夜空中最亮的星",
      artist: "逃跑计划",
      album: "世界",
      duration: 252,
      score: 90.0
    },
    {
      platform: "kw",
      id: "255280",
      title: "十年",
      artist: "陈奕迅",
      album: "黑·白·灰",
      duration: 205,
      score: 90.0
    }
  ];

  // 格式化秒数为 mm:ss
  function formatTime(sec) {
    if (!sec || isNaN(sec)) return "00:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  class MusicPlayer {
    constructor() {
      // 核心 HTML5 Audio 实例
      this.audio = new Audio();
      this.audio.preload = "auto";
      try {
        const savedVol = localStorage.getItem('amusic_volume');
        if (savedVol !== null) {
          this.audio.volume = Math.max(0, Math.min(1, parseFloat(savedVol)));
        } else {
          this.audio.volume = 0.8;
        }
      } catch (e) {
        this.audio.volume = 0.8;
      }

      // 歌单状态
      this.playlist = [...DEFAULT_PLAYLIST];
      this.currentIndex = 0;
      this.isDefaultList = true;

      // 播放模式: 'loop' (列表循环) | 'single' (单曲循环) | 'shuffle' (随机播放)
      this.playMode = 'loop';

      // 状态标志
      this.isResolving = false;
      this.isPlaying = false;

      // 歌词状态
      this.lyrics = [];
      this.currentLyricIdx = -1;

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
        console.warn("音频播放异常:", e);
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

    // 播放指定索引的曲目
    async playIndex(idx) {
      if (idx < 0 || idx >= this.playlist.length) return;
      if (this.isResolving) return;

      this.currentIndex = idx;
      const song = this.playlist[idx];
      this.isResolving = true;

      this._emit('trackChange', { index: idx, song });
      this._emit('stateChange', { isPlaying: false, isResolving: true, song });

      // 并行请求歌词
      this.fetchLyrics(song);

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
        const data = await res.json();
        const cost = (performance.now() - t0).toFixed(0);

        if (data.success && data.url) {
          this.audio.src = data.url;
          this.audio.play().catch(e => console.warn("自动出声受阻:", e));
          this._emit('stateChange', {
            isPlaying: true,
            isResolving: false,
            song,
            sourceName: data.source_name,
            costMs: cost,
            bytes: data.bytes
          });
        } else {
          this._emit('stateChange', {
            isPlaying: false,
            isResolving: false,
            song,
            error: data.error || "所有音源轮询均未通过校验"
          });
        }
      } catch (err) {
        this._emit('stateChange', {
          isPlaying: false,
          isResolving: false,
          song,
          error: "网络错误: " + err.message
        });
      } finally {
        this.isResolving = false;
      }
    }

    // 播控方法
    togglePlay() {
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
      this.audio.volume = v;
      try { localStorage.setItem('amusic_volume', v.toString()); } catch (e) {}
    }

    getVolume() {
      return this.audio.volume;
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
      this.playIndex(idx);
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
      return this.playMode;
    }

    getModeLabel() {
      if (this.playMode === 'loop') return { mode: 'loop', icon: '🔁', label: '列表循环' };
      if (this.playMode === 'single') return { mode: 'single', icon: '🔂', label: '单曲循环' };
      return { mode: 'shuffle', icon: '🔀', label: '随机播放' };
    }

    // 替换/设置当前播放列表（如搜索结果直接成为当前列表）
    setPlaylist(newList, autoPlayIndex = -1) {
      if (!Array.isArray(newList)) return;
      this.playlist = [...newList];
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

    // 重置回默认精选歌单
    loadDefaultPlaylist() {
      this.playlist = [...DEFAULT_PLAYLIST];
      this.isDefaultList = true;
      this.currentIndex = 0;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: true });
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

  // 挂载到全局
  window.MusicPlayer = MusicPlayer;

})(window);
