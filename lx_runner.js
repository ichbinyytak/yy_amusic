#!/usr/bin/env node
/**
 * lx_runner.js - 通用 LX Music 脚本沙盒执行器
 * 模拟 LX Music 播放器环境，直接运行开源生态中的 .js 音源脚本
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const origConsoleLog = console.log;
console.log = (...args) => {};
console.warn = (...args) => {};
console.info = (...args) => {};

const [,, scriptPath, source, action, rawParams] = process.argv;

if (!scriptPath || !source) {
    console.log(JSON.stringify({ success: false, error: "Missing required arguments: scriptPath source [action] [params]" }));
    process.exit(1);
}

let params = {};
if (rawParams) {
    try {
        params = JSON.parse(rawParams);
    } catch (e) {
        params = {};
    }
}

const timeoutMs = params.timeout || 2500;
let isDone = false;

function finish(res) {
    if (isDone) return;
    isDone = true;
    origConsoleLog(JSON.stringify(res));
    process.exit(0);
}

// 强制总超时保底
const killTimer = setTimeout(() => {
    finish({ success: false, error: "Script execution timed out (" + timeoutMs + "ms)" });
}, timeoutMs);

let fullScriptPath = path.isAbsolute(scriptPath) ? scriptPath : path.join(process.cwd(), scriptPath);
if (!fs.existsSync(fullScriptPath)) {
    clearTimeout(killTimer);
    finish({ success: false, error: `Script not found: ${fullScriptPath}` });
}

let scriptCode = '';
try {
    scriptCode = fs.readFileSync(fullScriptPath, 'utf-8');
} catch (e) {
    clearTimeout(killTimer);
    finish({ success: false, error: `Cannot read script: ${e.message}` });
}

let globalHandler = null;

// 构建沙箱允许的安全模块白名单 (严密隔离 child_process、fs 等系统提权模块)
const ALLOWED_BUILTIN_MODULES = {
    crypto: crypto,
    buffer: require('buffer')
};

function safeRequire(modName) {
    if (ALLOWED_BUILTIN_MODULES[modName]) {
        return ALLOWED_BUILTIN_MODULES[modName];
    }
    throw new Error(`[Security Sandbox] Blocked unsafe module require: "${modName}"`);
}

// 构建与 LX Music 完全兼容的 lx 交互 API
const lxApi = {
    EVENT_NAMES: {
        request: "request"
    },
    request: (url, opts, cb) => {
        if (typeof opts === "function") {
            cb = opts;
            opts = {};
        }
        opts = opts || {};
        const reqTimeout = opts.timeout || 1800;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), reqTimeout);

        const method = opts.method || "GET";
        const headers = opts.headers || {};
        let body = opts.body;
        if (body && typeof body === "object" && !(body instanceof Buffer) && !(body instanceof FormData)) {
            try { body = JSON.stringify(body); } catch(e){}
        }

        fetch(url, {
            method: method,
            headers: headers,
            body: (method === "GET" || method === "HEAD") ? undefined : body,
            signal: ctrl.signal
        }).then(async res => {
            clearTimeout(t);
            const text = await res.text();
            let parsed = text;
            try { parsed = JSON.parse(text); } catch(e){}
            cb(null, {
                statusCode: res.status,
                status: res.status,
                body: parsed,
                rawBody: text,
                headers: Object.fromEntries(res.headers.entries())
            });
        }).catch(err => {
            clearTimeout(t);
            cb(err);
        });
    },
    on: (event, handler) => {
        if (event === "request") {
            globalHandler = handler;
        }
    },
    send: () => {}
};

const fakeModule = { exports: {} };

// 构建独立的执行沙箱，彻底隔离 process 与宿主危险对象
const sandbox = {
    console: {
        log: () => {},
        warn: () => {},
        error: () => {},
        info: () => {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    fetch,
    AbortController,
    FormData,
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    atob,
    btoa,
    encodeURIComponent,
    decodeURIComponent,
    JSON,
    Math,
    Date,
    RegExp,
    Promise,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Object,
    Array,
    String,
    Number,
    Boolean,
    module: fakeModule,
    exports: fakeModule.exports,
    require: safeRequire,
    lx: lxApi
};

sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.global = sandbox;

try {
    const context = vm.createContext(sandbox);
    vm.runInContext(scriptCode, context, {
        timeout: timeoutMs,
        displayErrors: false
    });
} catch (e) {
    clearTimeout(killTimer);
    finish({ success: false, error: `Script sandbox execution failed: ${e.message}` });
}

if (!globalHandler || typeof globalHandler !== "function") {
    clearTimeout(killTimer);
    finish({ success: false, error: "No request handler registered in script" });
}

const reqAction = action || "musicUrl";
const quality = params.quality || "320k";
const songInfo = {
    id: params.songmid || params.id || params.mid,
    songmid: params.songmid || params.id || params.mid,
    mid: params.mid || params.songmid || params.id,
    name: params.title || params.name || "",
    singer: params.artist || params.singer || "",
    album: params.album || "",
    duration: params.duration || 0
};

const payload = {
    action: reqAction,
    source: source,
    info: {
        type: quality,
        musicInfo: songInfo
    }
};

globalHandler(payload).then(res => {
    clearTimeout(killTimer);
    if (!res) {
        finish({ success: false, error: "Empty result from source handler" });
    } else if (typeof res === "string" && res.startsWith("http")) {
        finish({ success: true, url: res, quality: quality, source: source });
    } else if (typeof res === "object") {
        const u = res.url || res.data || (res.musicInfo && res.musicInfo.url);
        if (u && typeof u === "string" && u.startsWith("http")) {
            finish({ success: true, url: u, quality: quality, source: source });
        } else {
            finish({ success: false, error: "No valid http url in response object" });
        }
    } else {
        finish({ success: false, error: "Invalid response format" });
    }
}).catch(err => {
    clearTimeout(killTimer);
    finish({ success: false, error: err.message || "Unknown error during handler execution" });
});
