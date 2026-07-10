"""
代理转发抽象层。

优先 curl_cffi（模拟浏览器 TLS/JA3 指纹，对腾讯验证码/智谱风控友好，
竞品 glm-coding 即用此路线），回退 httpx。维护全局 cookie jar，
使 *.captcha.qcloud.com 等域的 cookie 在多次转发之间保持——这对验证码
challenge → verify 的连续性很关键。

接口:
  backend()                         -> 'curl_cffi' | 'httpx'
  request(method, url, headers,     -> (status:int, headers:dict, body:bytes)；失败抛异常
          body, proxy_url, timeout)
  probe(proxy_url, target, timeout) -> latency_ms:int | None（健康检查）

设计原则：
  - 透明转发：不解析、不重写业务 header（仅剥离 hop-by-hop 头交给底层库重算）
  - 代理 per-request：cookie jar 全局保持，与具体代理解耦
"""

import logging
import time

log = logging.getLogger('proxy-forwarder')

# ── 后端探测：延迟导入，某一缺失不应阻断整个 OCR 服务 ──────────────
try:
    from curl_cffi import requests as _curl

    _SESSION = _curl.Session()
    _BACKEND = 'curl_cffi'
    log.info('代理转发后端：curl_cffi（将模拟浏览器 TLS 指纹）')
except Exception as _e:  # curl_cffi 缺失或初始化失败
    _curl = None
    _SESSION = None
    _BACKEND = None
    log.info('curl_cffi 不可用（%s），尝试 httpx 回退', _e)

try:
    import httpx
except Exception:
    httpx = None

if _BACKEND is None and httpx is None:
    log.warning('代理转发后端未安装：curl_cffi 与 httpx 均不可用（OCR 服务仍可启动，代理功能将禁用）')


def is_available() -> bool:
    """是否有可用的转发后端。"""
    return _BACKEND is not None or httpx is not None

# httpx 回退路径下的全局 cookie jar
_HTTPX_COOKIES = httpx.Cookies() if (httpx is not None and _BACKEND is None) else None

# curl_cffi impersonate 候选：不同版本支持的浏览器版本不同，首次成功后缓存
_CURL_IMPERSONATES = ['chrome124', 'chrome120', 'chrome116', 'chrome110']
_working_impersonate = [None]  # 用 list 包裹以便在闭包内修改

# hop-by-hop / 浏览器专属头：透传会与底层库冲突，统一剥离
_DROP_HEADERS = {
    'host', 'content-length', 'connection', 'transfer-encoding',
    'keep-alive', 'proxy-connection', 'proxy-authorization', 'upgrade',
    'content-encoding',
}


def backend() -> str:
    """当前生效的转发后端名（curl_cffi / httpx / none）。"""
    if _BACKEND:
        return _BACKEND
    return 'httpx' if httpx is not None else 'none'


def reset_cookies():
    """代理出口轮换后清空全局 cookie jar，避免旧 IP 的验证码 cookie 带到新 IP。"""
    if _SESSION is not None:
        try:
            _SESSION.cookies.clear()
        except Exception:
            pass
    if _HTTPX_COOKIES is not None:
        try:
            _HTTPX_COOKIES.clear()
        except Exception:
            pass


def _clean_headers(headers):
    if not headers:
        return {}
    return {k: v for k, v in headers.items() if k.lower() not in _DROP_HEADERS}


def _curl_request(method, url, headers, body, proxy_url, timeout):
    """curl_cffi 路径：带 impersonate，失败逐级降级。"""
    proxies = {'http': proxy_url, 'https': proxy_url} if proxy_url else None
    common = dict(method=method, url=url, headers=headers, data=body,
                  proxies=proxies, timeout=timeout, allow_redirects=False, verify=False)

    if _working_impersonate[0]:
        candidates = [_working_impersonate[0], None]
    else:
        candidates = _CURL_IMPERSONATES + [None]

    last_err = None
    for imp in candidates:
        try:
            r = _SESSION.request(impersonate=imp, **common)
            _working_impersonate[0] = imp  # 记住本次能用的版本
            return r.status_code, dict(r.headers), r.content
        except Exception as e:
            last_err = e
            if imp is None:
                break
            log.debug('curl_cffi impersonate=%s 失败，降级: %s', imp, e)
    raise last_err


def _httpx_request(method, url, headers, body, proxy_url, timeout):
    """httpx 回退路径：per-request 代理 + 全局 cookie jar。"""
    base_kwargs = {'timeout': timeout, 'verify': False, 'cookies': _HTTPX_COOKIES}
    if proxy_url:
        try:
            client = httpx.Client(proxy=proxy_url, **base_kwargs)
        except TypeError:  # 旧版 httpx 用 proxies=
            client = httpx.Client(
                proxies={'http://': proxy_url, 'https://': proxy_url}, **base_kwargs
            )
    else:
        client = httpx.Client(**base_kwargs)
    try:
        r = client.request(method=method, url=url, headers=headers, content=body)
        _HTTPX_COOKIES.update(r.cookies)  # 保持 cookie jar
        return r.status_code, dict(r.headers), r.content
    finally:
        client.close()


def request(method, url, headers=None, body=None, proxy_url=None, timeout=8.0):
    """
    通过代理转发一次请求，返回 (status, headers, body_bytes)。失败抛异常。

    body 可为 str（自动按 utf-8 编码）或 bytes。
    """
    if not is_available():
        raise RuntimeError('代理转发后端未安装（curl_cffi/httpx）')
    if isinstance(body, str):
        body = body.encode('utf-8')
    h = _clean_headers(headers)
    if _BACKEND == 'curl_cffi':
        return _curl_request(method, url, h, body, proxy_url, timeout)
    return _httpx_request(method, url, h, body, proxy_url, timeout)


def probe(proxy_url, target='https://www.bigmodel.cn/', timeout=6.0):
    """
    健康检查：通过代理访问 target，返回延迟(ms)或 None。
    目标默认指向智谱主站，测的是「该代理能否把请求送到智谱」。
    """
    t0 = time.perf_counter()
    try:
        status, _, _ = request('GET', target, proxy_url=proxy_url, timeout=timeout)
        if status < 500:
            return int((time.perf_counter() - t0) * 1000)
        return None
    except Exception:
        return None
