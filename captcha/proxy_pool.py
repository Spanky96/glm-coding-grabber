"""
代理池：加载、健康检查、快窗口轮询、失败冷却、session 出口粘性。

借鉴 glm-coding 竞品 app/proxy_pool/service.py 的调度策略（快窗口前 N 轮询、
延迟排序、失败冷却、刷新失败保留旧池），去掉其手写的 SOCKS5/TCP server
（本实现直接用 curl_cffi/httpx 的 proxies 参数，省掉约 1000 行）。

session 粘性是相对竞品新增的能力：同一次抢购流程里「验证码获取」与
「preview 提交」绑定同一出口 IP，避免智谱后端校验「申请 ticket 的 IP」与
「提交 preview 的 IP」不一致。
"""

import concurrent.futures
import json
import logging
import os
import threading
import time
import urllib.request
from urllib.parse import urlparse

from proxy_forwarder import probe

log = logging.getLogger('proxy-pool')

DEFAULT_HEALTH_TARGET = 'https://www.bigmodel.cn/'


class UpstreamProxy:
    """解析一行代理配置。支持 socks5://user:pass@host:port、http://host:port、裸 host:port。

    裸 host:port（无 scheme）按 default_scheme 处理：proxies.txt 默认 socks5（向后兼容），
    司叶天等 HTTP 代理 API 提取的裸 ip:port 传 default_scheme='http'。
    """

    def __init__(self, raw, default_scheme='socks5'):
        self.raw = raw.strip()
        self.scheme, self.proxy_url = self._normalize(self.raw, default_scheme)
        self.address = self._hostport(self.proxy_url)

    @staticmethod
    def _normalize(raw, default_scheme='socks5'):
        s = raw.strip()
        if '://' not in s:
            s = default_scheme + '://' + s  # 裸 host:port 按调用方指定 scheme
        scheme = (urlparse(s).scheme or default_scheme).lower()
        if scheme == 'socks5h':
            # socks5h（代理解析 DNS）规范化为 socks5，兼容 curl_cffi（仅认 socks5/socks4）
            s = 'socks5' + s[len('socks5h'):]
            scheme = 'socks5'
        return scheme, s

    @staticmethod
    def _hostport(url):
        p = urlparse(url)
        return f'{p.hostname}:{p.port}' if p.port else (p.hostname or url)

    def __repr__(self):
        return f'<UpstreamProxy {self.scheme}://{self.address}>'


class ProxyPool:
    def __init__(self, fast_window=32, cooldown_seconds=60,
                 max_latency_ms=3000, health_target=DEFAULT_HEALTH_TARGET):
        self._proxies = []            # 健康检查后按延迟升序的 UpstreamProxy 列表
        self._latency = {}            # raw -> latency_ms
        self._lock = threading.Lock()
        self._index = 0               # 快窗口轮询游标
        self._cooldown = {}           # raw -> expire_ts
        self._session = {}            # session_id -> raw（出口粘性绑定）
        self.fast_window = fast_window
        self.cooldown_seconds = cooldown_seconds
        self.max_latency_ms = max_latency_ms
        self.health_target = health_target

    # ── 加载 ────────────────────────────────────────────────────────
    def load_from_file(self, path):
        if not os.path.exists(path):
            return 0
        seen, loaded = set(), []
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith('#') or s in seen:
                    continue
                seen.add(s)
                try:
                    loaded.append(UpstreamProxy(s))
                except Exception:
                    continue
        self._proxies = loaded
        return len(loaded)

    # ── 从 API 提取（直连，不走代理转发——避免鸡生蛋） ────────────────
    def load_from_api(self, url, scheme='http', timeout=10.0):
        """
        从代理提取 API（如司叶天）拉一批短命代理。成功（≥1 条）时替换池并返回条数；
        失败/为空返回 0 且不动池（保留旧池，与 health_check_all 哲学一致）。

        响应格式兼容两种：
          - 纯文本（split=1）：每行一个 ip:port；
          - JSON：成功 {"data":["ip:port", ...]}，错误 {"code":10006,"info":"...","data":[]}。
        """
        try:
            # ProxyHandler({}) 显式不走任何系统/环境代理，确保直连提取
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(url, timeout=timeout) as resp:
                body = resp.read().decode('utf-8', errors='replace')
        except Exception as e:
            log.warning('代理API请求失败（保留旧池）: %s', e)
            return 0

        entries = self._parse_api_body(body)
        if entries is None:            # JSON 错误，已在 _parse_api_body 记录
            return 0

        seen, loaded = set(), []
        for s in entries:
            s = self._entry_to_str(s)
            if not s or s.startswith('#') or s in seen:
                continue
            seen.add(s)
            try:
                loaded.append(UpstreamProxy(s, default_scheme=scheme))
            except Exception:
                continue

        if not loaded:
            log.warning('代理API返回为空（保留旧池）')
            return 0

        with self._lock:
            self._proxies = loaded
            self._latency = {}
            self._cooldown.clear()
            self._session.clear()
            self._index = 0
            self.fast_window = min(self.fast_window, len(self._proxies))
        log.info('从API提取 %d 个代理（scheme=%s）', len(loaded), scheme)
        return len(loaded)

    @staticmethod
    def _parse_api_body(body):
        """
        解析 API 响应体，返回字符串列表；JSON 错误时记日志并返回 None。
          - JSON 对象含非空 data 列表 → 取其项；
          - JSON 对象但 data 空/缺省 → 视为错误（记录 code/info），返回 None；
          - JSON 数组 → 取其项；
          - 其它 → 按纯文本逐行。
        """
        s = body.strip()
        if s[:1] in ('{', '['):
            try:
                j = json.loads(s)
            except Exception:
                j = None
            if isinstance(j, dict):
                data = j.get('data')
                if isinstance(data, list) and data:
                    return data
                log.warning('代理API返回错误: code=%s info=%s', j.get('code'), j.get('info'))
                return None
            if isinstance(j, list) and j:
                return j
        return body.splitlines()

    @staticmethod
    def _entry_to_str(x):
        """把 API 的一项规范化为 'host:port' 或带 scheme 的字符串；无法识别返回 None。"""
        if isinstance(x, str):
            return x.strip()
        if isinstance(x, dict):
            host = x.get('ip') or x.get('host')
            port = x.get('port')
            if host and port:
                return f'{host}:{port}'
        return None

    # ── 健康检查（并发，失败保留旧池） ──────────────────────────────
    def health_check_all(self, concurrency=64, timeout=6.0):
        candidates = list(self._proxies)
        if not candidates:
            return 0
        results, lock = {}, threading.Lock()

        def check(p):
            ms = probe(p.proxy_url, self.health_target, timeout)
            with lock:
                results[p.raw] = ms

        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
            # 消费迭代器以等待全部完成（check 内部已 try，不会抛）
            list(ex.map(check, candidates))

        healthy = [(p, results[p.raw]) for p in candidates if results.get(p.raw) is not None]
        if self.max_latency_ms > 0:
            healthy = [x for x in healthy if x[1] <= self.max_latency_ms]
        healthy.sort(key=lambda x: (x[1], x[0].raw))

        if not healthy:
            log.warning('健康检查：无可用代理，保留旧池（%d 个）', len(self._proxies))
            return len(self._proxies)

        with self._lock:
            self._proxies = [x[0] for x in healthy]
            self._latency = {x[0].raw: x[1] for x in healthy}
            self._cooldown.clear()
            self._session.clear()
            self._index = 0
            self.fast_window = min(self.fast_window, len(self._proxies))
        log.info('健康检查完成：%d/%d 可用', len(self._proxies), len(candidates))
        return len(self._proxies)

    # ── 调度 ────────────────────────────────────────────────────────
    def _pick_unlocked(self, pool, now):
        if not pool:
            return None
        n = len(pool)
        for _ in range(n):
            p = pool[self._index % n]
            self._index += 1
            until = self._cooldown.get(p.raw)
            if until is None or until <= now:
                self._cooldown.pop(p.raw, None)
                return p
        return None

    def get(self, session_id=None):
        """取一个代理。给 session_id 时尽量返回其绑定代理（出口粘性）。"""
        with self._lock:
            if not self._proxies:
                raise RuntimeError('proxy pool empty')
            now = time.time()

            # 1) session 粘性：绑定代理未冷却则复用
            if session_id:
                bound = self._session.get(session_id)
                if bound:
                    target = next((p for p in self._proxies if p.raw == bound), None)
                    if target:
                        until = self._cooldown.get(target.raw)
                        if until is None or until <= now:
                            return target
                    self._session.pop(session_id, None)  # 绑定失效，重选

            # 2) 快窗口优先，耗尽回退全池
            window = self._proxies[:max(1, self.fast_window)]
            picked = self._pick_unlocked(window, now) or self._pick_unlocked(self._proxies, now)
            if picked is None:
                # 全部冷却：强制返回一个，避免请求无出口
                picked = self._proxies[self._index % len(self._proxies)]
                self._index += 1
            if session_id:
                self._session[session_id] = picked.raw
            return picked

    def release_session(self, session_id):
        """释放一次验证码/preview 组合的出口粘性绑定。"""
        if not session_id:
            return
        with self._lock:
            self._session.pop(session_id, None)

    def mark_failure(self, proxy):
        if proxy is None or self.cooldown_seconds <= 0:
            return
        with self._lock:
            self._cooldown[proxy.raw] = time.time() + self.cooldown_seconds
            self._session = {k: v for k, v in self._session.items() if v != proxy.raw}
        log.warning('代理冷却 %ds: %s', self.cooldown_seconds, proxy.address)

    def discard(self, raw):
        """永久移除一个代理（用完即弃 / 故障淘汰）。返回是否实际移除了条目。"""
        with self._lock:
            before = len(self._proxies)
            self._proxies = [p for p in self._proxies if p.raw != raw]
            self._latency.pop(raw, None)
            self._cooldown.pop(raw, None)
            self._session = {k: v for k, v in self._session.items() if v != raw}
            removed = len(self._proxies) < before
        if removed:
            log.info('代理已丢弃: %s（池剩余 %d）', raw, len(self._proxies))
        return removed

    def refill_from_api(self, url, scheme='http', timeout=10.0):
        """从 API 拉一批代理，去重后仅对新代理做健康检查，追加到现有池。
        不清理已有 session/cooldown——仅扩充，不破坏进行中的粘性绑定。
        返回成功添加的条数；失败/为空返回 0 且不动池。"""
        # 1) 直连提取
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(url, timeout=timeout) as resp:
                body = resp.read().decode('utf-8', errors='replace')
        except Exception as e:
            log.warning('refill API请求失败: %s', e)
            return 0

        entries = self._parse_api_body(body)
        if entries is None:
            return 0

        # 2) 解析 + 去重（排除已在池中的）
        existing = {p.raw for p in self._proxies}
        seen, new_proxies = set(), []
        for s in entries:
            s = self._entry_to_str(s)
            if not s or s in seen or s in existing:
                continue
            seen.add(s)
            try:
                new_proxies.append(UpstreamProxy(s, default_scheme=scheme))
            except Exception:
                continue

        if not new_proxies:
            log.warning('refill: API返回的代理均已存在池中')
            return 0

        # 3) 仅对新代理做健康检查
        results, lock = {}, threading.Lock()

        def check(p):
            ms = probe(p.proxy_url, self.health_target, timeout=6.0)
            with lock:
                results[p.raw] = ms

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(new_proxies))) as ex:
            list(ex.map(check, new_proxies))

        healthy = [(p, results[p.raw]) for p in new_proxies if results.get(p.raw) is not None]
        if self.max_latency_ms > 0:
            healthy = [(p, ms) for p, ms in healthy if ms <= self.max_latency_ms]

        if not healthy:
            log.warning('refill: 新代理全部健康检查失败')
            return 0

        # 4) 追加到现有池（保持延迟排序）
        with self._lock:
            for p, ms in healthy:
                self._proxies.append(p)
                self._latency[p.raw] = ms
            self._proxies.sort(key=lambda p: self._latency.get(p.raw, 999999))
            self.fast_window = min(self.fast_window, len(self._proxies))

        log.info('refill: 添加 %d 个新代理（池共 %d 个）', len(healthy), len(self._proxies))
        return len(healthy)

    # ── 状态 ────────────────────────────────────────────────────────
    def stats(self):
        with self._lock:
            return {
                'pool_size': len(self._proxies),
                'healthy': len(self._proxies),  # _proxies 已是健康子集
                'cooling': len(self._cooldown),
                'sessions': len(self._session),
            }
