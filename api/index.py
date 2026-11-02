# -*- coding: utf-8 -*-
"""
api/index.py - Vercel Serverless Function 统一入口
将所有 /api/* 请求桥接到统一的 Python 后端处理引擎 (server.Handler)
"""

import os
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler

# 将项目根目录加入模块搜索路径，确保核心逻辑模块正常加载
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from server import Handler

class handler(Handler):
    """
    Vercel Serverless Function HTTP 处理类
    继承自 server.Handler，兼容 Vercel 请求头与 URL 路由
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def _resolve_real_path(self):
        # 兼容 Vercel 重写后的真实路径
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if "__route__" in qs:
            route = qs.pop("__route__")[0]
            remaining_query = urllib.parse.urlencode(qs, doseq=True)
            self.path = f"/api/{route}" + (f"?{remaining_query}" if remaining_query else "")
        elif self.headers.get("x-forwarded-uri"):
            self.path = self.headers.get("x-forwarded-uri")
        elif self.headers.get("x-matched-path"):
            self.path = self.headers.get("x-matched-path")

    def do_GET(self):
        self._resolve_real_path()
        if self.path in ("/api", "/api/"):
            self.send_json({"status": "ok", "service": "Amusic Serverless API", "version": "4.9"})
            return
        super().do_GET()

    def do_POST(self):
        self._resolve_real_path()
        super().do_POST()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
