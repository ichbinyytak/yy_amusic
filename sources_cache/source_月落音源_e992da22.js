/*!
 * @name 月落音源
 * @description 仅Q音，理论全音质，具体自测
 * @version v1
 * @author 玥然OvO
 */


const DEV_ENABLE = false
const API_BASE = 'https://api.vkeys.cn/v2/music/tencent'

const QUALITY_MAP = {
    '128k': '6',
    '320k': '8',
    'flac': '10',
    'hires': '11',
    'atmos': '12',
    'atmos_plus': '13',
    'master': '14'
}

const MUSIC_QUALITY = JSON.parse('{"tx":["128k","320k","flac","hires","atmos","atmos_plus","master"]}');
const MUSIC_SOURCE = Object.keys(MUSIC_QUALITY);

const { EVENT_NAMES, request, on, send } = globalThis.lx;

const handleGetMusicUrl = async (source, musicInfo, quality) => {
    const mid = musicInfo.songmid || musicInfo.mid || musicInfo.id;
    if (!mid) throw new Error("缺少歌曲MID");

    const apiUrl = `${API_BASE}?mid=${mid}&quality=${QUALITY_MAP[quality] || '6'}`;
    
    try {
        const { body } = await new Promise((resolve, reject) => {
            request(apiUrl, { method: "GET" }, (err, resp) => {
                if (err) reject(err); else resolve(resp);
            });
        });
        
        let data = typeof body === 'string' ? JSON.parse(body.trim()) : body;
        if (data?.code === 200 && data.data?.url) {
            return data.data.url;
        }
        throw new Error(data?.message || "获取音频地址失败");
    } catch {
        throw new Error("获取链接失败");
    }
};

const musicSources = {};
MUSIC_SOURCE.forEach((item) => {
    musicSources[item] = {
        name: '腾讯音乐',
        type: "music",
        actions: ["musicUrl"],
        qualitys: MUSIC_QUALITY[item]
    };
});

on(EVENT_NAMES.request, ({ action, source, info }) => {
    if (action === "musicUrl" && source === 'tx') {
        return handleGetMusicUrl(source, info.musicInfo, info.type);
    }
    return Promise.reject("action not support");
});

send(EVENT_NAMES.inited, {
    status: true,
    openDevTools: DEV_ENABLE,
    sources: musicSources,
});