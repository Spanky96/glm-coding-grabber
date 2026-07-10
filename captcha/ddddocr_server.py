"""
ddddocr 本地点选验证码识别 HTTP 服务（高准确率版）

核心策略：
  1. OCR 集成：同一区域用 5 种预处理分别 OCR，投票取置信度最高的结果
  2. 多字体匹配：用系统全部中文字体 × 多尺寸 × 多角度渲染提示字
  3. 全排列搜索：暴力搜索所有分配方案，找综合得分最高的组合
  4. 距离约束：任意两个点击位置不能太近

接口:
  POST /click
  Body: {"image": "<base64>", "remark": "大中小"}
  Response: {"success": true, "data": {"result": "x1,y1|x2,y2|x3,y3"}}
"""

import base64
import io
import logging
import os
import time
from collections import Counter
from itertools import permutations

import cv2
import numpy as np
from flask import Flask, request, jsonify
from PIL import Image, ImageDraw, ImageFont

import ddddocr

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s')
log = logging.getLogger('ddddocr-server')

# ── 代理池（可选：缺依赖或空 proxies.txt 时自动禁用，不影响 OCR） ──
import os as _os
try:
    import proxy_forwarder
    from proxy_pool import ProxyPool
    _PROXY_DEPS_OK = True
except Exception as _e:
    _PROXY_DEPS_OK = False
    proxy_forwarder = None
    ProxyPool = None
    log.warning('代理模块加载失败，代理功能禁用（OCR 不受影响）: %s', _e)

_PROXY_POOL = None
_PROXY_ENABLED = False
_PROXY_SOURCE = 'none'   # 'api' | 'file' | 'none'（/health 暴露，便于前端/排查）
_PROXY_API_URL = None     # API 模式下保存提取链接，preview 后可立即重拉新代理
_PROXY_API_SCHEME = 'http'
_PROXY_ROTATE_LOCK = None
_CAPTCHA_DIR = _os.path.dirname(_os.path.abspath(__file__))
_PROXIES_FILE = _os.path.join(_CAPTCHA_DIR, 'proxies.txt')
_PROXY_API_FILE = _os.path.join(_CAPTCHA_DIR, 'proxy_api.txt')


def _read_api_url():
    """读代理 API 提取地址：环境变量 PROXY_API_URL 优先，其次 proxy_api.txt 首条非注释行。都无返回 None。"""
    url = _os.environ.get('PROXY_API_URL', '').strip()
    if url:
        return url
    if _os.path.exists(_PROXY_API_FILE):
        try:
            with open(_PROXY_API_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    s = line.strip()
                    if s and not s.startswith('#'):
                        return s
        except Exception as e:
            log.warning('读取 proxy_api.txt 失败: %s', e)
    return None


def _init_proxy():
    """启动时加载代理并健康检查：API（若配置）优先，回退 proxies.txt。不可用则禁用（OCR 照常运行）。"""
    global _PROXY_POOL, _PROXY_ENABLED, _PROXY_SOURCE, _PROXY_API_URL, _PROXY_API_SCHEME, _PROXY_ROTATE_LOCK
    if not _PROXY_DEPS_OK or proxy_forwarder is None or ProxyPool is None:
        return
    if not proxy_forwarder.is_available():
        log.warning('代理后端未安装（需 curl-cffi 或 httpx），代理功能禁用')
        return

    api_url = _read_api_url()
    api_scheme = (_os.environ.get('PROXY_API_SCHEME', 'http').strip().lower() or 'http')
    pool = ProxyPool()

    n, source = 0, 'none'
    if api_url:
        n = pool.load_from_api(api_url, scheme=api_scheme)
        source = 'api' if n > 0 else 'none'
        if n == 0:
            log.warning('API 提取失败/为空，回退到 proxies.txt: %s', _PROXIES_FILE)
    if n == 0:
        n = pool.load_from_file(_PROXIES_FILE)
        source = 'file' if n > 0 else 'none'
    if n == 0:
        log.warning('无代理来源（API 与 proxies.txt 均为空），代理功能禁用（OCR 不受影响）')
        return

    log.info('加载 %d 个代理（来源 %s），开始健康检查（目标 %s）...', n, source, pool.health_target)
    healthy = pool.health_check_all()
    if healthy == 0:
        log.warning('健康检查后无可用代理，代理功能禁用')
        return
    _PROXY_POOL = pool
    _PROXY_ENABLED = True
    _PROXY_SOURCE = source
    _PROXY_API_URL = api_url if source == 'api' else None
    _PROXY_API_SCHEME = api_scheme
    log.info('代理池就绪：%d 个可用代理，来源 %s，后端 %s', healthy, source, proxy_forwarder.backend())

    # API 代理短命 → 刷新需重新提取；纯文件模式仅重新健康检查。仅当 init 真正用 API 时才在刷新里重提取，
    # 否则（已回退文件）不反复打一个持续失败的 API。
    interval = int(_os.environ.get('PROXY_REFRESH_SECONDS', '120' if source == 'api' else '300'))
    refresh_api_url = api_url if source == 'api' else None
    import threading
    _PROXY_ROTATE_LOCK = threading.Lock()
    threading.Thread(target=_refresh_loop,
                     args=(pool, refresh_api_url, api_scheme, interval), daemon=True).start()


def _refresh_loop(pool, api_url, scheme, interval):
    """后台定期刷新代理池：配了 API 则重新提取（短命代理），再统一健康检查。失败保留旧池。"""
    while True:
        time.sleep(interval)
        try:
            # API 提取会替换整个池，需与 preview 后立即轮换串行化，避免互相覆盖。
            lock = _PROXY_ROTATE_LOCK
            if lock is None:
                if api_url:
                    got = pool.load_from_api(api_url, scheme=scheme)
                    if got == 0:
                        log.warning('刷新：API 提取失败/为空，保留旧池并重新健康检查')
                pool.health_check_all()
            else:
                with lock:
                    if api_url:
                        got = pool.load_from_api(api_url, scheme=scheme)
                        if got == 0:
                            log.warning('刷新：API 提取失败/为空，保留旧池并重新健康检查')
                    pool.health_check_all()
        except Exception as e:
            log.warning('代理池刷新失败: %s', e)


def _short(url, n=80):
    return url if len(url) <= n else url[:n] + '...'


def _filter_resp_headers(h):
    """剥离 hop-by-hop / 已由后端解压的头，避免前端二次处理。"""
    drop = {'content-encoding', 'content-length', 'transfer-encoding', 'connection'}
    return {k: v for k, v in (h or {}).items() if k.lower() not in drop}


def _is_preview_url(url):
    return bool(url and '/api/biz/pay/preview' in url)


def _discard_used_proxy(session_id, proxy_raw, via_label):
    """用完即弃：释放 session 粘性，永久移除该代理。
    在 API 模式下异步补货（不阻塞当前响应）；文件模式下仅冷却（池有限，不能丢弃）。"""
    if _PROXY_POOL is None:
        return
    try:
        _PROXY_POOL.release_session(session_id)
    except Exception:
        pass
    if proxy_raw is None:
        return

    is_api = (_PROXY_SOURCE == 'api' and bool(_PROXY_API_URL))
    if is_api:
        # API 代理短命，用完即弃 + 异步补货
        _PROXY_POOL.discard(proxy_raw)
        import threading
        threading.Thread(
            target=_safe_refill, args=(_PROXY_API_URL, _PROXY_API_SCHEME),
            daemon=True
        ).start()
        log.info('代理已丢弃: %s，后台补货中...', via_label)
    else:
        # 文件模式：仅冷却（池有限不能丢弃），等冷却结束复用
        # 找到对应 UpstreamProxy 对象来 mark_failure
        try:
            with _PROXY_POOL._lock:
                target = next((p for p in _PROXY_POOL._proxies if p.raw == proxy_raw), None)
            if target:
                _PROXY_POOL.mark_failure(target)
        except Exception:
            pass

    try:
        proxy_forwarder.reset_cookies()
    except Exception:
        pass


def _safe_refill(api_url, scheme):
    """带锁的异步补货，与后台定时刷新互斥。"""
    lock = _PROXY_ROTATE_LOCK
    try:
        if lock:
            with lock:
                _PROXY_POOL.refill_from_api(api_url, scheme=scheme)
        else:
            _PROXY_POOL.refill_from_api(api_url, scheme=scheme)
    except Exception as e:
        log.warning('异步补货失败: %s', e)

# ── 模型 ──────────────────────────────────────────────────────────
log.info('正在加载 ddddocr 模型...')
_det = ddddocr.DdddOcr(det=True, ocr=False, show_ad=False)
_ocr = ddddocr.DdddOcr(det=False, ocr=True, show_ad=False)
log.info('模型加载完成')

# ── 字体 ──────────────────────────────────────────────────────────
# 仅包含 macOS 上真正具有原生中文字形的字体（白名单）
_CHINESE_FONT_PATTERNS = [
    'PingFang', 'STHeiti', 'Songti', 'Hiragino Sans GB',
    'Kaiti', 'Baoli', 'Hanzipen', 'Lantinghei', 'Libian',
    'Weibei', 'Wawati', 'Xingkai', 'Yuanti', 'Yuppy',
    'Heiti', 'Fangsong', 'Arial Unicode',
]

_all_font_paths = []


def _scan_fonts():
    """启动时扫描系统内符合白名单的中文字体,并验证确实能渲染中文（而非 fallback）"""
    import glob

    # 1. 用白名单过滤路径
    all_paths = glob.glob('/System/Library/Fonts/**/*.tt[cf]', recursive=True)
    candidates = [
        p for p in all_paths
        if any(pat.lower() in os.path.basename(p).lower() for pat in _CHINESE_FONT_PATTERNS)
    ]

    # 2. 对每个文件尝试所有 index, 用"拉丁字 vs 中文字"宽度对比排除 fallback
    seen = set()
    for path in candidates:
        if path in seen:
            continue
        for idx in range(8):
            try:
                font = ImageFont.truetype(path, 40, index=idx)
            except Exception:
                break
            # 画一个中文字和一个拉丁字,如果中文字宽度明显大于拉丁字,
            # 说明该字体具备原生中文字形（fallback 到 .notdef 时两者宽度接近）。
            # 用 font.getbbox 拿逻辑宽度,不要依赖像素 getbbox（白底非零会返回整画布）
            try:
                cn_bb = font.getbbox('测')
                en_bb = font.getbbox('A')
                cn_w = cn_bb[2] - cn_bb[0]
                en_w = en_bb[2] - en_bb[0]
            except Exception:
                continue
            if cn_w >= 25 and cn_w >= en_w * 1.3:
                _all_font_paths.append((path, idx))
                seen.add(path)
                break

    log.info(f'扫描到 {len(_all_font_paths)} 个中文字体')


_scan_fonts()

FEAT_SIZE = 32
_font_obj_cache = {}
_variant_cache = {}

# 全局 HOG: 32×32 → 324 维
_HOG_GLOBAL = cv2.HOGDescriptor(
    _winSize=(FEAT_SIZE, FEAT_SIZE),
    _blockSize=(16, 16),
    _blockStride=(8, 8),
    _cellSize=(8, 8),
    _nbins=9,
)

# 象限 HOG: 16×16 → 144 维(每个象限)
# 空间金字塔: 同一字不同半边(如 猜/携 的右半部 青/隽)在象限层面差异大
_HALF = FEAT_SIZE // 2
_HOG_QUAD = cv2.HOGDescriptor(
    _winSize=(_HALF, _HALF),
    _blockSize=(8, 8),
    _blockStride=(8, 8),
    _cellSize=(4, 4),
    _nbins=9,
)


def _to_hog(arr_norm):
    """全局 HOG + 四象限 HOG 拼接 → 324+4×144=900 维"""
    img2d = (arr_norm.reshape(FEAT_SIZE, FEAT_SIZE) * 255).astype(np.uint8)
    feat = _HOG_GLOBAL.compute(img2d).flatten()
    for y1, y2, x1, x2 in [
        (0, _HALF, 0, _HALF),
        (0, _HALF, _HALF, FEAT_SIZE),
        (_HALF, FEAT_SIZE, 0, _HALF),
        (_HALF, FEAT_SIZE, _HALF, FEAT_SIZE),
    ]:
        feat = np.concatenate([feat, _HOG_QUAD.compute(img2d[y1:y2, x1:x2]).flatten()])
    return feat


def _get_font(path, idx, size):
    key = (path, idx, size)
    if key not in _font_obj_cache:
        try:
            _font_obj_cache[key] = ImageFont.truetype(path, size, index=idx)
        except Exception:
            return None
    return _font_obj_cache[key]


def _render_variants(char):
    """
    渲染单个汉字的所有变体（多字体 × 多尺寸 × 多角度）。
    结果全局缓存，相同字只渲染一次。
    """
    if char in _variant_cache:
        return _variant_cache[char]

    variants = []
    for size in [30, 36, 42]:
        for path, idx in _all_font_paths:
            font = _get_font(path, idx, size)
            if not font:
                continue
            for angle in [-25, -15, 0, 15, 25]:
                canvas = size + 30
                # 黑底白字渲染,getbbox 能正确返回字形边框
                img = Image.new('L', (canvas, canvas), 0)
                draw = ImageDraw.Draw(img)
                draw.text((15, 10), char, fill=255, font=font)
                bbox = img.getbbox()
                if bbox:
                    img = img.crop(bbox)
                if angle != 0:
                    img = img.rotate(angle, fillcolor=0, expand=False)
                img = img.resize((FEAT_SIZE, FEAT_SIZE), Image.LANCZOS)
                arr = np.array(img, dtype=np.float32) / 255.0  # 文字=1.0,背景=0.0
                variants.append(_to_hog(arr.flatten()))

    _variant_cache[char] = variants
    # log.info(f'渲染 "{char}": {len(variants)} 个变体')
    return variants


# ── 预处理 ────────────────────────────────────────────────────────

def _crop_image(img: Image.Image, box: list) -> bytes:
    x1, y1, x2, y2 = box
    pad = 3
    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
    x2, y2 = min(img.width, x2 + pad), min(img.height, y2 + pad)
    cropped = img.crop((x1, y1, x2, y2))
    buf = io.BytesIO()
    cropped.save(buf, format='PNG')
    return buf.getvalue()


def _arr_to_bytes(arr):
    buf = io.BytesIO()
    Image.fromarray(arr.astype(np.uint8)).save(buf, format='PNG')
    return buf.getvalue()


def _extract_feat(pil_img):
    """从检测区域提取 HOG 特征向量(笔画方向直方图)"""
    gray = np.array(pil_img.convert('L'))
    # CLAHE 增强对比度
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
    enhanced = clahe.apply(gray)
    # 自适应二值化
    binary = cv2.adaptiveThreshold(
        enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 11, 2
    )
    # 检测背景明暗:若多数像素是黑(说明二值化后前景=白底),不动;否则反色,确保前景=白
    if (binary == 0).sum() < (binary == 255).sum():
        binary = 255 - binary
    resized = cv2.resize(binary, (FEAT_SIZE, FEAT_SIZE), interpolation=cv2.INTER_LANCZOS4)
    arr = resized.astype(np.float32) / 255.0  # 前景=1.0,背景=0.0
    return _to_hog(arr.flatten())


def _ocr_ensemble(crop_bytes):
    """
    同一区域用 5 种预处理分别 OCR，返回 (最佳字符, 置信度, 所有结果集合)。
    """
    img = Image.open(io.BytesIO(crop_bytes))
    gray = np.array(img.convert('L'))

    results = []
    # 1. 原图
    results.append(_ocr.classification(crop_bytes))
    # 2. Otsu 二值化
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    results.append(_ocr.classification(_arr_to_bytes(binary)))
    # 3. CLAHE 增强
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
    results.append(_ocr.classification(_arr_to_bytes(clahe.apply(gray))))
    # 4. 反色
    results.append(_ocr.classification(_arr_to_bytes(255 - gray)))
    # 5. 高斯模糊 + Otsu
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    _, binary2 = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    results.append(_ocr.classification(_arr_to_bytes(binary2)))

    counter = Counter(results)
    char, count = counter.most_common(1)[0]
    confidence = count / len(results)
    return char, confidence, set(results)


# ── 相似度 ────────────────────────────────────────────────────────

def _cosine_sim(a, b):
    a = a - a.mean()
    b = b - b.mean()
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-7 or nb < 1e-7:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _best_variant_sim(variants, feat):
    """在所有渲染变体中找最高相似度"""
    best = -1.0
    for v in variants:
        s = _cosine_sim(v, feat)
        if s > best:
            best = s
    return best


def _dist(a, b):
    return ((a['x'] - b['x']) ** 2 + (a['y'] - b['y']) ** 2) ** 0.5


# ── 核心识别 ──────────────────────────────────────────────────────

def solve_click_captcha(img_bytes: bytes, prompt: str) -> list[dict]:
    # ── 1. 检测 ──
    boxes = _det.detection(img_bytes)
    if not boxes:
        raise ValueError('未检测到任何目标')

    img = Image.open(io.BytesIO(img_bytes))
    min_dist = min(img.width, img.height) * 0.10

    # ── 2. 裁剪 + OCR 集成 + 特征提取 ──
    detected = []
    for box in boxes:
        crop_bytes = _crop_image(img, box)
        char, confidence, all_results = _ocr_ensemble(crop_bytes)
        cx = (box[0] + box[2]) / 2
        cy = (box[1] + box[3]) / 2
        crop_img = Image.open(io.BytesIO(crop_bytes))
        feat = _extract_feat(crop_img)
        detected.append({
            'char': char,
            'confidence': confidence,
            'all_ocr': all_results,
            'x': cx, 'y': cy,
            'feat': feat,
        })

    ocr_summary = [f'{d["char"]}({d["confidence"]:.0%})' for d in detected]
    #log.info(f'检测到 {len(detected)} 个目标: {ocr_summary}')
    #log.info(f'提示字符: {list(prompt)}, 最小距离: {min_dist:.0f}px')

    # ── 3. 渲染提示字变体 ──
    prompt_vars = {}
    for ch in set(prompt):
        prompt_vars[ch] = _render_variants(ch)

    # ── 4. 综合评分矩阵 ──
    n = len(prompt)
    m = len(detected)
    score = [[0.0] * m for _ in range(n)]

    for pi in range(n):
        variants = prompt_vars[prompt[pi]]
        for di in range(m):
            # (a) 图像相似度 (范围约 -1 ~ 1) —— 主导项
            img_sim = _best_variant_sim(variants, detected[di]['feat'])

            # (b) OCR 集成加分 —— 仅作辅助信号,不能压过图像相似度
            # img_sim 大致 0.2~0.7 区分不同字,OCR bonus 上限 0.3 仅微调
            ocr_bonus = 0.0
            if detected[di]['char'] == prompt[pi]:
                ocr_bonus = 0.3 * detected[di]['confidence']
            elif prompt[pi] in detected[di]['all_ocr']:
                ocr_bonus = 0.1

            score[pi][di] = img_sim + ocr_bonus

    # 打印评分矩阵
    for pi in range(n):
        row = ', '.join(f'{score[pi][di]:.2f}' for di in range(m))
        # log.info(f'评分[{prompt[pi]}]: [{row}]')

    # ── 5. 全排列搜索（找总分最高的合法分配） ──
    best_total = -float('inf')
    best_perm = None

    for perm in permutations(range(m), n):
        # 距离约束
        ok = True
        for i in range(n):
            for j in range(i + 1, n):
                if _dist(detected[perm[i]], detected[perm[j]]) < min_dist:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue

        total = sum(score[i][perm[i]] for i in range(n))
        if total > best_total:
            best_total = total
            best_perm = perm

    # 无合法分配时放宽约束
    if best_perm is None:
        log.warning('无可行分配，放宽距离约束')
        for perm in permutations(range(m), n):
            total = sum(score[i][perm[i]] for i in range(n))
            if total > best_total:
                best_total = total
                best_perm = perm

    # ── 6. 组装结果 ──
    result = []
    for i in range(n):
        di = best_perm[i]
        d = detected[di]
        result.append({'x': round(d['x'], 1), 'y': round(d['y'], 1)})
        # log.info(
        #     f'  "{prompt[i]}" → 检测[{di}] '
        #     f'(OCR="{d["char"]}" {d["confidence"]:.0%}, '
        #     f'score={score[i][di]:.3f})'
        # )

    return result


# ── HTTP ──────────────────────────────────────────────────────────

@app.route('/click', methods=['POST'])
def click():
    t0 = time.time()
    try:
        data = request.get_json(force=True)
        image_b64 = data.get('image', '')
        prompt = data.get('remark', '')

        if not image_b64 or not prompt:
            return jsonify({'success': False, 'message': '缺少参数'}), 400

        img_bytes = base64.b64decode(image_b64)
        points = solve_click_captcha(img_bytes, prompt)
        result_str = '|'.join(f'{p["x"]},{p["y"]}' for p in points)

        elapsed = (time.time() - t0) * 1000
        log.info(f'完成: prompt="{prompt}" result="{result_str}" 耗时={elapsed:.0f}ms')

        return jsonify({
            'success': True,
            'data': {'result': result_str, 'id': ''}
        })
    except Exception as e:
        elapsed = (time.time() - t0) * 1000
        log.error(f'失败 ({elapsed:.0f}ms): {e}')
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/proxy', methods=['POST'])
def proxy_forward_route():
    """通用转发：请求始终经后端发出。有代理池→走代理出口；无代理池→后端直连转发。
    body: {method, url, headers, body, session}（session 用于出口粘性）。

    代理生命周期：每次「验证码+preview」组合结束后，该代理即被丢弃：
      - API 模式：永久移除 + 异步补货新 IP
      - 文件模式：冷却 60s 后复用（池有限不能丢弃）
    """
    if not proxy_forwarder or not proxy_forwarder.is_available():
        return jsonify({'success': False, 'error': '后端转发库未安装（curl-cffi/httpx）'}), 503
    try:
        data = request.get_json(force=True)
        method = (data.get('method') or 'GET').upper()
        url = data.get('url')
        headers = data.get('headers') or {}
        body = data.get('body')
        session_id = data.get('session')
        rotate_after = bool(data.get('rotate_after')) or _is_preview_url(url)
        if not url:
            return jsonify({'success': False, 'error': '缺少 url'}), 400

        # 有代理池且非空 → 选代理；否则 None（后端用 curl_cffi/httpx 直连转发）
        proxy = None
        if _PROXY_ENABLED and _PROXY_POOL is not None:
            try:
                proxy = _PROXY_POOL.get(session_id)
            except Exception:
                proxy = None
        proxy_url = proxy.proxy_url if proxy else None
        via = proxy.address if proxy else 'direct'

        t0 = time.time()
        try:
            status, resp_headers, resp_body = proxy_forwarder.request(
                method, url, headers=headers, body=body,
                proxy_url=proxy_url, timeout=12.0
            )
        except Exception as e:
            log.warning('转发失败 (%s): %s', via, e)
            if proxy is not None and _PROXY_POOL is not None:
                _discard_used_proxy(session_id, proxy.raw, via)
            return jsonify({'success': False, 'error': '转发失败: %s' % e, 'proxy': via}), 502

        elapsed = int((time.time() - t0) * 1000)
        log.info('转发 %s %s → %d (%dms) via %s', method, _short(url), status, elapsed, via)
        rotated = False
        if rotate_after and proxy is not None:
            _discard_used_proxy(session_id, proxy.raw, via)
            rotated = True
        return jsonify({
            'success': status < 500,
            'status': status,
            'headers': _filter_resp_headers(resp_headers),
            'body': base64.b64encode(resp_body).decode('ascii'),
            'proxy': via,
            'rotated': rotated,
        })
    except Exception as e:
        log.error('转发异常: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/proxy/discard', methods=['POST'])
def discard_proxy_route():
    """JS 端在 proxyViaLocal 超时/网络错误时调用，确保当前 session 绑定的代理被丢弃。
    body: {session} — 与 /proxy 转发同款的 session 标识。"""
    if not _PROXY_ENABLED or _PROXY_POOL is None:
        return jsonify({'success': False, 'error': '代理池未启用'}), 503
    try:
        data = request.get_json(force=True)
        session_id = data.get('session')
        if not session_id:
            return jsonify({'success': False, 'error': '缺少 session'}), 400
        # 找到该 session 绑定的 proxy raw 并丢弃
        with _PROXY_POOL._lock:
            bound_raw = _PROXY_POOL._session.get(session_id)
        if bound_raw:
            _discard_used_proxy(session_id, bound_raw, bound_raw)
            return jsonify({'success': True, 'discarded': bound_raw})
        else:
            _PROXY_POOL.release_session(session_id)
            return jsonify({'success': True, 'discarded': None, 'note': 'session 未绑定代理'})
    except Exception as e:
        log.error('discard 异常: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/health', methods=['GET'])
def health():
    backend_ok = proxy_forwarder is not None and proxy_forwarder.is_available()
    proxy_info = {
        'enabled': backend_ok,         # 后端具备转发能力（与是否有代理无关）
        'ready': backend_ok,           # 前端据此判断能否走 /proxy
        'has_proxies': bool(_PROXY_ENABLED and _PROXY_POOL is not None),
        'source': _PROXY_SOURCE,       # 'api' | 'file' | 'none'：代理来源，便于排查
    }
    if proxy_forwarder is not None:
        proxy_info['backend'] = proxy_forwarder.backend()
    if _PROXY_ENABLED and _PROXY_POOL is not None:
        proxy_info.update(_PROXY_POOL.stats())
    return jsonify({
        'status': 'ok', 'engine': 'ddddocr', 'fonts': len(_all_font_paths),
        'proxy': proxy_info,
    })


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='ddddocr 点选验证码识别服务')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=9898)
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()

    _init_proxy()  # 加载并健康检查代理池（缺失则自动禁用，不影响 OCR）
    log.info(f'启动: http://{args.host}:{args.port} ({len(_all_font_paths)} 个中文字体, 代理={"on" if _PROXY_ENABLED else "off"})')
    app.run(host=args.host, port=args.port, debug=args.debug)
