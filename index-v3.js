// ==UserScript==
// @name         GLM抢号-v3
// @namespace    05info
// @author       Spanky
// @version      3.0.0
// @description  纯接口抢购 + 代理池（preview 与验证码请求经本地代理出口，规避 IP 限流）
// @match        https://*.bigmodel.cn/glm-coding*
// @match        https://*.gtimg.com/*
// @match        https://*.captcha.qcloud.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// @require      https://cdn.bootcdn.net/ajax/libs/qrcode/1.5.0/qrcode.min.js
// @require      https://cdn.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.min.js
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      turing.captcha.qcloud.com
// @connect      127.0.0.1:9898
// @connect      127.0.0.1
// @connect      *
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// ==/UserScript==

(function (win) {
    'use strict';

    // ==================== 检测是否在验证码 iframe 内 ====================
    var _host = '';
    try { _host = location.hostname || ''; } catch (e) {}
    var inCaptchaFrame = _host.indexOf('gtimg.com') >= 0 || _host.indexOf('captcha.qcloud.com') >= 0;

    if (inCaptchaFrame) {
        console.log('%c[CaptchaSolver] iframe 模式启动, host=' + _host, 'color:#f0c040');
        initCaptchaSolver();
        return;
    }

    // ==================== 验证码自动解题（iframe 内运行） ====================
    function initCaptchaSolver() {
        var CLICK_OCR_URL = 'http://127.0.0.1:9898/click';

        function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        function getAntiDetect() {
            try { return GM_getValue('v2_anti_detect') === 'true' || GM_getValue('v2_anti_detect') === true; } catch (e) {}
            try { return localStorage.getItem('v2_anti_detect') === 'true'; } catch (e) {}
            return false;
        }
        function log(msg) { console.log('%c[CaptchaSolver] ' + msg, 'color:#58a6ff'); }

        function currentProxySession() {
            try { return GM_getValue('v3_proxy_session') || ''; } catch (e) {}
            try { return localStorage.getItem('v3_proxy_session') || ''; } catch (e) {}
            return '';
        }

        // 将代理出口 IP 写入共享存储，供主页面面板展示
        function saveProxyIp(ip) {
            if (!ip) return;
            try { if (typeof GM_setValue !== 'undefined') GM_setValue('v3_last_proxy_ip', ip); } catch (e) {}
            try { localStorage.setItem('v3_last_proxy_ip', ip); } catch (e) {}
        }

        function fetchImage(url) {
            // v3：验证码图片走代理（B 层）。iframe 分支无 CONFIG/proxyViaLocal，内联 /proxy 调用
            var PROXY_URL = 'http://127.0.0.1:9898/proxy';
            if (isProxyEnabled() && typeof GM_xmlhttpRequest !== 'undefined') {
                return new Promise(function (resolve, reject) {
                    GM_xmlhttpRequest({
                        method: 'POST', url: PROXY_URL,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ method: 'GET', url: url, headers: {}, body: null, session: currentProxySession() || undefined }),
                        timeout: 8000,
                        onload: function (r) {
                            try {
                                var p = JSON.parse(r.responseText);
                                if (p.proxy) saveProxyIp(p.proxy);
                                if (p.success && p.body) resolve('data:image/png;base64,' + p.body);
                                else reject(new Error('代理图片失败'));
                            } catch (e) { reject(e); }
                        },
                        onerror: function () { reject(new Error('代理不可达')); }
                    });
                });
            }
            return new Promise(function (resolve, reject) {
                if (typeof GM_xmlhttpRequest !== 'undefined') {
                    GM_xmlhttpRequest({
                        method: 'GET', url: url, responseType: 'blob',
                        onload: function (r) {
                            var reader = new FileReader();
                            reader.onload = function () { resolve(reader.result); };
                            reader.readAsDataURL(r.response);
                        },
                        onerror: function () { reject(new Error('下载图片失败')); }
                    });
                } else {
                    fetch(url).then(function (r) { return r.blob(); })
                    .then(function (b) {
                        var reader = new FileReader();
                        reader.onload = function () { resolve(reader.result); };
                        reader.readAsDataURL(b);
                    }).catch(reject);
                }
            });
        }

        function callClickOcr(imgData, text) {
            var base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
            var body = JSON.stringify({ image: base64, remark: text });
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                return new Promise(function (resolve, reject) {
                    GM_xmlhttpRequest({
                        method: 'POST', url: CLICK_OCR_URL,
                        headers: { 'Content-Type': 'application/json' },
                        data: body,
                        onload: function (r) {
                            try { resolve(JSON.parse(r.responseText)); }
                            catch (e) { reject(new Error('响应解析失败')); }
                        },
                        onerror: function () { reject(new Error('ddddocr 连接失败')); }
                    });
                });
            }
            return fetch(CLICK_OCR_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
            }).then(function (r) { return r.json(); });
        }

        async function ocrRecognize(imgData, text) {
            try {
                var resp = await callClickOcr(imgData, text);
                log('ddddocr: ' + JSON.stringify(resp).substring(0, 150));
                if (resp.success && resp.data && resp.data.result) {
                    return resp.data.result.split('|').map(function (p) {
                        var xy = p.split(',');
                        return { x: parseFloat(xy[0]), y: parseFloat(xy[1]) };
                    });
                }
            } catch (e) { log('ddddocr 失败: ' + e.message); }
            return [];
        }

        function getImageSize(dataUrl) {
            return new Promise(function (resolve) {
                var img = new Image();
                img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
                img.onerror = function () { resolve(null); };
                img.src = dataUrl;
            });
        }

        function simulateClick(el, x, y, imgW, imgH) {
            var rect = el.getBoundingClientRect();
            var scaleX = imgW > 0 ? rect.width / imgW : 1;
            var scaleY = imgH > 0 ? rect.height / imgH : 1;
            // 点击偏移与防检测开关无关，始终带随机偏移，模拟真人落点散布（±20px）
            var offsetX = (Math.random() - 0.5) * 40;
            var offsetY = (Math.random() - 0.5) * 40;
            var cx = rect.left + x * scaleX + offsetX;
            var cy = rect.top + y * scaleY + offsetY;
            var win = el.ownerDocument.defaultView || window;

            var base = { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: win };
            var pointer = Object.assign({}, base, {
                pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, pressure: 0.5
            });

            try { if (win.PointerEvent) el.dispatchEvent(new win.PointerEvent('pointerdown', pointer)); } catch (e) {}
            el.dispatchEvent(new win.MouseEvent('mousedown', base));
            try { if (win.PointerEvent) el.dispatchEvent(new win.PointerEvent('pointerup', pointer)); } catch (e) {}
            el.dispatchEvent(new win.MouseEvent('mouseup', base));
            el.dispatchEvent(new win.MouseEvent('click', base));
        }

        function isSolved() {
            var el = document.querySelector('.tc-success');
            return el && el.style.visibility !== 'hidden' && el.style.visibility !== '';
        }

        function hasError() {
            var noteEl = document.querySelector('#tcaptcha_note');
            if (!noteEl) return false;
            var noteWrap = noteEl.closest('.tc-note');
            return noteWrap && noteWrap.style.visibility !== 'hidden' && noteWrap.style.visibility !== '';
        }

        var solving = false;
        var lastBgUrl = '';

        async function trySolveOnce() {
            var bgEl = document.querySelector('#slideBg');
            if (!bgEl) return 'wait';

            var bgStyle = bgEl.style.backgroundImage || '';
            var match = bgStyle.match(/url\(["']?([^"')]+)/);
            if (!match) return 'wait';

            if (isSolved()) return 'solved';

            if (hasError()) {
                log('错误提示，刷新');
                var rb = document.querySelector('#reload');
                if (rb) rb.click();
                lastBgUrl = '';
                await sleep(1500);
                return 'retry';
            }

            var bgUrl = match[1];
            if (bgUrl === lastBgUrl) return 'same';
            lastBgUrl = bgUrl;

            var instrEl = document.querySelector('#instructionText');
            if (!instrEl) return 'wait';
            var rawText = instrEl.textContent || '';
            if (rawText.indexOf('错误') >= 0 || rawText.indexOf('重试') >= 0 || rawText.indexOf('失败') >= 0) {
                log('错误文本，刷新');
                var rb2 = document.querySelector('#reload');
                if (rb2) rb2.click();
                lastBgUrl = '';
                await sleep(1500);
                return 'retry';
            }
            var text = rawText.replace(/请依次点击[：:]\s*/, '').replace(/\s+/g, '').trim();
            log('目标字符: ' + text);

            var imgData;
            try { imgData = await fetchImage(bgUrl); }
            catch (e) { log('图片下载失败: ' + e.message); return 'retry'; }

            var imgSize = await getImageSize(imgData);
            var imgW = imgSize ? imgSize.w : 340;
            var imgH = imgSize ? imgSize.h : 195;

            var coords = await ocrRecognize(imgData, text);
            if (!coords || coords.length === 0) { log('OCR 无结果'); return 'retry'; }

            log('坐标: ' + coords.map(function (c) { return c.x + ',' + c.y; }).join(' | ') + ' (' + imgW + 'x' + imgH + ')');

            for (var i = 0; i < coords.length; i++) {
                simulateClick(bgEl, coords[i].x, coords[i].y, imgW, imgH);
                await sleep(getAntiDetect() ? randInt(300, 600) : 150);
            }

            await sleep(getAntiDetect() ? randInt(400, 700) : 300);
            var confirmBtn = document.querySelector('.verify-btn');
            if (confirmBtn) confirmBtn.click();
            return 'clicked';
        }

        async function solveCurrentCaptcha() {
            if (solving) return;
            solving = true;
            for (var i = 0; i < 15; i++) {
                if (isSolved()) { log('验证通过!'); solving = false; return; }
                var result = await trySolveOnce();
                if (result === 'solved') { log('验证通过!'); solving = false; return; }
                if (result === 'same' || result === 'wait') { await sleep(800); continue; }
                if (result === 'clicked') {
                    await sleep(1500);
                    if (isSolved()) { log('验证通过!'); solving = false; return; }
                    if (hasError()) {
                        log('识别错误，刷新重试');
                        var refreshBtn = document.querySelector('#reload');
                        if (refreshBtn) refreshBtn.click();
                        lastBgUrl = '';
                        await sleep(1500);
                    }
                    continue;
                }
                await sleep(800);
            }
            solving = false;
        }

        function checkAndSolve() {
            if (solving || isSolved()) return;
            var bgEl = document.querySelector('#slideBg');
            if (!bgEl) return;
            var bgStyle = bgEl.style.backgroundImage || '';
            if (!bgStyle) return;
            solveCurrentCaptcha();
        }

        log('验证码解题器已启动 (持续监听, GM=' + (typeof GM_xmlhttpRequest !== 'undefined') + ')');
        var observer = new MutationObserver(function () { setTimeout(checkAndSolve, 100); });
        observer.observe(document.body || document.documentElement, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['style']
        });
        setTimeout(checkAndSolve, 1000);
        setInterval(checkAndSolve, 2000);
    }

    // ==================== 产品ID映射（静态默认值，会被 batch-preview 动态更新） ====================
    // productId -> 静态配置（unit/type 用于分类）
    var PRODUCT_STATIC = {
        'product-02434c': { unit: 'month',   type: 'lite', name: 'Lite 月付' },
        'product-1df3e1': { unit: 'month',   type: 'pro',  name: 'Pro 月付'  },
        'product-2fc421': { unit: 'month',   type: 'max',  name: 'Max 月付'  },
        'product-b8ea38': { unit: 'quarter', type: 'lite', name: 'Lite 季付' },
        'product-fef82f': { unit: 'quarter', type: 'pro',  name: 'Pro 季付'  },
        'product-5d3a03': { unit: 'quarter', type: 'max',  name: 'Max 季付'  },
        'product-70a804': { unit: 'year',    type: 'lite', name: 'Lite 年付' },
        'product-5643e6': { unit: 'year',    type: 'pro',  name: 'Pro 年付'  },
        'product-d46f8b': { unit: 'year',    type: 'max',  name: 'Max 年付'  }
    };

    var PRODUCTS = {
        month: {
            lite: { productId: 'product-02434c', name: 'Lite 月付', price: 49,   soldOut: true, confirmedSoldOut: false },
            pro:  { productId: 'product-1df3e1', name: 'Pro 月付',  price: 149,  soldOut: true, confirmedSoldOut: false },
            max:  { productId: 'product-2fc421', name: 'Max 月付',  price: 469,  soldOut: true, confirmedSoldOut: false }
        },
        quarter: {
            lite: { productId: 'product-b8ea38', name: 'Lite 季付', price: 147,  soldOut: true, confirmedSoldOut: false },
            pro:  { productId: 'product-fef82f', name: 'Pro 季付',  price: 447,  soldOut: true, confirmedSoldOut: false },
            max:  { productId: 'product-5d3a03', name: 'Max 季付',  price: 1407, soldOut: true, confirmedSoldOut: false }
        },
        year: {
            lite: { productId: 'product-70a804', name: 'Lite 年付', price: 588,  soldOut: true, confirmedSoldOut: false },
            pro:  { productId: 'product-5643e6', name: 'Pro 年付',  price: 1788, soldOut: true, confirmedSoldOut: false },
            max:  { productId: 'product-d46f8b', name: 'Max 年付',  price: 5628, soldOut: true, confirmedSoldOut: false }
        }
    };

    // 用 batch-preview 响应动态更新 PRODUCTS
    function updateProductsFromBatchPreview(productList) {
        if (!Array.isArray(productList)) return;
        var updated = 0;
        productList.forEach(function (p) {
            var staticInfo = PRODUCT_STATIC[p.productId];
            if (!staticInfo) return;
            var target = PRODUCTS[staticInfo.unit] && PRODUCTS[staticInfo.unit][staticInfo.type];
            if (!target) return;
            target.price = p.originalAmount || target.price;
            target.payAmount = p.payAmount;
            target.soldOut = !!p.soldOut;
            target.renewAmount = p.renewAmount;
            updated++;
        });
        log('产品', '已更新 ' + updated + ' 个产品价格/库存');
        updateSoldOutTags();
        updateAltHelpSoldOutTags();
        syncAlternativeSoldOutFromBatchPreview();
    }

    // 调剂模式：用 batch-preview 的真实结果同步已接受套餐的售罄状态
    //  - 报有货 → 清除 confirmedSoldOut（复活，重新进入轮换）
    //  - 报售罄 → 置 confirmedSoldOut（移出轮换）
    // 仅在 batch-preview 成功(200)后调用；而 batch-preview 在 30s 锁定窗口内不发，故天然只在窗口后生效。
    function syncAlternativeSoldOutFromBatchPreview() {
        if (!acceptAlternativeEnabled()) return;
        var accepted = getEnabledAlternativeProducts();
        var revived = 0, marked = 0;
        accepted.forEach(function (p) {
            if (p.soldOut && !p.confirmedSoldOut) { p.confirmedSoldOut = true; marked++; }
            else if (!p.soldOut && p.confirmedSoldOut) { p.confirmedSoldOut = false; revived++; }
        });
        if (revived > 0 || marked > 0) {
            log('库存', 'batch-preview 同步调剂状态：复活 ' + revived + '，标记售罄 ' + marked);
            renderAltSummary();
        }
    }

    // ==================== 配置 ====================
    var CONFIG = {
        BUY_TIME_DEFAULT: '10:00:00',
        PACKAGE_TYPE_DEFAULT: 'quarter',
        TIER_DEFAULT: 'max',
        CAPTCHA_APP_ID: '196026326',
        OCR_BACKEND: 'ddddocr',
        DDDDOCR_URL: 'http://127.0.0.1:9898/click',
        CAPTCHA_MAX_RETRY: 10,
        RETRY_ON_BUSY: 0,
        RETRY_INTERVAL: 300,
        // 预存 token 之间 preview 请求间隔（ms）
        PRECACHE_INTERVAL: 1800,
        ENABLE_MANUAL_BIZID: false,
        // batch-preview 定期轮询间隔（ms）
        ALT_POLL_INTERVAL: 30000,
        // 开始抢购后的「锁定窗口」：此期间不发 batch-preview、不允许手动刷新、不因售罄终止
        // 目的是绕开放号瞬间 batch-preview 被限流导致的假售罄，保证窗口内认定非售罄
        REFRESH_LOCKOUT_MS: 30000,
        // batch-preview 命中 555 繁忙后的重试间隔（ms）
        REFRESH_BUSY_RETRY_MS: 5000,
        // 库存刷新记录表最多保留条数
        REFRESH_LOG_MAX: 12,
        // 控流：preview 返回 555/500 时的暂停时长（ms），勾选「控流」后生效
        THROTTLE_555_MS: 3000,
        THROTTLE_500_MS: 8000,
        // ── 代理池（v3）── 走本地 ddddocr 服务的 /proxy 接口转发（与 OCR 同端口）
        PROXY_URL: 'http://127.0.0.1:9898/proxy',
        PROXY_HEALTH_URL: 'http://127.0.0.1:9898/health',
        PROXY_TIMEOUT: 15000,           // 单次代理转发超时（ms）：preview 后会同步换代理+健康检查
        // 匹配这些 host 的请求改走代理：腾讯验证码（拿 ticket 的核心）+ 验证码图片 CDN（A+B 层）
        PROXY_HOST_RE: /captcha\.qcloud\.com|turing\.captcha|captcha\.qq\.com|\.gtimg\.com/i,
        // 走代理的业务接口后缀（preview 最易被限流；预热/锁单/状态直连更稳）
        PROXY_API_SUFFIXES: ['/biz/pay/preview']
    };

    // ==================== 状态 ====================
    var state = {
        running: false,
        timer: null,
        captchaHandling: false,
        userInfo: null,
        customerNumber: null,
        customerName: '',
        cachedTokens: [],
        lockOrderDone: false,
        lockOrderInProgress: false,
        precacheRunning: false,
        lastPipelineSoldOut: false,
        wasSoldOutAtStart: false,
        // 防检测限流：已占用的10秒槽位，保证每槽最多1个 preview（-1 表示尚未占用）
        lastPreviewSlot: -1,
        // 库存刷新锁定窗口：Date.now() < refreshUnlockTime 期间不发 batch-preview、不允许手动刷新、不因售罄终止
        refreshUnlockTime: 0,
        refreshUnlockTimer: null,
        // 最近一次 batch-preview 的真实返回（用于套餐栏展示真实 code）
        lastRefreshResult: null,
        // 库存刷新记录（轮询/手动共用，渲染到「库存刷新记录」表）
        refreshLogs: [],
        // ── 代理池（v3）──
        proxyEnabled: false,            // 用户开关：是否启用代理
        proxyReady: false,              // 后端能转发 /proxy（库已装、服务在）
        proxyHasProxies: false,         // 后端是否有实际可用代理（无则后端直连转发）
        proxySession: '',               // 出口粘性标识：同一次抢购的「验证码+preview」绑同一 IP
        lastProxyIp: '',                // 最近一次 /proxy 转发使用的出口 IP（面板展示用）
        autoReloginEnabled: false,      // 用户开关：token 失效时是否自动重登（须配合已配置的账密）
        lockoutArmed: false             // 本轮是否已在「到点」激活过库存锁定窗口（防重入，点击开始时重置）
    };

    // ==================== 服务器时间同步 ====================
    var serverTimeOffset = 0; // ms, positive = server ahead

    async function measureServerOffset() {
        var offsets = [];
        for (var i = 0; i < 5; i++) {
            try {
                var t0 = performance.now();
                var wallBefore = Date.now();
                var resp = await fetch(location.origin + '/', {
                    method: 'HEAD', credentials: 'include', cache: 'no-store'
                });
                var t1 = performance.now();
                var dateStr = resp.headers.get('Date');
                if (!dateStr) continue;
                var serverTs = new Date(dateStr).getTime();
                var rtt = t1 - t0;
                var localMid = wallBefore + rtt / 2;
                offsets.push(serverTs - localMid);
            } catch (e) {
                log('时间同步', '采样失败: ' + e.message);
            }
            if (i < 4) await sleep(300);
        }
        if (offsets.length === 0) return 0;
        offsets.sort(function(a, b) { return a - b; });
        return offsets[Math.floor(offsets.length / 2)];
    }

    async function syncServerTime() {
        var offset = await measureServerOffset();
        serverTimeOffset = offset;
        serverTimeOffset -= 30;
        var direction = offset > 0 ? '服务器快' : '本机快';
        log('时间同步', 'offset=' + offset.toFixed(0) + 'ms (' + direction + Math.abs(offset).toFixed(0) + 'ms)');
        // 面板上永久显示偏移量
        var offsetEl = document.getElementById('v2-time-offset');
        if (offsetEl) {
            offsetEl.textContent = (offset > 0 ? '+' : '') + (offset / 1000).toFixed(2) + 's';
            offsetEl.title = '时钟偏移: ' + direction + Math.abs(offset).toFixed(0) + 'ms';
        }
    }

    function getServerTime() {
        return Date.now() + serverTimeOffset;
    }

    // ==================== 连接预热 ====================
    var preheatTimer = null;

    function startConnectionPreheat() {
        if (preheatTimer) return;
        log('预热', '开始连接预热 (每30s一次 batch-preview)');
        preheatTimer = setInterval(function() {
            if (isRefreshLocked()) return; // 锁定窗口内不发 batch-preview
            requestBatchPreview();
        }, CONFIG.ALT_POLL_INTERVAL);
        if (!isRefreshLocked()) requestBatchPreview();
    }

    function stopConnectionPreheat() {
        if (preheatTimer) {
            clearInterval(preheatTimer);
            preheatTimer = null;
            log('预热', '停止连接预热');
        }
    }

    // ==================== 库存刷新锁定窗口 / 工具 ====================
    // 锁定窗口：开始抢购后 REFRESH_LOCKOUT_MS 内强制认定非售罄——不发 batch-preview、不允许手动刷新、不因售罄终止。
    // 目的是绕开放号瞬间 batch-preview 被限流返回 stale soldOut 导致的假售罄。
    function isRefreshLocked() {
        return Date.now() < state.refreshUnlockTime;
    }

    function refreshLockRemainingSec() {
        if (!isRefreshLocked()) return 0;
        return Math.ceil((state.refreshUnlockTime - Date.now()) / 1000);
    }

    // 是否允许因售罄而切换/终止。锁定窗口内一律不允许——强制认定非售罄，持续重试。
    function canActOnSoldOut() {
        return !isRefreshLocked();
    }

    // 强制清掉所有产品的售罄状态（乐观视为有货）。同时清展示用 soldOut 与权威 confirmedSoldOut。
    function forceNonSoldOut() {
        Object.keys(PRODUCTS).forEach(function (unit) {
            Object.keys(PRODUCTS[unit]).forEach(function (tier) {
                PRODUCTS[unit][tier].soldOut = false;
                PRODUCTS[unit][tier].confirmedSoldOut = false;
            });
        });
        updateProductInfo();
        updateSoldOutTags();
        updateAltHelpSoldOutTags();
    }

    // 记录一次 batch-preview 刷新结果（轮询/手动共用），渲染到「库存刷新记录」表
    function recordRefresh(source, resp, errMsg) {
        var entry = { time: new Date().toLocaleTimeString(), source: source || '轮询' };
        if (resp && resp.code === 200 && resp.data && Array.isArray(resp.data.productList)) {
            var list = resp.data.productList;
            var inStock = list.filter(function (p) { return !p.soldOut; }).length;
            entry.code = 200;
            entry.inStock = inStock;
            entry.soldOutCount = list.length - inStock;
            entry.status = 'ok';
        } else if (resp && resp.code === 555) {
            entry.code = 555; entry.status = 'busy'; entry.msg = '繁忙';
        } else if (resp && resp.code === 1001) {
            entry.code = 1001; entry.status = 'error'; entry.msg = '未登录';
        } else if (resp) {
            entry.code = resp.code; entry.status = 'error'; entry.msg = resp.msg || '';
        } else {
            entry.code = 'ERR'; entry.status = 'error'; entry.msg = errMsg || '请求失败';
        }
        state.refreshLogs.push(entry);
        if (state.refreshLogs.length > CONFIG.REFRESH_LOG_MAX) {
            state.refreshLogs = state.refreshLogs.slice(-CONFIG.REFRESH_LOG_MAX);
        }
        renderRefreshTable();
    }

    function renderRefreshTable() {
        var tbody = document.getElementById('v2-refresh-tbody');
        if (!tbody) return;
        var html = '';
        // 倒序展示，最新在顶
        for (var i = state.refreshLogs.length - 1; i >= 0; i--) {
            var e = state.refreshLogs[i];
            var resultHtml;
            if (e.status === 'ok') {
                resultHtml = '<span class="v2-tag v2-tag-ok">200 有货' + e.inStock + '/售罄' + e.soldOutCount + '</span>';
            } else if (e.status === 'busy') {
                resultHtml = '<span class="v2-tag v2-tag-err">' + e.code + ' 繁忙</span>';
            } else {
                resultHtml = '<span class="v2-tag v2-tag-err">' + e.code + (e.msg ? ' ' + e.msg : '') + '</span>';
            }
            var sourceTag = e.source === '手动'
                ? '<span class="v2-tag v2-tag-sending">手动</span>'
                : '<span class="v2-tag">轮询</span>';
            html += '<tr><td>' + e.time + '</td><td>' + sourceTag + '</td><td>' + e.code + '</td><td>' + resultHtml + '</td></tr>';
        }
        if (!html) html = '<tr><td colspan="4" class="v2-token-empty">暂无刷新记录</td></tr>';
        tbody.innerHTML = html;
    }

    // 清空库存刷新记录
    function clearRefreshLogs() {
        state.refreshLogs = [];
        renderRefreshTable();
        log('库存', '已清空刷新记录');
    }

    // 切换「抢购记录 / 库存刷新」标签页（同一时刻只显示一个表）
    function setActiveTab(name) {
        var isTokens = name !== 'refresh';
        var tTokens = document.getElementById('v2-tab-tokens');
        var tRefresh = document.getElementById('v2-tab-refresh');
        var pTokens = document.getElementById('v2-panel-tokens');
        var pRefresh = document.getElementById('v2-panel-refresh');
        if (tTokens) tTokens.classList.toggle('v2-tab-active', isTokens);
        if (tRefresh) tRefresh.classList.toggle('v2-tab-active', !isTokens);
        if (pTokens) pTokens.style.display = isTokens ? '' : 'none';
        if (pRefresh) pRefresh.style.display = isTokens ? 'none' : '';
        saveSetting('v2_active_tab', isTokens ? 'tokens' : 'refresh');
    }

    // 手动刷新按钮三态：normal / loading / disabled(锁定窗口)
    function setRefreshButtonState(stage) {
        var btn = document.getElementById('v2-refresh-btn');
        if (!btn) return;
        if (stage === 'loading') {
            btn.disabled = true;
            btn.textContent = '...';
            btn.classList.add('v2-refresh-loading');
        } else if (stage === 'disabled') {
            btn.disabled = true;
            btn.textContent = '锁定' + refreshLockRemainingSec() + 's';
            btn.classList.remove('v2-refresh-loading');
        } else {
            btn.disabled = false;
            btn.textContent = '刷新';
            btn.classList.remove('v2-refresh-loading');
        }
    }

    // 进入库存锁定窗口：强制清售罄、禁用刷新按钮、每秒倒计时，到期后自动恢复并触发首次 batch-preview
    function startRefreshLockout() {
        state.refreshUnlockTime = Date.now() + CONFIG.REFRESH_LOCKOUT_MS;
        state.refreshLogs = [];
        renderRefreshTable();
        forceNonSoldOut();
        setRefreshButtonState('disabled');
        log('锁定', '进入库存锁定窗口 ' + (CONFIG.REFRESH_LOCKOUT_MS / 1000) + 's，期间认定非售罄');
        if (state.refreshUnlockTimer) clearInterval(state.refreshUnlockTimer);
        state.refreshUnlockTimer = setInterval(function () {
            if (isRefreshLocked()) {
                setRefreshButtonState('disabled'); // 更新倒计时文案
                return;
            }
            // 窗口到期
            stopRefreshLockout();
            setRefreshButtonState('normal');
            log('锁定', '锁定窗口结束，恢复 batch-preview 轮询');
            if (state.running) requestBatchPreview({ source: '轮询' });
        }, 1000);
    }

    function stopRefreshLockout() {
        if (state.refreshUnlockTimer) {
            clearInterval(state.refreshUnlockTimer);
            state.refreshUnlockTimer = null;
        }
        state.refreshUnlockTime = 0;
    }

    // ==================== batch-preview 单例请求 ====================
    var batchPreviewInFlight = null;

    // opts.source: '轮询'（默认）| '手动'。锁定窗口内直接返回不发请求。
    // 注意：batch-preview 的 soldOut 仅用于展示，永不写 confirmedSoldOut，永不触发抢购终止。
    async function requestBatchPreview(opts) {
        // 锁定窗口内不发请求（轮询/预热/手动统一遵守）
        if (isRefreshLocked()) {
            log('锁定', '锁定窗口内跳过 batch-preview（剩余 ' + refreshLockRemainingSec() + 's）');
            return;
        }
        // 单例：如果已有请求进行中，复用它
        if (batchPreviewInFlight) return batchPreviewInFlight;

        var source = (opts && opts.source) || '轮询';
        var busyRetry = 0;
        var MAX_BUSY_RETRY = 20; // 连续 555 上限，避免无限循环卡死单例与按钮 loading

        batchPreviewInFlight = (async function () {
            while (true) {
                if (isRefreshLocked()) return; // 中途进入锁定窗口也尊重
                try {
                    var resp = await fetchBatchPreview({});
                    if (resp.code === 200 && resp.data && resp.data.productList) {
                        updateProductsFromBatchPreview(resp.data.productList);
                        state.lastRefreshResult = { code: 200, time: Date.now(), raw: resp };
                        recordRefresh(source, resp);
                        updateProductInfo();
                        updateSoldOutTags();
                        updateAltHelpSoldOutTags();
                        return;
                    } else if (resp.code === 555) {
                        busyRetry++;
                        recordRefresh(source, resp);
                        if (busyRetry >= MAX_BUSY_RETRY) {
                            log('库存', 'batch-preview 连续繁忙 ' + MAX_BUSY_RETRY + ' 次，停止重试');
                            return;
                        }
                        log('库存', 'batch-preview 繁忙(555)，' + (CONFIG.REFRESH_BUSY_RETRY_MS / 1000) + 's后重试... (' + busyRetry + '/' + MAX_BUSY_RETRY + ')');
                        await sleep(CONFIG.REFRESH_BUSY_RETRY_MS);
                        continue;
                    } else if (resp.code === 1001) {
                        recordRefresh(source, resp);
                        log('库存', '⚠️ 身份验证失败(1001)，请确认已登录bigmodel.cn');
                        var infoEl = document.getElementById('v2-product-info');
                        if (infoEl) {
                            infoEl.textContent = '未登录';
                            infoEl.style.color = '#f56c6c';
                        }
                        stopBatchPreviewPoll();
                        return;
                    } else {
                        recordRefresh(source, resp);
                        log('库存', 'batch-preview 异常: ' + (resp.msg || resp.code));
                        return;
                    }
                } catch (e) {
                    recordRefresh(source, null, e.message);
                    log('库存', 'batch-preview 请求失败: ' + e.message);
                    await sleep(CONFIG.REFRESH_BUSY_RETRY_MS);
                }
            }
        })();

        try {
            await batchPreviewInFlight;
        } finally {
            batchPreviewInFlight = null;
        }
    }

    // ==================== batch-preview 定期轮询 ====================
    var batchPreviewPollTimer = null;
    var batchPreviewPollStartDelay = null;

    function startBatchPreviewPoll() {
        if (batchPreviewPollTimer) return;
        // 抢购开始后延迟30秒再开启轮询
        batchPreviewPollStartDelay = setTimeout(function() {
            log('库存', '开始定期轮询 (每30s)');
            batchPreviewPollTimer = setInterval(function() {
                requestBatchPreview();
            }, CONFIG.ALT_POLL_INTERVAL);
            requestBatchPreview();
        }, CONFIG.ALT_POLL_INTERVAL);
    }

    function stopBatchPreviewPoll() {
        if (batchPreviewPollStartDelay) {
            clearTimeout(batchPreviewPollStartDelay);
            batchPreviewPollStartDelay = null;
        }
        if (batchPreviewPollTimer) {
            clearInterval(batchPreviewPollTimer);
            batchPreviewPollTimer = null;
            log('库存', '停止定期轮询');
        }
    }

    var TOKEN_MAX_AGE = 180000;

    // ==================== 持久化存储（GM 优先，fallback localStorage） ====================
    function saveSetting(key, value) {
        console.log('[v2-storage] save', key, '=', value, '| GM_setValue?', typeof GM_setValue !== 'undefined');
        try { if (typeof GM_setValue !== 'undefined') GM_setValue(key, value); } catch (e) { console.warn('[v2-storage] GM_setValue fail', key, e); }
        try { localStorage.setItem(key, String(value)); } catch (e) { console.warn('[v2-storage] localStorage.setItem fail', key, e); }
    }
    function loadSetting(key, defaultVal) {
        var val = null;
        var gmVal = null;
        var lsVal = null;
        try { if (typeof GM_getValue !== 'undefined') gmVal = GM_getValue(key); } catch (e) {}
        try { lsVal = localStorage.getItem(key); } catch (e) {}
        val = (gmVal !== null && gmVal !== undefined) ? gmVal : lsVal;
        var result = (val !== null && val !== undefined) ? val : defaultVal;
        console.log('[v2-storage] load', key, '| GM=', gmVal, '| LS=', lsVal, '| default=', defaultVal, '→ result=', result);
        return result;
    }

    function getAntiDetect() {
        try { return GM_getValue('v2_anti_detect') === 'true' || GM_getValue('v2_anti_detect') === true; } catch (e) {}
        try { return localStorage.getItem('v2_anti_detect') === 'true'; } catch (e) {}
        return false;
    }

    function isThrottleEnabled() {
        try { return GM_getValue('v2_throttle') === 'true' || GM_getValue('v2_throttle') === true; } catch (e) {}
        try { return localStorage.getItem('v2_throttle') === 'true'; } catch (e) {}
        return false;
    }

    // ── 代理池开关（v3）── GM 存储，主页面与 captcha iframe 共享同一份
    function isProxyEnabled() {
        try { return GM_getValue('v3_proxy_enabled') === 'true' || GM_getValue('v3_proxy_enabled') === true; } catch (e) {}
        try { return localStorage.getItem('v3_proxy_enabled') === 'true'; } catch (e) {}
        return false;
    }
    function saveProxyEnabled(v) {
        saveSetting('v3_proxy_enabled', v ? 'true' : 'false');
    }
    function saveProxySession(sessionId) {
        state.proxySession = sessionId || '';
        try { if (typeof GM_setValue !== 'undefined') GM_setValue('v3_proxy_session', state.proxySession); } catch (e) {}
        try { localStorage.setItem('v3_proxy_session', state.proxySession); } catch (e) {}
    }
    // 出口粘性：每次「验证码+preview」生成新 session，使本组验证码获取与 preview 绑同一代理 IP
    function newProxySession() {
        var sessionId = 's' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        saveProxySession(sessionId);
        return sessionId;
    }
    function useProxySession(sessionId) {
        if (sessionId) saveProxySession(sessionId);
    }
    // 从共享存储同步代理 IP（captcha iframe 写入 → 主页面读取）
    function syncLastProxyIp() {
        var ip = '';
        try { ip = GM_getValue('v3_last_proxy_ip') || ''; } catch (e) {}
        if (!ip) { try { ip = localStorage.getItem('v3_last_proxy_ip') || ''; } catch (e) {} }
        if (ip) state.lastProxyIp = ip;
    }

    // 控流：preview 返回 555/500 时按设定暂停（规避官方限流）。仅在勾选「控流」时生效。
    async function applyThrottle(code, tag) {
        if (!isThrottleEnabled()) return false;
        var ms = 0;
        if (code === 555) ms = CONFIG.THROTTLE_555_MS;
        else if (code === 500) ms = CONFIG.THROTTLE_500_MS;
        if (ms > 0) {
            log('控流', (tag || 'preview') + ' 返回 ' + code + '，暂停 ' + (ms / 1000) + 's 规避限流');
            await sleep(ms);
            return true;
        }
        return false;
    }

    function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    // ==================== 调剂辅助函数 ====================
    var ALT_DEFAULT_ORDER = [
        {key:'month.lite', enabled:true},
        {key:'quarter.lite', enabled:true},
        {key:'month.pro', enabled:true},
        {key:'year.lite', enabled:true},
        {key:'quarter.pro', enabled:true},
        {key:'month.max', enabled:true},
        {key:'year.pro', enabled:true},
        {key:'quarter.max', enabled:true},
        {key:'year.max', enabled:true}
    ];

    function parseAltKey(key) {
        var parts = key.split('.');
        return { period: parts[0], tier: parts[1] };
    }

    function findProductKey(product) {
        for (var period in PRODUCTS) {
            for (var tier in PRODUCTS[period]) {
                if (PRODUCTS[period][tier].productId === product.productId) {
                    return period + '.' + tier;
                }
            }
        }
        return null;
    }

    function getAlternativeOrder() {
        var saved = loadSetting('v2_alternative_order', null);
        if (saved) {
            try {
                var parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length === 9) return parsed;
            } catch (e) {}
        }
        return ALT_DEFAULT_ORDER.map(function(item) {
            return { key: item.key, enabled: item.enabled };
        });
    }

    function saveAlternativeOrder(order) {
        saveSetting('v2_alternative_order', JSON.stringify(order));
    }

    function acceptAlternativeEnabled() {
        var el = document.getElementById('v2-accept-alternative');
        return el ? el.checked : false;
    }

    function findNextAvailableProduct(currentProduct) {
        if (!currentProduct.confirmedSoldOut) return currentProduct;
        var order = getAlternativeOrder();
        for (var i = 0; i < order.length; i++) {
            if (!order[i].enabled) continue;
            var parts = parseAltKey(order[i].key);
            var product = PRODUCTS[parts.period] && PRODUCTS[parts.period][parts.tier];
            if (product && !product.confirmedSoldOut) return product;
        }
        return null;
    }

    function switchToNextAlternative(currentProduct) {
        var order = getAlternativeOrder();
        var currentKey = findProductKey(currentProduct);
        var foundCurrent = false;
        for (var i = 0; i < order.length; i++) {
            if (order[i].key === currentKey) {
                foundCurrent = true;
                continue;
            }
            if (!foundCurrent) continue;
            if (!order[i].enabled) continue;
            var parts = parseAltKey(order[i].key);
            var product = PRODUCTS[parts.period] && PRODUCTS[parts.period][parts.tier];
            if (product && !product.confirmedSoldOut) return product;
        }
        return null;
    }

    // 调剂模式：返回优先级最高的一个 enabled 套餐（抢购起点）
    function firstEnabledAlternative() {
        var order = getAlternativeOrder();
        for (var i = 0; i < order.length; i++) {
            if (!order[i].enabled) continue;
            var parts = parseAltKey(order[i].key);
            var product = PRODUCTS[parts.period] && PRODUCTS[parts.period][parts.tier];
            if (product) return product;
        }
        return null;
    }

    // 调剂模式：返回所有 enabled 套餐（优先级顺序），用于轮换抢购
    function getEnabledAlternativeProducts() {
        var order = getAlternativeOrder();
        var list = [];
        for (var i = 0; i < order.length; i++) {
            if (!order[i].enabled) continue;
            var parts = parseAltKey(order[i].key);
            var product = PRODUCTS[parts.period] && PRODUCTS[parts.period][parts.tier];
            if (product) list.push(product);
        }
        return list;
    }

    // 调剂模式轮换抢购：
    //  - 默认所有已接受套餐都有货（start 时 forceNonSoldOut 已清）
    //  - 按优先级逐一 preview；preview 失败（非售罄）立即换下一个，不重复 preview 同一个
    //  - preview 售罄 → 标记 confirmedSoldOut，永久移出轮换
    //  - 全部售罄 → 锁定窗口内等待 batch-preview 复活；窗口外结束
    //  - batch-preview（30s 后）真实结果会同步售罄状态（复活/标记）
    async function alternativeRoundRobin(startProduct) {
        var rotation = getEnabledAlternativeProducts();
        if (rotation.length === 0) {
            log('错误', '调剂模式未勾选任何套餐');
            terminateScript('未配置调剂套餐');
            return false;
        }
        var idx = 0;
        for (var k = 0; k < rotation.length; k++) {
            if (rotation[k] === startProduct) { idx = k; break; }
        }

        while (state.running) {
            // 全部售罄：锁定窗口内等待 batch-preview 复活；窗口外才结束
            if (rotation.every(function (p) { return p.confirmedSoldOut; })) {
                if (isRefreshLocked()) {
                    log('锁定', '全部套餐已售罄，锁定窗口内等待 batch-preview 复活...');
                    await sleep(2000);
                    continue;
                }
                addSoldOutTokenRow('所有套餐已售罄');
                terminateScript('所有套餐已经售罄');
                return false;
            }

            // 跳过售罄的，定位下一个可用套餐（轮换）
            var skipped = 0;
            while (rotation[idx].confirmedSoldOut && skipped < rotation.length) {
                idx = (idx + 1) % rotation.length;
                skipped++;
            }
            var product = rotation[idx];
            // 预先推进：本轮无论成败，下一轮都从下一个套餐开始（不重复 preview 同一个）
            idx = (idx + 1) % rotation.length;

            clickPagePackageTab(product);
            log('调剂', '尝试: ' + product.name);

            // 优先消耗预存 token（LIFO），否则解验证码
            var successData = null, successTokenObj = null, wasSoldOut = false;
            var cached = getValidCachedTokens();
            if (cached.length > 0) {
                var token = cached[cached.length - 1];
                token.previewSent = true;
                if (!token.source) token.source = '预存';
                token.productName = product.name;
                token.previewSentTime = Date.now();
                updateTokenDisplay();
                var pd = await tryPreviewWithRetryAndRecord(
                    { ticket: token.ticket, randstr: token.randstr }, product, token);
                if (pd) { successData = pd; successTokenObj = token; }
                else if (token.previewResult && token.previewResult.soldOut) { wasSoldOut = true; }
            } else {
                if (!getTencentCaptcha()) {
                    log('抢购', '验证码SDK未就绪，2s后重试');
                    await sleep(2000);
                    continue;
                }
                var pr = await solveAndFirePipeline(product, 1);
                if (pr) { successData = pr.data; successTokenObj = pr.tokenObj; }
                else if (state.lastPipelineSoldOut) { wasSoldOut = true; }
            }

            if (!state.running) {
                log('抢购', '已手动停止');
                return false;
            }

            if (successData) {
                log('抢购', '抢到了！' + product.name + ' ¥' + successData.thirdPartyAmount);
                var lockResult = await tryLockOrder(successData);
                if (successTokenObj) {
                    successTokenObj.lockResult = { success: lockResult.success, raw: lockResult.raw };
                    updateTokenDisplay();
                }
                if (lockResult.success) {
                    showPaymentQRPopup(lockResult.sign, successData);
                    return true;
                }
                log('抢购', '锁单失败，触发页面原生支付弹窗');
                await openPaymentDialog(successData, product);
                return true;
            }

            if (wasSoldOut) {
                // preview 确认售罄 → 标记，永久移出轮换
                product.confirmedSoldOut = true;
                log('调剂', product.name + ' 已售罄，移出轮换');
                renderAltSummary();
                continue; // idx 已推进，立即试下一个
            }

            // 非售罄失败 → idx 已推进，短暂等待后试下一个
            await sleep(300);
        }
        return false;
    }

    // 由 product 对象反查其所属 period（月/季/年），用于点击页面 tab
    function findProductUnit(product) {
        var units = Object.keys(PRODUCTS);
        for (var i = 0; i < units.length; i++) {
            var tiers = Object.keys(PRODUCTS[units[i]]);
            for (var j = 0; j < tiers.length; j++) {
                if (PRODUCTS[units[i]][tiers[j]] === product) return units[i];
            }
        }
        return null;
    }

    // 调剂模式概览：列出所有 enabled 套餐 + 售罄状况
    function renderAltSummary() {
        var box = document.getElementById('v2-alt-summary');
        if (!box) return;
        var order = getAlternativeOrder();
        var html = '';
        var enabledCount = 0;
        var inStockCount = 0;
        for (var i = 0; i < order.length; i++) {
            if (!order[i].enabled) continue;
            enabledCount++;
            var parts = parseAltKey(order[i].key);
            var product = PRODUCTS[parts.period] && PRODUCTS[parts.period][parts.tier];
            if (!product) continue;
            var price = product.payAmount ? '¥' + product.payAmount : '¥' + product.price;
            var badge;
            if (product.confirmedSoldOut) {
                badge = '<span class="v2-tag v2-tag-err">售罄</span>';
            } else if (product.soldOut) {
                badge = '<span class="v2-tag v2-tag-warn">售罄*</span>';
            } else {
                badge = '<span class="v2-tag v2-tag-ok">有货</span>';
                inStockCount++;
            }
            html += '<div class="v2-alt-sum-row">' +
                '<span class="v2-alt-sum-idx">' + (i + 1) + '</span>' +
                '<span class="v2-alt-sum-name">' + product.name + '</span>' +
                '<span class="v2-alt-sum-price">' + price + '</span>' +
                badge + '</div>';
        }
        var header = '<div class="v2-alt-sum-header">已选 ' + enabledCount + ' 个 · 有货 ' + inStockCount +
            ' <span style="color:#666;font-size:10px;">(点「?」配置)</span></div>';
        if (!html) html = '<div class="v2-token-empty" style="padding:6px;">未勾选任何套餐</div>';
        box.innerHTML = header + html;
    }

    // 根据调剂模式开关，切换「单选套餐区 / 多套餐概览」显隐
    function applyAltModeVisibility() {
        var altMode = acceptAlternativeEnabled();
        var single = document.getElementById('v2-single-pkg');
        var summary = document.getElementById('v2-alt-summary');
        if (single) single.style.display = altMode ? 'none' : '';
        if (summary) summary.style.display = altMode ? '' : 'none';
        if (altMode) renderAltSummary();
    }

    // ==================== 工具函数 ====================
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function log(tag, msg) {
        var time = new Date().toLocaleTimeString();
        console.log('[' + time + '][' + tag + '] ' + msg);
        updateLog(tag + ': ' + msg);
    }

    function getQueryString(name) {
        var reg = new RegExp('(^|&)' + name + '=([^&]*)(&|$)', 'i');
        var r = window.location.search.substr(1).match(reg);
        return r ? decodeURI(r[2]) : null;
    }

    // ==================== Auth ====================
    // Token 存在 cookie: bigmodel_token_production
    // OrgId / ProjectId 存在 localStorage
    var AUTH_COOKIE_KEY = 'bigmodel_token_production';
    var ORG_LS_KEY = 'Bigmodel-Organization';
    var PROJECT_LS_KEY = 'Bigmodel-Project';

    function getCookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    function getAuthHeaders() {
        var token = getCookie(AUTH_COOKIE_KEY);
        var orgId = localStorage.getItem(ORG_LS_KEY) || '';
        var projectId = localStorage.getItem(PROJECT_LS_KEY) || '';
        var headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers['Authorization'] = token;
            headers['Bigmodel-Organization'] = orgId;
            headers['Bigmodel-Project'] = projectId;
        }
        return headers;
    }

    // ── 账号密码与自动重登（token 失效时）──
    // 仿 Element $message 的顶部轻提示（页面未注入 $message 时自实现，登录成功/失败反馈用）
    function showMessage(text, type) {
        var t = type || 'info';
        var palette = {
            success: { tx: '#67c23a', bg: '#f0f9eb' },
            error:   { tx: '#f56c6c', bg: '#fef0f0' },
            warning: { tx: '#e6a23c', bg: '#fdf6ec' },
            info:    { tx: '#909399', bg: '#f4f4f5' }
        };
        var p = palette[t] || palette.info;
        var el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
            'max-width:80vw;background:' + p.bg + ';color:' + p.tx + ';' +
            'padding:10px 18px;border:1px solid ' + p.tx + '40;border-radius:6px;' +
            'box-shadow:0 2px 12px rgba(0,0,0,0.12);font:13px/1.5 system-ui,sans-serif;' +
            'z-index:2000000040;opacity:0;transition:opacity .25s, top .25s;white-space:nowrap;';
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.style.opacity = '1'; el.style.top = '24px'; });
        setTimeout(function () {
            el.style.opacity = '0';
            setTimeout(function () { if (el.parentNode) el.remove(); }, 250);
        }, 3000);
    }
    function setCookie(name, value, days) {
        var d = days || 7;
        var expires = new Date(Date.now() + d * 24 * 3600 * 1000).toUTCString();
        // domain=.bigmodel.cn 让子域共享；写完 getCookie 立即读到新 token
        document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;domain=.bigmodel.cn;expires=' + expires;
    }
    function getLoginUsername() { return loadSetting('v3_login_username', '') || ''; }
    function getLoginPassword() { return loadSetting('v3_login_password', '') || ''; }
    function hasLoginCredentials() { return !!(getLoginUsername() && getLoginPassword()); }

    function genAnonymousId() {
        function hex(n) { var s = ''; for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16); return s; }
        return hex(12) + '-' + hex(13) + '-' + hex(8) + '-' + hex(6) + '-' + hex(12);
    }

    // token 失效（preview 返回 405/401）时自动重登，刷新 cookie 中的 token，由 apiRequest 重试
    function relogin() {
        var username = getLoginUsername();
        var password = getLoginPassword();
        var body = JSON.stringify({
            phoneNumber: '', countryCode: '', username: username, smsCode: '',
            password: password, loginType: 'password', grantType: 'customer',
            userType: 'PERSONAL', userCode: '', appId: '',
            anonymousId: getCookie('anonymousId') || genAnonymousId()
        });
        log('登录', 'POST /api/auth/login (username=' + username + ')');
        return new Promise(function (resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/auth/login');
            xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
            xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
            xhr.timeout = 8000;
            xhr.onload = function () {
                log('登录', '← ' + xhr.status + ' ' + xhr.responseText.substring(0, 120));
                try {
                    var resp = JSON.parse(xhr.responseText);
                    var token = resp.data && resp.data.access_token;
                    if (resp.code === 200 && token) {
                        setCookie(AUTH_COOKIE_KEY, token);
                        log('登录', '✓ token 已刷新');
                        showMessage('登录成功，token 已刷新', 'success');
                        resolve(true);
                    } else {
                        var failMsg = resp.msg || ('code=' + resp.code);
                        log('登录', '✗ 登录失败: ' + failMsg);
                        showMessage('登录失败: ' + failMsg, 'error');
                        resolve(false);
                    }
                } catch (e) {
                    log('登录', '✗ 登录响应解析失败');
                    resolve(false);
                }
            };
            xhr.onerror = function () { log('登录', '✗ 网络错误'); resolve(false); };
            xhr.ontimeout = function () { log('登录', '✗ 超时'); resolve(false); };
            xhr.send(body);
        });
    }

    // 弹窗配置账号密码（勾选「自动重登」时触发）。onConfirm(u,p) 仅在用户填妥并确认时回调。
    function openAccountDialog(onConfirm) {
        var existing = document.getElementById('v3-account-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'v3-account-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:2000000029;display:flex;align-items:center;justify-content:center;';

        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px 28px;width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.2);font:13px/1.6 system-ui,sans-serif;';
        box.innerHTML =
            '<div style="font-size:15px;font-weight:600;margin-bottom:4px;color:#303133;">配置账号密码</div>' +
            '<div style="font-size:12px;color:#909399;margin-bottom:16px;">token 失效（preview 返回 405）时自动重新登录刷新，仅本地保存。</div>' +
            '<label style="display:block;margin-bottom:10px;">' +
            '<span style="display:block;color:#606266;margin-bottom:4px;">账号</span>' +
            '<input type="text" id="v3-dlg-username" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #dcdfe6;border-radius:6px;font-size:13px;" />' +
            '</label>' +
            '<label style="display:block;margin-bottom:18px;">' +
            '<span style="display:block;color:#606266;margin-bottom:4px;">密码</span>' +
            '<input type="password" id="v3-dlg-password" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #dcdfe6;border-radius:6px;font-size:13px;" />' +
            '</label>' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
            '<button id="v3-dlg-cancel" style="padding:7px 16px;border:1px solid #dcdfe6;border-radius:6px;background:#fff;color:#606266;cursor:pointer;">取消</button>' +
            '<button id="v3-dlg-ok" style="padding:7px 16px;border:none;border-radius:6px;background:#409eff;color:#fff;cursor:pointer;">确认</button>' +
            '</div>';

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var userInp = box.querySelector('#v3-dlg-username');
        var passInp = box.querySelector('#v3-dlg-password');
        userInp.value = getLoginUsername();   // 预填已存账号，方便修改

        var close = function () { overlay.remove(); };
        var confirm = function () {
            var u = (userInp.value || '').trim();
            var p = passInp.value || '';
            userInp.style.borderColor = u ? '#dcdfe6' : '#f56c6c';
            passInp.style.borderColor = p ? '#dcdfe6' : '#f56c6c';
            if (!u || !p) return;   // 两者皆必填，否则不关闭
            saveSetting('v3_login_username', u);
            saveSetting('v3_login_password', p);
            close();
            if (typeof onConfirm === 'function') onConfirm(u, p);
        };

        box.querySelector('#v3-dlg-ok').addEventListener('click', confirm);
        box.querySelector('#v3-dlg-cancel').addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });   // 点遮罩空白取消
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
            else if (e.key === 'Enter') { e.preventDefault(); confirm(); document.removeEventListener('keydown', esc); }
        });

        setTimeout(function () { userInp.focus(); }, 0);
    }

    // 根据是否已配置账密，显示/隐藏「手动重登」按钮
    function updateManualReloginBtn() {
        var btn = document.getElementById('v3-manual-relogin');
        if (btn) btn.style.display = hasLoginCredentials() ? '' : 'none';
    }

    // ==================== 代理池（v3）====================
    // 通过本地 /proxy 接口转发一次请求，返回 {success, status, headers, body(b64), proxy}
    function proxyViaLocal(method, url, headers, body, opts) {
        opts = opts || {};
        var bodyPrev = body ? String(body).substring(0, 200) : '(无)';
        var sessionId = opts.session || state.proxySession || '';
        log('代理→', method + ' ' + (url || '').substring(0, 70) + ' | body: ' + bodyPrev);
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.PROXY_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    method: method, url: url,
                    headers: headers || {}, body: body || null,
                    session: sessionId || undefined,
                    rotate_after: !!opts.rotateAfter
                }),
                timeout: CONFIG.PROXY_TIMEOUT,
                onload: function (r) {
                    try {
                        var parsed = JSON.parse(r.responseText);
                        if (parsed.proxy) { state.lastProxyIp = parsed.proxy; updateProxyStatusUI(); }
                        var respPrev = parsed.body ? atob(parsed.body).substring(0, 150) : '(空)';
                        var viaInfo = parsed.proxy ? (' via ' + parsed.proxy) : '';
                        log('代理←', (parsed.status || '?') + viaInfo + ' | ' + respPrev);
                        if (parsed.success) resolve(parsed);
                        else reject(new Error((parsed.error || ('代理失败 status=' + parsed.status)) + viaInfo));
                    } catch (e) { reject(new Error('代理响应解析失败')); }
                },
                onerror: function () {
                    log('代理←', '✗ 服务不可达');
                    // 通知 Python 丢弃当前 session 的代理（fire-and-forget）
                    discardProxySession(sessionId);
                    reject(new Error('代理服务不可达（OCR 服务未运行？）'));
                },
                ontimeout: function () {
                    log('代理←', '✗ 超时（>' + (CONFIG.PROXY_TIMEOUT / 1000) + 's）');
                    // JS 层超时：Python 可能还在等转发结果，通知丢弃当前代理
                    discardProxySession(sessionId);
                    reject(new Error('代理超时（>' + (CONFIG.PROXY_TIMEOUT / 1000) + 's），已请求换 IP'));
                }
            });
        });
    }

    // 通知 Python 端丢弃当前 session 绑定的代理（fire-and-forget，不阻塞重试）
    function discardProxySession(sessionId) {
        if (!sessionId || !state.proxyReady) return;
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.PROXY_URL + '/discard',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ session: sessionId }),
                timeout: 3000
            });
        } catch (e) {}
    }

    // 将 /proxy 的响应还原成原生 XHR 实例的状态（供被拦截的 SDK 请求使用）
    function deliverProxiedXHR(xhr, parsed) {
        var bodyText = parsed.body ? atob(parsed.body) : '';
        try {
            Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(xhr, 'status', { value: parsed.status || 200, configurable: true });
            Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true });
            Object.defineProperty(xhr, 'responseText', { value: bodyText, configurable: true });
            Object.defineProperty(xhr, 'response', { value: bodyText, configurable: true });
        } catch (e) {
            xhr.readyState = 4; xhr.status = parsed.status || 200;
            xhr.responseText = bodyText; xhr.response = bodyText;
        }
        try { if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(); } catch (e) {}
        try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) {}
        try { xhr.dispatchEvent(new Event('load')); xhr.dispatchEvent(new Event('loadend')); } catch (e) {
            try { if (typeof xhr.onload === 'function') xhr.onload(); } catch (e2) {}
        }
    }

    // A 层：拦截腾讯验证码 SDK 内部发往 qcloud/gtimg 的 XHR/fetch，改道本地 /proxy。
    // ⚠️ 若 SDK 使用 JSONP(<script src>)或 <img> 加载而非 XHR/fetch，本拦截器无法覆盖，
    //    需实测后视情况补充 script/img 拦截。
    function setupProxyInterceptor() {
        if (!isProxyEnabled() || !state.proxyReady) return;
        if (win.__v3ProxyPatched) return;
        win.__v3ProxyPatched = true;

        var RealXHR = win.XMLHttpRequest;
        var origOpen = RealXHR.prototype.open;
        var origSend = RealXHR.prototype.send;
        var origSetHeader = RealXHR.prototype.setRequestHeader;

        RealXHR.prototype.open = function (method, url) {
            this.__v3Method = method;
            this.__v3Url = url;
            this.__v3Headers = {};
            this.__v3Proxied = CONFIG.PROXY_HOST_RE.test(String(url || ''));
            return origOpen.apply(this, arguments);
        };
        RealXHR.prototype.setRequestHeader = function (k, v) {
            if (this.__v3Headers) this.__v3Headers[k] = v;
            return origSetHeader.apply(this, arguments);
        };
        RealXHR.prototype.send = function (body) {
            if (!this.__v3Proxied) return origSend.apply(this, arguments);
            var self = this;
            proxyViaLocal(self.__v3Method, self.__v3Url, self.__v3Headers, body)
                .then(function (parsed) { deliverProxiedXHR(self, parsed); })
                .catch(function (e) { deliverProxiedXHR(self, { status: 502, body: btoa(e.message || 'err'), headers: {} }); });
        };

        var origFetch = win.fetch;
        if (origFetch) {
            win.fetch = function (input, init) {
                var url = typeof input === 'string' ? input : ((input && input.url) || '');
                if (!CONFIG.PROXY_HOST_RE.test(url)) return origFetch.apply(this, arguments);
                var method = (init && init.method) || 'GET';
                var headers = {};
                if (init && init.headers) {
                    if (typeof init.headers.forEach === 'function') init.headers.forEach(function (v, k) { headers[k] = v; });
                    else headers = Object.assign({}, init.headers);
                }
                var body = init && init.body;
                if (body && typeof body !== 'string') {
                    try { body = String(body); } catch (e) { return origFetch.apply(this, arguments); }
                }
                return proxyViaLocal(method, url, headers, body).then(function (parsed) {
                    var text = parsed.body ? atob(parsed.body) : '';
                    return new Response(text, { status: parsed.status || 200, headers: new Headers(parsed.headers || {}) });
                });
            };
        }
        log('代理', 'XHR/fetch 拦截器已启用（目标：qcloud/gtimg）');
    }

    // ==================== API 调用 ====================
    function apiRequest(method, url, data, _retried) {
        var path = '/api' + url;
        var headers = getAuthHeaders();
        var body = data ? JSON.stringify(data) : null;
        var viaProxy = state.proxyReady && CONFIG.PROXY_API_SUFFIXES.some(function (s) { return path.indexOf(s) >= 0; });
        // 走代理时由 proxyViaLocal 统一记录请求/响应；直连时这里记（浏览器 Network 也能看到，日志便于排查）
        if (!viaProxy) log('API→', method + ' ' + url + (body ? ' | ' + body.substring(0, 200) : ''));

        // 发请求，统一拿到 {status, text}
        var rawPromise;
        if (viaProxy) {
            rawPromise = proxyViaLocal(method, location.origin + path, headers, body, {
                rotateAfter: path.indexOf('/biz/pay/preview') >= 0
            }).then(function (parsed) {
                if (parsed.proxy) { state.lastProxyIp = parsed.proxy; updateProxyStatusUI(); }
                return { status: parsed.status || 0, text: parsed.body ? atob(parsed.body) : '{}' };
            });
        } else {
            rawPromise = new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open(method, path);
                xhr.timeout = 3000;   // v3 补：业务请求超时，避免代理/网络 hang 死循环
                for (var key in headers) {
                    xhr.setRequestHeader(key, headers[key]);
                }
                xhr.onload = function () {
                    log('API←', xhr.status + ' ' + xhr.responseText.substring(0, 150));
                    resolve({ status: xhr.status, text: xhr.responseText });
                };
                xhr.onerror = function () { log('API←', '✗ 网络错误'); reject(new Error('网络错误')); };
                xhr.ontimeout = function () { log('API←', '✗ 超时'); reject(new Error('请求超时')); };
                if (body) {
                    xhr.send(body);
                } else {
                    xhr.send();
                }
            });
        }

        return rawPromise.then(function (r) {
            // token 失效（405/401）且配置了账密 → 自动重登刷新 token 并重试一次（_retried 防循环）
            if ((r.status === 405 || r.status === 401) && !_retried && state.autoReloginEnabled && hasLoginCredentials()) {
                log('登录', url + ' 返回 ' + r.status + '，尝试重新登录刷新 token');
                return relogin().then(function (ok) {
                    if (!ok) throw new Error('重新登录失败');
                    log('登录', 'token 已刷新，重试 ' + url);
                    return apiRequest(method, url, data, true);
                });
            }
            try {
                return JSON.parse(r.text);
            } catch (e) {
                throw new Error('非JSON响应: HTTP ' + r.status);
            }
        });
    }

    // 获取用户信息
    function fetchCustomerInfo() {
        return apiRequest('GET', '/biz/customer/getCustomerInfo');
    }

    // 批量预览（获取各产品最新价格和售卖状态）
    function fetchBatchPreview(params) {
        return apiRequest('POST', '/biz/pay/batch-preview', params);
    }

    // 单个产品预览（验证码通过后调用，获取 bizId）
    function fetchPreview(params) {
        return apiRequest('POST', '/biz/pay/preview', params);
    }

    // 查询支付状态
    function fetchPayStatus(bizId) {
        return apiRequest('GET', '/biz/pay/status?key=' + encodeURIComponent(bizId));
    }

    // 锁单（create-sign）
    function tryLockOrder(previewData) {
        return new Promise(function (resolve) {
            if (state.lockOrderInProgress || state.lockOrderDone) {
                resolve({ success: false, code: 'SKIP', msg: state.lockOrderDone ? '已锁单' : '锁单进行中' });
                return;
            }
            state.lockOrderInProgress = true;

            var customerId = state.customerNumber;
            if (!customerId) {
                log('锁单', '无法获取 customerId');
                state.lockOrderInProgress = false;
                resolve({ success: false, code: 'NO_CUSTOMER', msg: '无法获取 customerId' });
                return;
            }

            var signUrl = previewData.lastSubscriptionSummary ? '/biz/pay/product/update/sign' : '/biz/pay/create-sign';

            apiRequest('POST', signUrl, {
                payType: 'ALI',
                productId: previewData.productId,
                customerId: customerId,
                bizId: previewData.bizId
            }).then(function (resp) {
                state.lockOrderInProgress = false;
                if (resp.code === 200 && resp.data && resp.data.sign) {
                    state.lockOrderDone = true;
                    log('锁单', '成功！bizId=' + previewData.bizId);
                    resolve({ success: true, sign: resp.data.sign, raw: resp });
                } else {
                    log('锁单', '失败: ' + (resp.msg || resp.code));
                    resolve({ success: false, code: resp.code, msg: resp.msg, raw: resp });
                }
            }).catch(function (e) {
                state.lockOrderInProgress = false;
                log('锁单', '异常: ' + e.message);
                resolve({ success: false, code: 'ERR', msg: e.message, raw: null });
            });
        });
    }

    // 展示锁单后的支付二维码
    function showPaymentQRPopup(signUrl, priceData) {
        var amount = priceData.thirdPartyAmount || priceData.payAmount;
        var productName = priceData.productName || '';

        // @require 加载的 QRCode 在油猴沙箱全局，不在 unsafeWindow 上
        var QR = (typeof QRCode !== 'undefined') ? QRCode
            : (typeof win.QRCode !== 'undefined') ? win.QRCode : null;

        if (!QR) {
            log('支付', 'QRCode 库未就绪');
            return;
        }

        QR.toDataURL(signUrl, {
            width: 600, margin: 4, errorCorrectionLevel: 'L'
        }, function (err, qrDataUrl) {
            if (err) {
                log('支付', 'QR生成失败: ' + err.message);
                return;
            }
            showQRPopup(qrDataUrl, amount, productName, '锁单成功！请用支付宝扫码支付', signUrl, true);
            // 自动下载二维码
            var a = document.createElement('a');
            a.href = qrDataUrl;
            a.download = 'pay_qr_' + Date.now() + '.png';
            a.click();
            // window.open 打开包含二维码的页面，多 tab 时方便识别哪个成功
            try {
                var w = window.open('', '_blank');
                if (w) {
                    w.document.write('<html><head><title>抢购成功 - 请扫码支付</title></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:system-ui,sans-serif;background:#f5f5f5;">' +
                        '<h2 style="color:#333;">抢购成功！请扫码支付</h2>' +
                        '<p style="color:#666;">' + (productName || '') + '　<strong style="color:#e6a23c;font-size:24px;">¥' + amount + '</strong></p>' +
                        '<img src="' + qrDataUrl + '" style="width:350px;height:350px;border:2px solid #eee;border-radius:8px;" />' +
                        '<p style="color:#999;font-size:13px;margin-top:12px;">请尽快用支付宝扫码支付</p>' +
                        '</body></html>');
                    w.document.close();
                }
            } catch (e) {}
            log('支付', '支付二维码已弹出');
        });
    }
    win.showPaymentQRPopup = showPaymentQRPopup;


    // ==================== 验证码识别 ====================
    function fetchImageBase64(url) {
        // v3：验证码图片走代理（B 层），/proxy 返回的 body 已是 base64
        if (isProxyEnabled() && state.proxyReady && CONFIG.PROXY_HOST_RE.test(url)) {
            return proxyViaLocal('GET', url, {}, null).then(function (parsed) {
                if (!parsed.body) throw new Error('代理返回空');
                return parsed.body;
            });
        }
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    onload: function (res) {
                        var reader = new FileReader();
                        reader.onloadend = function () {
                            resolve(String(reader.result).split(',')[1]);
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(res.response);
                    },
                    onerror: reject
                });
            } else {
                fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
                    var reader = new FileReader();
                    reader.onloadend = function () { resolve(String(reader.result).split(',')[1]); };
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                }).catch(reject);
            }
        });
    }

    function getImageSize(base64) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
            img.onerror = reject;
            img.src = 'data:image/png;base64,' + base64;
        });
    }

    function ddddocrRecognize(base64, chars) {
        return new Promise(function (resolve, reject) {
            var payload = JSON.stringify({ image: base64, remark: chars });
            var handleRes = function (text) {
                try {
                    var obj = JSON.parse(text);
                    if (obj.success && obj.data && obj.data.result) {
                        var points = obj.data.result.split('|').map(function (p) {
                            var xy = p.split(',');
                            return { x: parseFloat(xy[0]), y: parseFloat(xy[1]) };
                        });
                        resolve({ id: obj.data.id || '', points: points });
                    } else {
                        reject(new Error('ddddocr fail: ' + text));
                    }
                } catch (e) { reject(e); }
            };
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: CONFIG.DDDDOCR_URL,
                    headers: { 'Content-Type': 'application/json' },
                    data: payload,
                    onload: function (res) { handleRes(res.responseText); },
                    onerror: function () { reject(new Error('ddddocr 服务不可用')); }
                });
            } else {
                fetch(CONFIG.DDDDOCR_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload
                }).then(function (r) { return r.text(); }).then(handleRes).catch(function () {
                    reject(new Error('ddddocr 服务不可用'));
                });
            }
        });
    }

    function recognizeCaptcha(base64, chars) {
        return ddddocrRecognize(base64, chars);
    }

    // ==================== 腾讯验证码交互 ====================
    // 核心：通过 TencentCaptcha SDK 弹出验证码，用户完成后拿到 ticket+randstr
    // 同时尝试自动识别点选验证码

    // 获取 TencentCaptcha 构造函数（兼容油猴沙箱）
    function getTencentCaptcha() {
        return win.TencentCaptcha || window.TencentCaptcha || null;
    }

    function loadCaptchaScript() {
        return new Promise(function (resolve, reject) {
            if (getTencentCaptcha()) {
                resolve();
                return;
            }
            // 页面可能已经在加载，先等一等
            var waitCount = 0;
            var waitTimer = setInterval(function () {
                waitCount++;
                if (getTencentCaptcha()) {
                    clearInterval(waitTimer);
                    resolve();
                    return;
                }
                if (waitCount > 10) {
                    clearInterval(waitTimer);
                    // 手动加载
                    var script = document.createElement('script');
                    script.src = 'https://turing.captcha.qcloud.com/TCaptcha.js';
                    script.onload = function () {
                        // 等 SDK 初始化
                        setTimeout(function () {
                            if (getTencentCaptcha()) resolve();
                            else reject(new Error('TencentCaptcha SDK 加载后未初始化'));
                        }, 500);
                    };
                    script.onerror = function () { reject(new Error('TCaptcha.js 加载失败')); };
                    document.head.appendChild(script);
                }
            }, 500);
        });
    }

    // 弹出腾讯验证码并获取 ticket（自动识别+点击）
    function getCaptchaTicket() {
        return new Promise(function (resolve, reject) {
            var TC = getTencentCaptcha();
            if (!TC) {
                reject(new Error('验证码SDK未加载'));
                return;
            }

            // 每个「验证码+preview」组合独立生成 session；iframe/主页面通过 GM/localStorage 共享。
            var captchaProxySession = isProxyEnabled() ? newProxySession() : '';
            if (captchaProxySession) log('代理', '本组验证码 session=' + captchaProxySession);

            var done = false;
            var captchaInstance = new TC(CONFIG.CAPTCHA_APP_ID, function (res) {
                done = true;
                clearTimeout(safetyTimer);
                if (res.ret === 0) {
                    resolve({ ticket: res.ticket, randstr: res.randstr, proxySession: captchaProxySession });
                } else if (res.ret === 2) {
                    reject(new Error('用户取消验证'));
                } else {
                    reject(new Error('验证失败: ret=' + res.ret));
                }
            }, {
                mode: 'bind',
                type: 'popup',
                enableDarkMode: false,
                timeout: 60000
            });

            captchaInstance.show();

            // 兜底超时：如果 SDK 120 秒内没有回调，主动 reject
            var safetyTimer = setTimeout(function () {
                if (!done) {
                    done = true;
                    reject(new Error('验证码超时(120s)'));
                }
            }, 120000);

            // 延时启动自动识别（等验证码弹窗渲染完成）
            setTimeout(function () {
                if (!done) {
                    autoSolveCaptchaLoop(function () { return done; });
                }
            }, 800);
        });
    }

    // 自动识别验证码循环
    async function autoSolveCaptchaLoop(isDone) {
        for (var attempt = 0; attempt < CONFIG.CAPTCHA_MAX_RETRY; attempt++) {
            if (isDone()) return;

            try {
                log('验证码', '自动识别第 ' + (attempt + 1) + '/' + CONFIG.CAPTCHA_MAX_RETRY + ' 次');
                await autoSolveCaptchaOnce(isDone);

                // 等待结果
                await sleep(300);
                if (isDone()) {
                    log('验证码', '自动识别成功');
                    return;
                }

                // 检查是否有错误提示
                var errorEl = document.querySelector('.tencent-captcha-dy__verify-error-text');
                if (errorEl && isElementTrulyVisible(errorEl)) {
                    log('验证码', '识别错误，刷新重试');
                    var refreshBtn = document.querySelector('.tencent-captcha-dy__footer-icon--refresh img');
                    if (refreshBtn) refreshBtn.click();
                    await sleep(1000);
                    continue;
                }
            } catch (e) {
                log('验证码', '自动识别异常: ' + e.message);
                if (isDone()) return;
                await sleep(500);
            }
        }
        // 所有尝试用尽，不等待手动，直接 destroy 让上层重试
        log('验证码', '自动识别用尽，关闭验证码重新开始');
        try {
            var closeBtn = document.querySelector('.tencent-captcha-dy__close-btn') ||
                document.querySelector('#tcaptcha_transform_dy .close-btn');
            if (closeBtn) closeBtn.click();
        } catch (e) {}
    }

    // 单次自动识别
    async function autoSolveCaptchaOnce(isDone) {
        var bgEl = document.querySelector('.tencent-captcha-dy__verify-bg-img');
        if (!bgEl || !isElementTrulyVisible(bgEl)) {
            throw new Error('验证码未显示');
        }

        var bgImage = bgEl.style.backgroundImage || '';
        if (bgImage.indexOf('url(') === -1) {
            throw new Error('验证码背景图未加载');
        }

        // 提取提示汉字
        var headerEl = document.querySelector('.tencent-captcha-dy__header-text');
        if (!headerEl) throw new Error('未找到提示文字');
        var text = headerEl.textContent || '';
        var allChars = text.match(/[\u4e00-\u9fa5]/g) || [];
        var chars = allChars.filter(function (c) { return '请依次点击'.indexOf(c) < 0; }).join('');
        if (!chars) throw new Error('未提取到汉字');

        // 提取背景图 URL
        var urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
        if (!urlMatch) throw new Error('未提取到背景图URL');
        var bgUrl = urlMatch[1];

        log('验证码', '汉字: ' + chars);

        // 下载+识别
        var t0 = performance.now();
        var base64 = await fetchImageBase64(bgUrl);
        var size = await getImageSize(base64);
        var result = await recognizeCaptcha(base64, chars);
        log('验证码', 'OCR耗时: ' + (performance.now() - t0).toFixed(0) + 'ms');

        if (isDone()) return;

        // 模拟点击
        var antiDetect = getAntiDetect();
        for (var i = 0; i < result.points.length; i++) {
            if (isDone()) return;
            clickOnCaptchaImage(bgEl, result.points[i], size);
            await sleep(antiDetect ? randInt(300, 600) : 120);
        }

        // 点击确认
        await sleep(antiDetect ? randInt(400, 700) : 100);
        var confirmBtn = document.querySelector('.tencent-captcha-dy__verify-confirm-btn');
        if (confirmBtn && !isDone()) {
            confirmBtn.click();
        }
    }

    // 在验证码图片上模拟点击
    function clickOnCaptchaImage(bgEl, point, imgSize) {
        var rect = bgEl.getBoundingClientRect();
        var scaleX = rect.width / imgSize.w;
        var scaleY = rect.height / imgSize.h;
        // 点击偏移与防检测开关无关，始终带随机偏移，模拟真人落点散布（±15px）
        var offsetX = (Math.random() - 0.5) * 30;
        var offsetY = (Math.random() - 0.5) * 30;
        var clientX = rect.left + point.x * scaleX + offsetX;
        var clientY = rect.top + point.y * scaleY + offsetY;

        var baseOpts = {
            bubbles: true, cancelable: true,
            clientX: clientX, clientY: clientY,
            screenX: clientX, screenY: clientY,
            button: 0, buttons: 1
        };
        var pointerOpts = Object.assign({}, baseOpts, {
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
            width: 1, height: 1, pressure: 0.5
        });

        bgEl.dispatchEvent(new MouseEvent('mouseover', baseOpts));
        bgEl.dispatchEvent(new MouseEvent('mousemove', baseOpts));
        if (window.PointerEvent) {
            bgEl.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
        }
        bgEl.dispatchEvent(new MouseEvent('mousedown', baseOpts));
        if (window.PointerEvent) {
            bgEl.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
        }
        bgEl.dispatchEvent(new MouseEvent('mouseup', baseOpts));
        bgEl.dispatchEvent(new MouseEvent('click', baseOpts));
    }

    function isElementTrulyVisible(el) {
        if (!el) return false;
        var node = el;
        while (node && node.nodeType === 1) {
            var style = window.getComputedStyle(node);
            if (style.display === 'none') return false;
            if (style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity) === 0) return false;
            node = node.parentElement;
        }
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.right <= 0 || rect.bottom <= 0) return false;
        if (rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
        return true;
    }

    // ==================== Token 预存管理 ====================
    function addCachedToken(ticket, randstr, proxySession) {
        syncLastProxyIp();
        state.cachedTokens.push({
            ticket: ticket,
            randstr: randstr,
            proxySession: proxySession || state.proxySession || '',
            proxyIp: state.lastProxyIp || '',
            timestamp: Date.now()
        });
        updateTokenDisplay();
    }

    function getValidCachedTokens() {
        var now = Date.now();
        return state.cachedTokens.filter(function (t) {
            return (now - t.timestamp) < TOKEN_MAX_AGE && !t.previewSent;
        });
    }

    function clearCachedTokens() {
        state.cachedTokens = [];
        updateTokenDisplay();
        log('预存', '已清空');
    }

    function updateTokenDisplay() {
        var tbody = document.getElementById('v2-token-tbody');
        if (!tbody) return;

        var tokens = state.cachedTokens;
        var html = '';
        tokens.forEach(function (t, i) {
            var short = t.ticket.substring(0, 8);
            var now = Date.now();
            var expired = t.source !== '实时' && (now - t.timestamp) >= TOKEN_MAX_AGE;
            var cls = expired ? ' v2-token-expired' : '';

            // 请求时间：优先用 previewSentTime，否则用 timestamp
            var timeStr = t.previewSentTime
                ? new Date(t.previewSentTime).toLocaleTimeString()
                : new Date(t.timestamp).toLocaleTimeString();

            var sourceTag = t.source === '实时'
                ? '<span class="v2-tag v2-tag-sending">实时</span>'
                : '';

            var productName = t.productName || '-';

            var previewText = '-';
            if (t.previewResult) {
                if (t.previewResult.success) previewText = '<span class="v2-tag v2-tag-ok">成功</span>';
                else if (t.previewResult.soldOut) previewText = '<span class="v2-tag v2-tag-warn">售罄</span>';
                else previewText = '<span class="v2-tag v2-tag-err">' + (t.previewResult.code || '?') + '</span>';
            } else if (t.previewSent) {
                previewText = '<span class="v2-tag v2-tag-sending">...</span>';
            }

            var lockText = '-';
            if (t.lockResult) {
                if (t.lockResult.success) lockText = '<span class="v2-tag v2-tag-ok">已锁</span>';
                else {
                    var errTag = t.lockResult.raw ? (t.lockResult.raw.code || 'ERR') : '失败';
                    lockText = '<span class="v2-tag v2-tag-err" title="' + (t.lockResult.raw ? (t.lockResult.raw.msg || '') : '') + '">' + errTag + '</span>';
                }
            }

            var proxyIpText = t.proxyIp || '-';

            var hasDetail = t.previewResult || t.lockResult;
            var clickAttr = hasDetail
                ? ' style="cursor:pointer;" onclick="window.__v2ShowDetail(' + i + ')"'
                : '';

            html += '<tr class="' + cls + '"' + clickAttr + '>' +
                '<td>' + (i + 1) + sourceTag + '</td>' +
                '<td title="' + t.ticket + '">' + short + '</td>' +
                '<td>' + productName + '</td>' +
                '<td>' + timeStr + '</td>' +
                '<td style="font-size:11px;font-family:monospace;">' + proxyIpText + '</td>' +
                '<td>' + previewText + '</td>' +
                '<td>' + lockText + '</td>' +
                '</tr>';
        });
        if (tokens.length === 0) {
            html = '<tr><td colspan="7" class="v2-token-empty">暂无记录</td></tr>';
        }
        tbody.innerHTML = html;

        var countEl = document.getElementById('v2-token-count');
        if (countEl) {
            var validCount = getValidCachedTokens().length;
            countEl.textContent = validCount + '/' + tokens.length;
        }
        // 自动滚到底部
        if (tbody.scrollHeight > tbody.clientHeight) {
            tbody.scrollTop = tbody.scrollHeight;
        }
    }

    // 点击表格行展示详情
    win.__v2ShowDetail = function (idx) {
        var t = state.cachedTokens[idx];
        if (!t) return;
        var lines = [];
        lines.push('=== Token #' + (idx + 1) + ' ===');
        lines.push('ticket:  ' + t.ticket);
        lines.push('randstr: ' + t.randstr);
        lines.push('proxySession: ' + (t.proxySession || '-'));
        lines.push('proxyIP:     ' + (t.proxyIp || '-'));
        lines.push('预存时间: ' + new Date(t.timestamp).toLocaleTimeString());
        lines.push('');
        if (t.previewResult) {
            lines.push('=== Preview 响应 ===');
            lines.push(JSON.stringify(t.previewResult.raw, null, 2));
        }
        if (t.lockResult) {
            lines.push('');
            lines.push('=== 锁单结果 ===');
            lines.push(t.lockResult.success ? '成功' : '失败: ' + (t.lockResult.msg || t.lockResult.code || '?'));
            if (t.lockResult.raw) {
                lines.push(JSON.stringify(t.lockResult.raw, null, 2));
            }
        }
        var overlay = document.getElementById('v2-detail-overlay');
        var title = document.getElementById('v2-detail-title');
        var body = document.getElementById('v2-detail-body');
        var footer = document.getElementById('v2-detail-footer');
        if (overlay && title && body) {
            title.textContent = 'Token #' + (idx + 1);
            body.textContent = lines.join('\n');
            overlay.style.display = 'flex';

            // 详情弹窗底部按钮区域
            if (footer) {
                footer.innerHTML = '';
                var sign = t.lockResult && t.lockResult.success &&
                           t.lockResult.raw && t.lockResult.raw.data &&
                           t.lockResult.raw.data.sign;
                var previewData = t.previewResult && t.previewResult.raw &&
                                  t.previewResult.raw.data;

                if (sign && previewData) {
                    // 检查 QRCode 库是否可用
                    var QR = (typeof QRCode !== 'undefined') ? QRCode
                        : (typeof win.QRCode !== 'undefined') ? win.QRCode : null;

                    if (QR) {
                        // QRCode 库可用 → 直接弹出支付二维码
                        var payBtn = document.createElement('button');
                        payBtn.textContent = '重新弹出支付二维码';
                        payBtn.style.cssText = 'background:#e6a23c;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 24px;font-size:14px;cursor:pointer;margin:0 4px;';
                        payBtn.addEventListener('click', function () {
                            showPaymentQRPopup(sign, previewData);
                        });
                        footer.appendChild(payBtn);
                    } else {
                        // QRCode 库不可用 → 引导用户去在线工具生成
                        var tipEl = document.createElement('div');
                        tipEl.style.cssText = 'font-size:12px;color:#e6a23c;margin-bottom:8px;line-height:1.6;';
                        tipEl.textContent = '二维码库未加载，请手动生成：';
                        footer.appendChild(tipEl);

                        var copyBtn = document.createElement('button');
                        copyBtn.textContent = '复制 sign 链接';
                        copyBtn.style.cssText = 'background:#409eff;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 20px;font-size:13px;cursor:pointer;margin:0 4px;';
                        copyBtn.addEventListener('click', function () {
                            try {
                                navigator.clipboard.writeText(sign).then(function () {
                                    copyBtn.textContent = '已复制!';
                                    setTimeout(function () { copyBtn.textContent = '复制 sign 链接'; }, 2000);
                                });
                            } catch (e) {
                                // fallback
                                var ta = document.createElement('textarea');
                                ta.value = sign;
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                ta.remove();
                                copyBtn.textContent = '已复制!';
                                setTimeout(function () { copyBtn.textContent = '复制 sign 链接'; }, 2000);
                            }
                        });
                        footer.appendChild(copyBtn);

                        var onlineBtn = document.createElement('button');
                        onlineBtn.textContent = '在线生成二维码';
                        onlineBtn.style.cssText = 'background:#e6a23c;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 20px;font-size:13px;cursor:pointer;margin:0 4px;';
                        onlineBtn.addEventListener('click', function () {
                            window.open('https://freetoolkit.cn/tools/%E4%BA%8C%E7%BB%B4%E7%A0%81%E7%94%9F%E6%88%90', '_blank');
                        });
                        footer.appendChild(onlineBtn);
                    }
                } else if (previewData && !sign) {
                    // preview 成功但未锁单 → 打开支付页面
                    var productInfo = PRODUCTS[getSelectedPackageType()] &&
                        PRODUCTS[getSelectedPackageType()][getSelectedTier()];
                    if (productInfo && previewData.bizId) {
                        var openBtn = document.createElement('button');
                        openBtn.textContent = '打开支付页面';
                        openBtn.style.cssText = 'background:#409eff;color:#fff;border:none;border-radius:6px;' +
                            'padding:8px 24px;font-size:14px;cursor:pointer;margin:0 4px;transform:translateY(-20px);';
                        openBtn.addEventListener('click', function () {
                            openPaymentDialog(previewData, productInfo);
                        });
                        footer.appendChild(openBtn);
                    }
                }
            }
        }
    };

    // 定时刷新 token 显示（检查过期状态）
    var tokenDisplayTimer = null;
    function startTokenDisplayRefresh() {
        if (tokenDisplayTimer) clearInterval(tokenDisplayTimer);
        tokenDisplayTimer = setInterval(function () {
            if (state.cachedTokens.length > 0) {
                updateTokenDisplay();
            }
        }, 10000);
    }

    async function precacheOneToken() {
        if (!getTencentCaptcha()) {
            log('预存', '验证码SDK未就绪');
            return false;
        }
        try {
            log('预存', '弹出验证码...');
            var result = await getCaptchaTicket();
            addCachedToken(result.ticket, result.randstr, result.proxySession);
            log('预存', '成功！ticket: ' + result.ticket.substring(0, 20) + '...');
            return true;
        } catch (e) {
            log('预存', '失败: ' + e.message);
            return false;
        }
    }

    async function precacheTokens(count) {
        state.precacheRunning = true;
        updatePrecacheBtn(true);
        for (var i = 0; i < count; i++) {
            if (!state.precacheRunning) break;
            var success = await precacheOneToken();
            if (!success) {
                log('预存', '第 ' + (i + 1) + ' 个失败，停止');
                break;
            }
            log('预存', '进度: ' + (i + 1) + '/' + count);
            if (i < count - 1) await sleep(800);
        }
        state.precacheRunning = false;
        updatePrecacheBtn(false);
    }

    function stopPrecache() {
        state.precacheRunning = false;
        updatePrecacheBtn(false);
        log('预存', '已停止');
    }

    function updatePrecacheBtn(running) {
        var btn = document.getElementById('v2-precache-btn');
        if (btn) {
            btn.textContent = running ? '停止' : '预存';
            btn.className = running ? 'v2-btn v2-btn-danger' : 'v2-btn v2-btn-secondary';
        }
    }

    function getTargetPrecacheCount() {
        var el = document.getElementById('v2-precache-count');
        return Math.min(el ? (parseInt(el.textContent, 10) || 0) : 0, 5);
    }

    function getManualBizId() {
        var el = document.getElementById('v2-manual-bizid');
        return el ? el.value.trim() : '';
    }

    // ==================== 锁单失败后处理 ====================
    var PAY_AES_KEY = 'zhiPuAi123456789';

    function findCryptoJS() {
        // @require 在油猴沙箱里加载，变量名可能被隔离
        // 尝试多种方式查找
        var candidates = [];
        try { candidates.push(CryptoJS); } catch (e) {}
        try { candidates.push(win.CryptoJS); } catch (e) {}
        try { candidates.push(window.CryptoJS); } catch (e) {}
        try { candidates.push(unsafeWindow.CryptoJS); } catch (e) {}
        // 尝试通过 GM 信息脚本的全局
        try { candidates.push(self.CryptoJS); } catch (e) {}
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i] && candidates[i].AES && candidates[i].enc) {
                return candidates[i];
            }
        }
        return null;
    }

    function aesEncrypt(plaintext) {
        var CryptoJS = findCryptoJS();
        if (!CryptoJS) {
            log('支付', 'CryptoJS 未找到，尝试内联加载...');
            return null;
        }
        var key = CryptoJS.enc.Utf8.parse(PAY_AES_KEY);
        var encrypted = CryptoJS.AES.encrypt(plaintext, key, {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7
        });
        return encrypted.toString();
    }

    function buildPayMiddlePageUrl(previewData) {
        // 参考 SubscribePay.vue renderQrCode 方法：
        // info = { productId, productName, amount, customerId, customerName, bizId, ic, payType }
        // pay-middle-page 打开后会拿这些参数调 create-sign
        var info = {
            productId: previewData.productId,
            productName: previewData.productName || previewData.productBigTitle || '',
            amount: previewData.payAmount || previewData.thirdPartyAmount || 0,
            customerId: state.customerNumber || '',
            customerName: state.customerName || '',
            bizId: previewData.bizId || '',
            payType: 'alipay'
        };
        var jsonStr = JSON.stringify(info);
        var encrypted = aesEncrypt(jsonStr);
        if (!encrypted) return null;
        return window.location.origin + '/pay-middle-page?info=' + encodeURIComponent(encrypted);
    }

    function showQRPopup(qrDataUrl, amount, productName, subtitle, payUrl, large) {
        var existing = document.getElementById('v2-lockfail-popup');
        if (existing) existing.remove();
        var existingOverlay = document.getElementById('v2-lockfail-overlay');
        if (existingOverlay) existingOverlay.remove();
        var qrSize = large ? 350 : 240;
        var popupWidth = large ? 490 : 440;

        var popup = document.createElement('div');
        popup.id = 'v2-lockfail-popup';
        popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
            'background:#fff;border-radius:12px;padding:28px 32px;z-index:2000000030;min-width:340px;max-width:' + popupWidth + 'px;' +
            'box-shadow:0 8px 30px rgba(0,0,0,0.25);text-align:center;font-family:system-ui,sans-serif;';
        popup.innerHTML =
            '<div style="font-size:18px;font-weight:600;color:#333;margin-bottom:8px;">抢购成功！请扫码支付</div>' +
            '<div style="font-size:14px;color:#666;margin-bottom:4px;">' + (productName || '') + '</div>' +
            '<div style="font-size:28px;font-weight:bold;color:#e6a23c;margin-bottom:16px;">¥' + amount + '</div>' +
            '<div style="margin-bottom:12px;"><img id="v2-qr-img" src="' + qrDataUrl + '" style="width:' + qrSize + 'px;height:' + qrSize + 'px;border:1px solid #eee;border-radius:8px;" /></div>' +
            '<div style="font-size:12px;color:#999;margin-bottom:8px;">' + (subtitle || '请尽快用支付宝扫码支付') + '</div>' +
            (payUrl ? '<textarea readonly onclick="this.select();document.execCommand(\'copy\')" style="width:100%;max-width:360px;height:48px;font-size:11px;color:#409eff;border:1px solid #ddd;border-radius:4px;padding:4px 6px;resize:none;margin-bottom:16px;word-break:break-all;line-height:1.3;outline:none;cursor:pointer;" title="点击复制">' + payUrl + '</textarea>' : '') +
            '<div style="display:flex;gap:10px;justify-content:center;margin-top:12px;">' +
            '<button id="v2-lockfail-download" style="background:#67c23a;color:#fff;border:none;border-radius:6px;' +
            'padding:8px 20px;font-size:14px;cursor:pointer;">下载二维码</button>' +
            '<button id="v2-lockfail-close" style="background:#409eff;color:#fff;border:none;border-radius:6px;' +
            'padding:8px 28px;font-size:14px;cursor:pointer;">关闭</button></div>';
        document.body.appendChild(popup);

        var overlay = document.createElement('div');
        overlay.id = 'v2-lockfail-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:2000000029;';
        document.body.appendChild(overlay);

        var closePopup = function () { popup.remove(); overlay.remove(); };
        document.getElementById('v2-lockfail-close').onclick = closePopup;
        overlay.onclick = null;

        var dlBtn = document.getElementById('v2-lockfail-download');
        if (dlBtn) {
            dlBtn.onclick = function () {
                var a = document.createElement('a');
                a.href = qrDataUrl;
                a.download = 'pay_qr_' + Date.now() + '.png';
                a.click();
            };
        }
    }

    async function openPaymentDialog(previewData, product) {
        // 关闭残留验证码
        try {
            var captchaClose = document.querySelector('.tencent-captcha-dy__close-btn') ||
                document.querySelector('#tcaptcha_transform_dy .close-btn');
            if (captchaClose) captchaClose.click();
        } catch (e) {}

        // 构建 pay-middle-page URL 并用 QRCode 库生成二维码
        var payUrl = buildPayMiddlePageUrl(previewData);
        if (!payUrl) {
            log('支付', '构建支付 URL 失败');
            return false;
        }

        log('支付', '支付URL: ' + payUrl);

        var QR = (typeof QRCode !== 'undefined') ? QRCode
            : (typeof win.QRCode !== 'undefined') ? win.QRCode : null;
        if (!QR) {
            log('支付', 'QRCode 库未就绪');
            return false;
        }

        var amount = previewData.thirdPartyAmount || previewData.payAmount || 0;
        var productName = previewData.productName || '';

        QR.toDataURL(payUrl, {
            width: 600, margin: 4, errorCorrectionLevel: 'L'
        }, function (err, qrDataUrl) {
            if (err) {
                log('支付', 'QR生成失败: ' + err.message);
                return;
            }
            showQRPopup(qrDataUrl, amount, productName, '锁单失败，扫码后页面会自动请求锁单', payUrl);
            log('支付', '支付二维码已弹出');
        });

        return true;
    }

    // ==================== 截取官方 canvas 二维码 ====================
    async function generatePayQRCode(previewData, productInfo) {
        log('支付', '支付金额: ¥' + previewData.thirdPartyAmount);
        log('支付', 'bizId: ' + previewData.bizId);

        // 注意：generatePayQRCode 仅作为 QR 库不可用时的截图回退
        // 轮询等待 canvas 渲染完成（payPreviewFn 已在上层调用）
        var qrCanvas = null;
        for (var i = 0; i < 50; i++) {
            await sleep(200);
            qrCanvas = document.querySelector('.scan-qrcode-box canvas');
            if (qrCanvas && qrCanvas.width > 0 && qrCanvas.height > 0) {
                break;
            }
        }

        if (!qrCanvas || qrCanvas.width === 0 || qrCanvas.height === 0) {
            log('支付', '官方二维码未渲染，请手动查看页面弹窗');
            return;
        }

        var dataUrl = qrCanvas.toDataURL('image/png');
        var amount = previewData.thirdPartyAmount;
        var productName = productInfo.name || '';

        // 新窗口展示官方二维码
        try {
            var newWin = window.open('', '_blank');
            if (newWin) {
                newWin.document.write(
                    '<html><head><title>支付二维码</title></head>' +
                    '<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;">' +
                    '<div style="text-align:center;">' +
                    '<h2 style="color:#333;">请使用支付宝扫码支付' + (productName ? ' - ' + productName : '') + '</h2>' +
                    '<p style="color:#e6a23c;font-size:24px;font-weight:bold;">¥' + amount + '</p>' +
                    '<img src="' + dataUrl + '" style="width:300px;height:300px;border:1px solid #ddd;" />' +
                    '<p style="color:#999;font-size:14px;">请尽快扫码支付，二维码有效期有限</p>' +
                    '</div></body></html>'
                );
            }
        } catch (e) {
            log('支付', '新窗口打开失败: ' + e.message);
        }

        // 自动下载二维码图片
        try {
            var link = document.createElement('a');
            link.download = 'qrcode_' + productInfo.name + '_' + Date.now() + '.png';
            link.href = dataUrl;
            link.click();
            log('支付', '二维码图片已自动下载');
        } catch (e) {}

        log('支付', '官方二维码已截取并展示');
    }


    // ==================== 支付状态轮询 ====================
    var payPollTimer = null;

    function startPayStatusPolling(bizId) {
        if (payPollTimer) clearInterval(payPollTimer);

        var pollCount = 0;
        var maxPolls = 300; // 5分钟

        payPollTimer = setInterval(async function () {
            pollCount++;
            if (pollCount > maxPolls) {
                clearInterval(payPollTimer);
                log('支付', '轮询超时，请刷新页面查看支付状态');
                return;
            }

            try {
                var resp = await fetchPayStatus(bizId);
                if (resp.data === 'SUCCESS') {
                    clearInterval(payPollTimer);
                    log('支付', '支付成功！');
                    updatePayStatus('支付成功！');
                    state.running = false;
                    updatePanelState('支付成功！', 'success');
                }
            } catch (e) {
                // 静默忽略轮询错误
            }
        }, 1000);
    }

    function updatePayStatus(text) {
        var el = document.getElementById('v2-pay-status');
        if (el) el.textContent = text;
    }

    // ==================== 核心抢购流程 ====================
    // 架构：到点后流水线 — 解验证码 → 立即发 preview（不等结果）→ 解下一个
    // preview 是异步 HTTP，解第 N 个验证码时，前面 N-1 个 preview 已经在飞

    // 单次 preview（ticket 一次性使用，不可重试），检查 state.running 以便随时中止
    async function tryPreviewWithRetry(captchaResult, product) {
        if (!state.running) return null;
        if (captchaResult.proxySession) {
            useProxySession(captchaResult.proxySession);
            log('代理', 'preview 使用 session=' + captchaResult.proxySession);
        }
        var params = {
            productId: product.productId,
            ticket: captchaResult.ticket,
            randstr: captchaResult.randstr
        };

        var resp;
        try {
            resp = await fetchPreview(params);
        } catch (e) {
            log('接口', 'preview 失败: ' + e.message);
            if (isProxyEnabled()) newProxySession();
            return null;
        }
        if (isProxyEnabled()) newProxySession();
        if (!state.running) return null;

        if (resp.code === 200) {
            if (resp.data && !resp.data.soldOut) return resp.data;
            log('接口', '已售罄');
            // preview 单个接口确认售罄（200 + data.soldOut）→ 写入权威 confirmedSoldOut（仅此处写）
            product.soldOut = true;
            product.confirmedSoldOut = true;
            return null;
        }
        if (resp.code === 1001) {
            log('接口', '⚠️ 身份验证失败(1001)，请确认已登录bigmodel.cn');
            terminateScript('未登录，请刷新页面重新登录');
            return null;
        }
        await applyThrottle(resp.code, 'preview');
        log('接口', 'preview: code=' + resp.code + ' ' + (resp.msg || ''));
        return null;
    }

    // 防检测模式：把 preview 对齐到服务器时间整10秒边界（0/10/20/30/40/50），每分钟≤6次，规避 555 限流
    // 用全局10秒槽位 floor(now/10000) + lastPreviewSlot 互斥，保证每个整10秒边界最多1个 preview
    async function waitForAlignedPreviewSlot(label) {
        if (!getAntiDetect()) return;             // 防检测关闭，不限流
        while (state.running) {
            var now = getServerTime();
            var slot = Math.floor(now / 10000);   // 全局10秒槽位（随时间单调递增，跨分钟不重复）
            if (slot !== state.lastPreviewSlot) {
                state.lastPreviewSlot = slot;     // 占用该槽位
                return;                            // 放行
            }
            var waitMs = (slot + 1) * 10000 - now; // 到下个整10秒的毫秒数
            log('限流', (label || 'preview') + ' 对齐整10秒，等待 ' + waitMs + 'ms');
            await sleep(Math.min(waitMs, 500));    // 分段等待，便于响应暂停
        }
    }

    // 带 UI 记录的 preview（用于预存 token）
    // 返回 null 时，如果因售罄则附带返回调剂后的新产品
    async function tryPreviewWithRetryAndRecord(captchaResult, product, tokenObj) {
        if (!state.running) return null;
        await waitForAlignedPreviewSlot('预存'); // 防检测时对齐整10秒，控制每分钟请求数
        if (!state.running) return null;
        tokenObj.previewSentTime = Date.now();
        tokenObj.productName = product.name;
        var previewProxySession = tokenObj.proxySession || captchaResult.proxySession || '';
        if (previewProxySession) {
            tokenObj.proxySession = previewProxySession;
            useProxySession(previewProxySession);
            log('代理', 'preview 使用 session=' + previewProxySession);
        }
        var params = {
            productId: product.productId,
            ticket: captchaResult.ticket,
            randstr: captchaResult.randstr
        };

        var resp;
        try {
            resp = await fetchPreview(params);
            if (state.lastProxyIp) tokenObj.proxyIp = state.lastProxyIp;
        } catch (e) {
            tokenObj.previewResult = { success: false, code: 'ERR', msg: e.message, raw: null };
            if (state.lastProxyIp) tokenObj.proxyIp = state.lastProxyIp;
            updateTokenDisplay();
            if (isProxyEnabled()) newProxySession();
            return null;
        }
        if (isProxyEnabled()) newProxySession();
        if (!state.running) return null;

        if (resp.code === 200) {
             if (resp.data && !resp.data.soldOut) {
                tokenObj.previewResult = { success: true, soldOut: false, code: 200, raw: resp };
                updateTokenDisplay();
                // 附带 captcha 信息，供触发 Vue 原生支付弹窗使用
                resp.data._captchaTicket = captchaResult.ticket;
                resp.data._captchaRandstr = captchaResult.randstr;
                return resp.data;
            }
            tokenObj.previewResult = { success: false, soldOut: true, code: 200, raw: resp };
            updateTokenDisplay();
            // preview 单个接口确认售罄（200 + data.soldOut）→ 写入权威 confirmedSoldOut（仅此处写）
            product.soldOut = true;
            product.confirmedSoldOut = true;
            return null;
        }
        tokenObj.previewResult = { success: false, code: resp.code, msg: resp.msg, raw: resp };
        updateTokenDisplay();
        await applyThrottle(resp.code, '预存');
        if (resp.code === 1001) {
            log('接口', '⚠️ 身份验证失败(1001)，请确认已登录bigmodel.cn');
            terminateScript('未登录，请刷新页面重新登录');
        }
        return null;
    }

    // 流水线：解验证码 → await preview → 成功立即返回，失败继续下一个
    // maxAttempts：单产品最多尝试次数（默认 3；调剂模式轮换时传 1，失败即换下一个）
    async function solveAndFirePipeline(product, maxAttempts) {
        var attempts = maxAttempts || 3;
        for (var i = 0; i < attempts && state.running; i++) {
            // 等待 SDK 实例清理，避免验证码实例冲突导致拿到残留 ticket
            if (i > 0) await sleep(1500);

            try {
                log('线路' + (i + 1), '弹出验证码...');
                var captchaResult = await getCaptchaTicket();
            } catch (e) {
                log('线路' + (i + 1), '验证码失败: ' + e.message);
                continue;
            }
            if (!state.running) break;

            // 验证码结果基本校验
            if (!captchaResult || !captchaResult.ticket || captchaResult.ticket.length < 10) {
                log('线路' + (i + 1), '验证码返回无效 ticket，跳过');
                continue;
            }

            // 加入表格跟踪
            syncLastProxyIp();  // 从 captcha iframe 同步代理 IP（若有）
            var tokenObj = {
                ticket: captchaResult.ticket,
                randstr: captchaResult.randstr,
                proxySession: captchaResult.proxySession || state.proxySession || '',
                proxyIp: state.lastProxyIp || '',
                timestamp: Date.now(),
                previewSent: true,
                source: '实时',
                productName: product.name
            };
            state.cachedTokens.push(tokenObj);
            updateTokenDisplay();

            log('线路' + (i + 1), '验证码通过，请求 preview...');
            var data = await tryPreviewWithRetryAndRecord(captchaResult, product, tokenObj);
            if (data) {
                state.lastPipelineSoldOut = false;
                return { data: data, tokenObj: tokenObj };
            }

            // 检查是否因售罄失败 → 立即返回，让外层做调剂判断
            if (tokenObj.previewResult && tokenObj.previewResult.soldOut) {
                state.lastPipelineSoldOut = true;
                return null;
            }
            state.lastPipelineSoldOut = false;

            // 非售罄失败，等待 SDK 清理后继续本轮
            log('线路' + (i + 1), 'preview 失败，等待 SDK 清理...');
            await sleep(1000);
        }
        return null;
    }

    async function executePurchase() {
        var packageType = getSelectedPackageType();
        var tier = getSelectedTier();
        var product;

        // 调剂模式：从「全部已勾选套餐」中优先级最高的开始，逐个尝试；否则用单选套餐
        if (acceptAlternativeEnabled()) {
            product = firstEnabledAlternative();
            if (!product) {
                log('错误', '调剂模式未勾选任何套餐，请点「?」配置');
                terminateScript('未配置调剂套餐');
                return false;
            }
            log('调剂', '起始套餐: ' + product.name + '（按优先级逐个尝试）');
        } else {
            product = PRODUCTS[packageType][tier];
            if (!product) {
                log('错误', '未找到产品: ' + packageType + '/' + tier);
                return false;
            }
        }

        log('抢购', '目标: ' + product.name);
        state.wasSoldOutAtStart = product.confirmedSoldOut;

        // 调剂模式：如果起始套餐已被真实 preview 确认售罄，切换到下一个有货的
        // 注意：仅参考 confirmedSoldOut（真实 preview 200+soldOut），batch-preview 的 soldOut 不作为终止/切换依据
        if (acceptAlternativeEnabled() && product.confirmedSoldOut) {
            var altProduct = findNextAvailableProduct(product);
            if (altProduct && altProduct.productId !== product.productId) {
                log('调剂', '切换到: ' + altProduct.name);
                product = altProduct;
            }
        }

        clickPagePackageTab(product);

        // Phase 0: 手动 bizId 直通锁单（绕过 preview）
        var manualBizId = getManualBizId();
        if (manualBizId) {
            log('直通', '检测到手动 bizId，跳过 preview，直接锁单');
            var manualPreviewData = {
                productId: product.productId,
                bizId: manualBizId,
                thirdPartyAmount: product.payAmount || product.price
            };
            var manualLockResult = await tryLockOrder(manualPreviewData);
            var manualTokenObj = {
                ticket: '(手动bizId)',
                randstr: '',
                proxyIp: '',
                timestamp: Date.now(),
                previewSent: true,
                source: '手动',
                previewResult: { success: true, code: 200, raw: { data: manualPreviewData } }
            };
            if (manualLockResult.success) {
                manualTokenObj.lockResult = { success: true, raw: manualLockResult };
                state.cachedTokens.push(manualTokenObj);
                updateTokenDisplay();
                log('直通', '锁单成功！bizId=' + manualBizId);
                showPaymentQRPopup(manualLockResult.sign, manualPreviewData);
                return true;
            }
            manualTokenObj.lockResult = { success: false, raw: manualLockResult.raw };
            state.cachedTokens.push(manualTokenObj);
            updateTokenDisplay();
            log('直通', '锁单失败: ' + (manualLockResult.msg || manualLockResult.code) + '，触发原生弹窗');
            await openPaymentDialog(manualPreviewData, product);
            return true;
        }

        // Phase 1: 用预存 token 逐个请求（LIFO：后进先出，最新的 token 优先使用）
        // 调剂模式跳过本阶段——预存 token 由 alternativeRoundRobin 在轮换中消耗
        var cachedTokens = getValidCachedTokens().reverse();
        if (!acceptAlternativeEnabled() && cachedTokens.length > 0) {
            updatePanelState('预存token请求中 (' + cachedTokens.length + '个)...', 'running');
            log('预存', '逐个请求 preview，共 ' + cachedTokens.length + ' 个');

            for (var i = 0; i < cachedTokens.length; i++) {
                if (!state.running) break;
                var token = cachedTokens[i];
                token.previewSent = true;
                if (!token.source) token.source = '预存';
                token.productName = product.name;
                token.previewSentTime = Date.now();
                updateTokenDisplay();

                var previewData = await tryPreviewWithRetryAndRecord(
                    { ticket: token.ticket, randstr: token.randstr },
                    product,
                    token
                );

                if (previewData) {
                    log('抢购', '预存token命中！¥' + previewData.thirdPartyAmount);

                    var lockResult = await tryLockOrder(previewData);
                    token.lockResult = { success: lockResult.success, raw: lockResult.raw };
                    updateTokenDisplay();

                    if (lockResult.success) {
                        showPaymentQRPopup(lockResult.sign, previewData);
                        return true;
                    }
                    // 锁单失败，直接弹出页面原生支付弹窗
                    log('抢购', '锁单失败，触发页面原生支付弹窗');
                    await openPaymentDialog(previewData, product);
                    return true;
                }

                // preview 失败：检查是否因售罄
                if (token.previewResult && token.previewResult.soldOut) {
                    state.lastPipelineSoldOut = true;
                    if (canActOnSoldOut()) {
                        if (acceptAlternativeEnabled()) {
                            product = switchToNextAlternative(product);
                            if (!product) {
                                addSoldOutTokenRow('所有套餐已售罄');
                                terminateScript('该套餐已经售罄');
                                return false;
                            }
                            log('调剂', '切换到: ' + product.name);
                            // 用新产品继续试后续 token
                            continue;
                        } else {
                            addSoldOutTokenRow(product.name + ' 已售罄');
                            terminateScript('该套餐已经售罄');
                            return false;
                        }
                    } else {
                        // 锁定窗口内：认定非售罄，不终止/切换，继续试下一个 token
                        log('锁定', '锁定窗口内 ' + product.name + ' preview 返回售罄，认定非售罄，继续');
                    }
                } else {
                    state.lastPipelineSoldOut = false;
                }

                if (i < cachedTokens.length - 1 && !getAntiDetect()) {
                    await sleep(CONFIG.PRECACHE_INTERVAL);
                }
            }
            log('抢购', '预存token全部失败，进入普通抢购');
        }

        // Phase 2: 普通抢购
        // 调剂模式：在所有已接受套餐间轮换抢购（失败即换下一个，售罄永久移出，batch-preview 可复活）
        if (acceptAlternativeEnabled()) {
            return await alternativeRoundRobin(product);
        }
        while (state.running) {
            // 仅当被真实 preview 确认售罄（confirmedSoldOut）才考虑切换/终止；
            // batch-preview 的 soldOut 仅用于展示，绝不触发终止（防止限流导致的假售罄）。
            if (product.confirmedSoldOut && canActOnSoldOut()) {
                if (acceptAlternativeEnabled()) {
                    var nextProduct = switchToNextAlternative(product);
                    if (!nextProduct) {
                        addSoldOutTokenRow('所有套餐已售罄');
                        terminateScript('该套餐已经售罄');
                        return false;
                    }
                    log('调剂', '切换到: ' + nextProduct.name);
                    product = nextProduct;
                } else {
                    addSoldOutTokenRow(product.name + ' 已售罄');
                    terminateScript('该套餐已经售罄');
                    return false;
                }
            }

            if (!getTencentCaptcha()) {
                log('抢购', '验证码SDK未就绪');
                break;
            }

            state.lastPipelineSoldOut = false;
            var pipelineResult = await solveAndFirePipeline(product);
            if (pipelineResult) {
                var data = pipelineResult.data;
                var tokenObj = pipelineResult.tokenObj;
                log('抢购', '抢到了！¥' + data.thirdPartyAmount);

                // 先尝试锁单
                var lockResult = await tryLockOrder(data);
                if (tokenObj) {
                    tokenObj.lockResult = { success: lockResult.success, raw: lockResult.raw };
                    updateTokenDisplay();
                }
                if (lockResult.success) {
                    showPaymentQRPopup(lockResult.sign, data);
                    return true;
                }
                // 锁单失败，直接弹出页面原生支付弹窗
                log('抢购', '锁单失败，触发页面原生支付弹窗');
                await openPaymentDialog(data, product);
                return true;
            }

            if (!state.running) {
                log('抢购', '已手动停止');
                return false;
            }

            // 检查是否因售罄失败
            if (state.lastPipelineSoldOut) {
                if (canActOnSoldOut()) {
                    if (acceptAlternativeEnabled()) {
                        product = switchToNextAlternative(product);
                        if (!product) {
                            addSoldOutTokenRow('所有套餐已售罄');
                            terminateScript('该套餐已经售罄');
                            return false;
                        }
                        log('调剂', '切换到: ' + product.name);
                        continue;
                    } else {
                        addSoldOutTokenRow(product.name + ' 已售罄');
                        terminateScript('该套餐已经售罄');
                        return false;
                    }
                } else {
                    // 锁定窗口内：认定非售罄，持续重试
                    log('锁定', '锁定窗口内 ' + product.name + ' preview 返回售罄，认定非售罄，继续重试');
                }
            }

            log('抢购', '本轮全部失败，继续...');
            await sleep(800);
        }
        return false;
    }

    // ==================== 定时调度 ====================
    function getBuyTimeStr() {
        var el = document.getElementById('v2-buy-time');
        return (el && el.value) ? el.value : CONFIG.BUY_TIME_DEFAULT;
    }

    function parseBuyTime() {
        var parts = getBuyTimeStr().split(':');
        return {
            h: parseInt(parts[0], 10) || 0,
            m: parseInt(parts[1], 10) || 0,
            s: parseInt(parts[2], 10) || 0
        };
    }

    function getSecondsToBuyTime() {
        var now = new Date(getServerTime());
        var t = parseBuyTime();
        var target = new Date(now);
        target.setHours(t.h, t.m, t.s, 0);
        if (now >= target) return 0;
        return Math.floor((target - now) / 1000);
    }

    function getSelectedPackageType() {
        var radio = document.querySelector('input[name="v2-package"]:checked');
        return radio ? radio.value : CONFIG.PACKAGE_TYPE_DEFAULT;
    }

    function getSelectedTier() {
        var radio = document.querySelector('input[name="v2-tier"]:checked');
        return radio ? radio.value : CONFIG.TIER_DEFAULT;
    }

    // 主循环
    async function mainLoop() {
        if (!state.running) return;

        var secs = getSecondsToBuyTime();

        if (secs > 0) {
            var m = Math.floor(secs / 60);
            var s = secs % 60;
            updatePanelState('等待 ' + getBuyTimeStr() + ' (' + m + ':' + (s < 10 ? '0' : '') + s + ')', 'waiting');

            // 自动预存：倒计时 < 30s 时触发（用 precacheRunning 阻止重复）
            var autoPrecache = document.getElementById('v2-auto-precache')?.checked;
            if (autoPrecache && secs <= 30 && secs > 1 && !state.precacheRunning) {
                var validCount = getValidCachedTokens().length;
                var targetCount = getTargetPrecacheCount();
                if (validCount < targetCount) {
                    log('预存', '自动预存启动 (' + validCount + '/' + targetCount + ')');
                    precacheTokens(targetCount - validCount);
                }
            }

            // 连接预热：倒计时 ≤ 30s 开始
            if (secs <= 30 && secs > 0) {
                startConnectionPreheat();
            }

            // 轮询加速：1s 内切 50ms 精确卡点
            var interval = secs <= 1 ? 50 : 1000;
            state.timer = setTimeout(mainLoop, interval);
            return;
        }

        // 停止正在进行的预存
        state.precacheRunning = false;
        updatePrecacheBtn(false);
        // 停止连接预热
        stopConnectionPreheat();

        // 关闭可能正在显示的验证码弹窗，让 precacheOneToken 的 await 尽快返回
        try {
            var captchaCloseBtn = document.querySelector('.tencent-captcha-dy__close-btn');
            if (captchaCloseBtn) captchaCloseBtn.click();
        } catch (e) {}

        // 等待预存流程收尾（getCaptchaTicket reject → precacheOneToken 返回 → 循环 break）
        await sleep(500);

        // 到点！—— 库存锁定窗口从「此刻」起算 30s（而非点击开始时），避免倒计时阶段被误判售罄
        if (!state.lockoutArmed) {
            state.lockoutArmed = true;
            startRefreshLockout();
        }
        updatePanelState('抢购中...', 'running');

        // 检查验证码SDK是否就绪
        if (!getTencentCaptcha()) {
            log('等待', '验证码SDK未就绪，3秒后重试...');
            updatePanelState('等待SDK加载...', 'waiting');
            state.timer = setTimeout(mainLoop, 3000);
            return;
        }

        try {
            var success = await executePurchase();
            if (success) {
                state.running = false;
                stopBatchPreviewPoll();
                stopRefreshLockout();
                setRefreshButtonState('normal');
                resetStartButton();
                updatePanelState('抢购成功！', 'success');
                return;
            }
        } catch (e) {
            log('错误', e.message);
        }

        if (state.running) {
            updatePanelState('重试中...', 'running');
            state.timer = setTimeout(mainLoop, 1000);
        }
    }

    // ==================== 检测本地OCR服务 ====================
    function checkLocalOcrService() {
        var baseUrl = CONFIG.DDDDOCR_URL.replace(/\/click$/, '/');
        var onError = function () {
            log('OCR', '本地服务未启动，请先启动 captcha/ddddocr_server.py');
        };
        var onSuccess = function () {
            log('OCR', '本地识别服务已连接');
        };
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET', url: baseUrl, timeout: 2000,
                onload: onSuccess, onerror: onError, ontimeout: onError
            });
        } else {
            var controller = new AbortController();
            var tid = setTimeout(function () { controller.abort(); }, 2000);
            fetch(baseUrl, { mode: 'no-cors', signal: controller.signal })
                .then(function () { clearTimeout(tid); onSuccess(); })
                .catch(function () { clearTimeout(tid); onError(); });
        }
    }

    // ==================== 控制面板UI ====================
    function createControlPanel() {
        var panel = document.createElement('div');
        panel.id = 'v2-control-panel';

        var savedTime = loadSetting('v2_buy_time', CONFIG.BUY_TIME_DEFAULT);
        var savedPkg = loadSetting('v2_package', CONFIG.PACKAGE_TYPE_DEFAULT);
        var savedTier = loadSetting('v2_tier', CONFIG.TIER_DEFAULT);
        var savedInterval = loadSetting('v2_precache_interval', String(CONFIG.PRECACHE_INTERVAL));
        var savedPrecacheCount = Math.min(parseInt(loadSetting('v2_precache_count', '1'), 10) || 1, 5);
        var savedAutoPrecache = loadSetting('v2_auto_precache', 'true');
        var savedShowLog = loadSetting('v2_show_log', 'false');
        var savedAntiDetect = loadSetting('v2_anti_detect', 'false');
        var savedAcceptAlt = loadSetting('v2_accept_alternative', 'false');
        var savedThrottle = loadSetting('v2_throttle', 'false');
        var savedProxy = loadSetting('v3_proxy_enabled', 'false');
        var savedAutoRelogin = loadSetting('v3_auto_relogin', 'false');

        // 恢复 CONFIG
        CONFIG.PRECACHE_INTERVAL = parseInt(savedInterval, 10) || 1800;

        panel.innerHTML =
            '<div class="v2-panel-row">' +
            '<div class="v2-status-dot" id="v2-status-dot"></div>' +
            '<span id="v2-status-text">就绪</span>' +
            '<span id="v2-time-offset" style="color:#67c23a;font-size:10px;margin-left:auto;"></span>' +
            '<button id="v2-help-btn" class="v2-btn-mini" style="margin-left:4px;">说明</button>' +
            '</div>' +
            '<div id="v2-single-pkg">' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">套餐</span>' +
            '<div class="v2-radio-group">' +
            '<input type="radio" name="v2-package" id="v2-pkg-month" value="month"' + (savedPkg === 'month' ? ' checked' : '') + '><label for="v2-pkg-month">月</label>' +
            '<input type="radio" name="v2-package" id="v2-pkg-quarter" value="quarter"' + (savedPkg === 'quarter' ? ' checked' : '') + '><label for="v2-pkg-quarter">季</label>' +
            '<input type="radio" name="v2-package" id="v2-pkg-year" value="year"' + (savedPkg === 'year' ? ' checked' : '') + '><label for="v2-pkg-year">年</label>' +
            '</div>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">档位</span>' +
            '<div class="v2-radio-group">' +
            '<input type="radio" name="v2-tier" id="v2-tier-lite" value="lite"' + (savedTier === 'lite' ? ' checked' : '') + '><label for="v2-tier-lite">Lite</label>' +
            '<input type="radio" name="v2-tier" id="v2-tier-pro" value="pro"' + (savedTier === 'pro' ? ' checked' : '') + '><label for="v2-tier-pro">Pro</label>' +
            '<input type="radio" name="v2-tier" id="v2-tier-max" value="max"' + (savedTier === 'max' ? ' checked' : '') + '><label for="v2-tier-max">Max</label>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '<div id="v2-alt-summary" class="v2-alt-summary-box" style="display:none;"></div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">时间</span>' +
            '<input type="time" id="v2-buy-time" step="1" value="' + savedTime + '">' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">产品</span>' +
            '<span id="v2-product-info" class="v2-product-info"></span>' +
            '<button id="v2-refresh-btn" class="v2-btn-mini">刷新</button>' +
            '</div>' +
            '<div class="v2-separator"></div>' +
            '<div class="v2-panel-row"' + (CONFIG.ENABLE_MANUAL_BIZID ? '' : ' style="display:none;"') + '>' +
            '<span class="v2-label">bizId</span>' +
            '<input type="text" id="v2-manual-bizid" class="v2-bizid-input" placeholder="留空走正常流程">' +
            '<span class="v2-hint">直通锁单</span>' +
            '</div>' +
            '<div class="v2-separator"></div>' +
            '<div class="v2-panel-row v2-precache-row">' +
            '<span class="v2-label" style="width:50px;">预存<button id="v2-precache-help" class="v2-help-btn" title="预存说明">?</button></span>' +
            '<div class="v2-stepper">' +
            '<button id="v2-precache-minus" class="v2-stepper-btn">-</button>' +
            '<span id="v2-precache-count" class="v2-stepper-val">' + savedPrecacheCount + '</span>' +
            '<button id="v2-precache-plus" class="v2-stepper-btn">+</button>' +
            '</div>' +
            '<span class="v2-hint">个</span>' +
            '<span id="v2-token-count" class="v2-token-count">0/0</span>' +
            '<button id="v2-precache-btn" class="v2-btn-mini">预存</button>' +
            '<button id="v2-clear-tokens-btn" class="v2-btn-mini">清空</button>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<span class="v2-label">间隔</span>' +
            '<input type="number" id="v2-precache-interval" min="0" value="' + savedInterval + '" class="v2-num-input" style="width:52px;">' +
            '<span class="v2-hint">ms(预存消耗间隔)</span>' +
            '</div>' +
            '<div class="v2-tabs">' +
            '<button type="button" class="v2-tab v2-tab-active" id="v2-tab-tokens">抢购记录</button>' +
            '<button type="button" class="v2-tab" id="v2-tab-refresh">库存刷新</button>' +
            '</div>' +
            '<div class="v2-tab-panel" id="v2-panel-tokens">' +
            '<table class="v2-token-table" id="v2-token-table">' +
            '<thead><tr><th>#</th><th>ticket</th><th>套餐</th><th>时间</th><th>代理IP</th><th>preview</th><th>锁单</th></tr></thead>' +
            '<tbody id="v2-token-tbody"><tr><td colspan="7" class="v2-token-empty">暂无预存</td></tr></tbody>' +
            '</table>' +
            '</div>' +
            '<div class="v2-tab-panel" id="v2-panel-refresh" style="display:none;">' +
            '<div class="v2-panel-row" style="justify-content:flex-end;margin:2px 0;">' +
            '<button type="button" class="v2-btn-mini" id="v2-clear-refresh-btn">清空</button>' +
            '</div>' +
            '<table class="v2-token-table v2-refresh-table">' +
            '<thead><tr><th>时间</th><th>来源</th><th>code</th><th>结果</th></tr></thead>' +
            '<tbody id="v2-refresh-tbody"><tr><td colspan="4" class="v2-token-empty">暂无刷新记录</td></tr></tbody>' +
            '</table>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v2-auto-precache"' + (savedAutoPrecache !== 'false' ? ' checked' : '') + ' />' +
            '自动预存(倒计时&lt;30s)' +
            '</label>' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v2-show-log"' + (savedShowLog === 'true' ? ' checked' : '') + ' />' +
            '日志' +
            '</label>' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v2-anti-detect"' + (savedAntiDetect === 'true' ? ' checked' : '') + ' />' +
            '防检测' +
            '</label>' +
            '<label class="v2-checkbox-label" style="display:none;">' +
            '<input type="checkbox" id="v2-throttle"' + (savedThrottle === 'true' ? ' checked' : '') + ' />' +
            '控流' +
            '</label>' +
            '</div>' +
            '<div class="v2-panel-row">' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v2-accept-alternative"' + (savedAcceptAlt === 'true' ? ' checked' : '') + ' />' +
            '调剂模式' +
            '</label>' +
            '<button id="v2-alt-help" class="v2-help-btn" style="margin-left:4px;" title="调剂说明">?</button>' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v3-proxy-enabled"' + (savedProxy === 'true' ? ' checked' : '') + ' />' +
            '代理池' +
            '</label>' +
            '<label class="v2-checkbox-label">' +
            '<input type="checkbox" id="v3-auto-relogin"' + (savedAutoRelogin === 'true' ? ' checked' : '') + ' />' +
            '自动重登' +
            '</label>' +
            '<button id="v3-manual-relogin" type="button" class="v2-btn-mini" style="margin-left:6px;display:none;" title="用已配置的账密立即重新登录刷新 token">手动重登</button>' +
            '<span id="v3-proxy-status" class="v2-hint" style="margin-left:4px;color:#e6a23c;"></span>' +
            '</div>' +
            '<div class="v2-separator"></div>' +
            '<div class="v2-panel-row v2-btn-row">' +
            '<button id="v2-start-btn" class="v2-btn v2-btn-primary">开始抢购</button>' +
            '<button id="v2-test-btn" class="v2-btn v2-btn-secondary" style="display:none;">测试验证码</button>' +
            '</div>' +
            '<div style="text-align:right;font-size:10px;color:#999;padding:2px 4px 0 0;">v2.3.3</div>' +
            '<div class="v2-log-area v2-log-hidden" id="v2-log-area"></div>' +
            '<div class="v2-detail-overlay" id="v2-detail-overlay" style="display:none;">' +
            '<div class="v2-detail-box">' +
            '<div class="v2-detail-header"><span id="v2-detail-title">详情</span><button id="v2-detail-close">&times;</button></div>' +
            '<pre class="v2-detail-body" id="v2-detail-body"></pre>' +
            '<div id="v2-detail-footer" style="padding:0 16px 12px;text-align:center;transform: translateY(-20px);"></div>' +
            '</div>' +
            '</div>' +
            '<div class="v2-help-overlay" id="v2-help-overlay" style="display:none;">' +
            '<div class="v2-help-box">' +
            '<h3>预存功能说明</h3>' +
            '<p><span class="v2-help-highlight">什么是预存？</span><br/>' +
            '预存是指在抢购倒计时结束前，提前完成验证码识别并缓存获得的 ticket 凭证。这样在正式抢购时可以直接使用缓存的凭证发起请求，跳过验证码识别环节，从而大幅减少延迟。</p>' +
            '<p><span class="v2-help-step">工作流程：</span></p>' +
            '<p>1. 手动点击"预存"或开启"自动预存"（倒计时 ≤ 30s 自动触发）<br/>' +
            '2. 脚本自动弹出腾讯验证码并通过 OCR 识别完成验证<br/>' +
            '3. 验证通过后获得 ticket + randstr，存入缓存（有效期 180 秒）<br/>' +
            '4. 到达抢购时间时，脚本用缓存的 ticket 直接请求 preview 接口（后进先出）<br/>' +
            '5. 每个预存 token 会独立请求 preview，命中即可锁单</p>' +
            '<p><span class="v2-help-highlight">使用建议：</span><br/>' +
            '- 预存 1~5 个即可，太多可能触发验证码频率限制<br/>' +
            '- token 有效期 180 秒，预存过早会过期失效<br/>' +
            '- 表格中可以看到每个 token 的 preview 和锁单结果</p>' +
            '<p><span class="v2-help-highlight">请求间隔：</span><br/>' +
            '面板中的"间隔"设置控制抢购时每个预存 token 发起 preview 请求之间的等待时间。默认 1800ms，间隔太短容易触发服务端繁忙（555），间隔太长则可能错过抢购窗口。建议根据网络状况调整，网络好可适当缩短。</p>' +
            '<button class="v2-help-close" id="v2-help-close">知道了</button>' +
            '</div>' +
            '</div>' +
            '<div class="v2-help-overlay" id="v2-main-help-overlay" style="display:none;">' +
            '<div class="v2-help-box" style="max-width:460px;">' +
            '<h3>使用说明 <span style="font-size:11px;color:#888;font-weight:normal;">v2.3.3</span></h3>' +
            '<div class="v2-help-item"><span class="v2-help-num">1.</span>请<span class="v2-help-highlight">提前进入抢号界面</span>，高峰期页面可能无法加载。进入后<span class="v2-help-highlight">不要刷新</span>。选择套餐和档位，设置抢购时间，点击"开始抢购"即可到点自动抢购。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">2.</span>可将倒计时设置为当日更早的时间进行<span class="v2-help-highlight">测试</span>，验证脚本是否正常工作。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">3.</span>验证码识别使用本地 ddddocr 服务（<span class="v2-help-highlight">需提前启动 captcha/ddddocr_server.py</span>），识别速度约 100ms。若未启动本地服务，脚本启动时会弹出警告提示。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">4.</span>脚本原理是自动激活购买按钮并通过接口直接调用，不使用暴力手段。能否抢到仍需运气，祝您好运！</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">5.</span><span class="v2-help-highlight">锁单机制</span>：preview 成功后自动调 create-sign 接口锁单，锁住订单后弹出支付二维码。若锁单失败，会自动弹出页面原生支付弹窗供您扫码。若锁单成功但二维码未弹出，可在接口记录详情中点击「重新弹出支付二维码」，或复制 sign 链接到 <a href="https://freetoolkit.cn/tools/%E4%BA%8C%E7%BB%B4%E7%A0%81%E7%94%9F%E6%88%90" target="_blank" style="color:#409eff;">在线二维码生成工具</a> 手动生成。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">6.</span><span class="v2-help-highlight">预存</span>：在抢购前提前解验证码缓存 ticket，到点直接用缓存请求。详情请点击预存旁的 <span style="color:#409eff;">?</span> 按钮。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">7.</span><span class="v2-help-highlight">间隔</span>：抢购时每个预存 token 发起 preview 请求之间的等待时间（ms），默认 1800，太快可能触发服务端繁忙。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">8.</span><span class="v2-help-highlight">调剂模式</span>：勾选后，面板套餐区改为展示所有已勾选套餐及售罄状况（点「?」配置勾选与优先级）。抢购时按优先级对所有勾选套餐逐个尝试，某套餐被真实 preview 确认售罄后自动切换下一个。</div>' +
            '<div class="v2-help-item"><span class="v2-help-num">9.</span><span class="v2-help-highlight">控流</span>：勾选后，preview 接口返回 <span style="color:#409eff;">555</span> 暂停 3 秒、<span style="color:#409eff;">500</span> 暂停 8 秒，自动降速规避官方限流；不勾选则按原节奏快速重试。仅作用于抢购 preview（验证码走腾讯 SDK，不返回 555/500）。</div>' +
            '<div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.08);text-align:center;">' +
            '<p style="color:#409eff;margin-bottom:0;font-size:12px;">QQ交流群: <strong>981656846</strong></p>' +
            '</div>' +
            '<button class="v2-help-close" id="v2-main-help-close">我知道了</button>' +
            '</div>' +
            '</div>' +
            '<div class="v2-help-overlay" id="v2-alt-help-overlay" style="display:none;">' +
            '<div class="v2-help-box" style="max-width:420px;">' +
            '<h3>调剂功能说明</h3>' +
            '<p><span class="v2-help-highlight">预购套餐售罄后，自动切换其他套餐。</span><br/>' +
            '勾选"调剂模式"后，脚本会按下面的优先级顺序，对所有勾选的套餐逐个尝试抢购；' +
            '某套餐被真实 preview 确认售罄后，自动切换到下一个有货的套餐。</p>' +
            '<p style="font-size:12px;color:#666;">- <span style="color:#409eff;">拖拽</span> 行左侧手柄可调整优先级顺序（越靠前越优先）<br/>' +
            '- <span style="color:#409eff;">取消勾选</span> 可排除不想接受的套餐</p>' +
            '<div class="v2-alt-list" id="v2-alt-list"></div>' +
            '<div style="display:flex;gap:8px;margin-top:12px;">' +
            '<button class="v2-help-close" id="v2-alt-help-close" style="flex:1;">确定</button>' +
            '<button class="v2-help-close" id="v2-alt-reset-btn" style="flex:1;background:#909399;border-color:#909399;color:#fff;">重置</button>' +
            '</div>' +
            '</div>' +
            '</div>';

        document.body.appendChild(panel);

        // 绑定事件
        document.getElementById('v2-start-btn').addEventListener('click', function () {
            state.running = !state.running;
            if (state.running) {
                this.textContent = '停止';
                this.className = 'v2-btn v2-btn-danger';
                saveProxySession('');     // v3：session 改为每组「验证码+preview」生成，开始时清空旧值
                state.lockoutArmed = false;   // 锁定窗口改在「到点」激活（见 mainLoop），点击时仅重置标志
                startBatchPreviewPoll();
                mainLoop();
            } else {
                this.textContent = '开始抢购';
                this.className = 'v2-btn v2-btn-primary';
                clearTimeout(state.timer);
                stopRefreshLockout();
                setRefreshButtonState('normal');
                stopBatchPreviewPoll();
                updatePanelState('已停止', 'idle');
            }
        });

        // 预存间隔
        document.getElementById('v2-precache-interval').addEventListener('input', function () {
            var val = parseInt(this.value, 10);
            if (val > 0) {
                CONFIG.PRECACHE_INTERVAL = val;
                saveSetting('v2_precache_interval', val);
            }
        });

        // v3：代理池开关
        var proxyCb = document.getElementById('v3-proxy-enabled');
        if (proxyCb) {
            proxyCb.addEventListener('change', function () {
                state.proxyEnabled = this.checked;
                saveProxyEnabled(this.checked);
                if (this.checked) {
                    checkProxyHealth();   // 开启时立即探测；未就绪会 terminateScript 提示
                } else {
                    state.proxyReady = false;
                    updateProxyStatusUI();
                }
            });
        }

        // v3：自动重登开关 —— 勾选时弹窗配置账密，确认后才真正勾上；取消勾选直接关闭
        var reloginCb = document.getElementById('v3-auto-relogin');
        if (reloginCb) {
            reloginCb.addEventListener('change', function () {
                var self = this;
                if (self.checked) {
                    self.checked = false;   // 先回退，等弹窗确认后再勾上
                    openAccountDialog(function () {
                        self.checked = true;
                        state.autoReloginEnabled = true;
                        saveSetting('v3_auto_relogin', 'true');
                        log('登录', '已启用自动重登');
                        updateManualReloginBtn();
                    });
                } else {
                    state.autoReloginEnabled = false;
                    saveSetting('v3_auto_relogin', 'false');
                    log('登录', '已关闭自动重登');
                }
            });
        }
        state.autoReloginEnabled = (savedAutoRelogin === 'true');   // 初始化同步持久化状态

        // v3：手动重登按钮 —— 有账密才显示，点击立即 relogin 刷新 cookie token
        var manualBtn = document.getElementById('v3-manual-relogin');
        if (manualBtn) {
            manualBtn.addEventListener('click', function () {
                if (!hasLoginCredentials()) return;
                this.disabled = true;
                var orig = this.textContent;
                this.textContent = '登录中…';
                var self = this;
                relogin().then(function () {
                    self.disabled = false;
                    self.textContent = orig;
                });
            });
        }
        updateManualReloginBtn();   // 初始显隐：有账密才显示

        // 预存按钮
        document.getElementById('v2-precache-btn').addEventListener('click', function () {
            if (state.precacheRunning) {
                stopPrecache();
                return;
            }
            var count = getTargetPrecacheCount();
            precacheTokens(count);
        });

        // 清空 token
        document.getElementById('v2-clear-tokens-btn').addEventListener('click', function () {
            stopPrecache();
            clearCachedTokens();
        });

        // 标签页切换：抢购记录 / 库存刷新
        document.getElementById('v2-tab-tokens').addEventListener('click', function () { setActiveTab('tokens'); });
        document.getElementById('v2-tab-refresh').addEventListener('click', function () { setActiveTab('refresh'); });
        document.getElementById('v2-clear-refresh-btn').addEventListener('click', clearRefreshLogs);
        setActiveTab(loadSetting('v2_active_tab', 'tokens'));

        // 预存数量 +/\-
        function adjustPrecacheCount(delta) {
            var el = document.getElementById('v2-precache-count');
            var v = parseInt(el.textContent, 10) || 0;
            v = Math.max(0, Math.min(5, v + delta));
            el.textContent = v;
            saveSetting('v2_precache_count', v);
        }
        document.getElementById('v2-precache-minus').addEventListener('click', function () { adjustPrecacheCount(-1); });
        document.getElementById('v2-precache-plus').addEventListener('click', function () { adjustPrecacheCount(1); });

        // 自动预存
        document.getElementById('v2-auto-precache').addEventListener('change', function () {
            saveSetting('v2_auto_precache', String(this.checked));
        });

        // 日志 toggle
        document.getElementById('v2-show-log').addEventListener('change', function () {
            var el = document.getElementById('v2-log-area');
            if (this.checked) {
                el.classList.remove('v2-log-hidden');
            } else {
                el.classList.add('v2-log-hidden');
            }
            saveSetting('v2_show_log', String(this.checked));
        });

        // 防检测 toggle
        document.getElementById('v2-anti-detect').addEventListener('change', function () {
            saveSetting('v2_anti_detect', String(this.checked));
            if (this.checked) {
                try {
                    var msgEl = document.createElement('div');
                    msgEl.id = 'v2-anti-detect-tip';
                    msgEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
                        'background:rgba(0,0,0,0.85);color:#e6a23c;padding:12px 24px;border-radius:8px;' +
                        'font:14px/1.6 system-ui,sans-serif;z-index:2000000025;pointer-events:none;';
                    msgEl.textContent = '防检测已开启：点击验证码减速 + preview 对齐整10秒（每分钟≤6次，规避555限流）';
                    document.body.appendChild(msgEl);
                    setTimeout(function () { msgEl.remove(); }, 2500);
                } catch (e) {}
            } else {
                try {
                    var offEl = document.createElement('div');
                    offEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
                        'background:rgba(0,0,0,0.85);color:#909399;padding:12px 24px;border-radius:8px;' +
                        'font:14px/1.6 system-ui,sans-serif;z-index:2000000025;pointer-events:none;';
                    offEl.textContent = '防检测已关闭：恢复默认速度';
                    document.body.appendChild(offEl);
                    setTimeout(function () { offEl.remove(); }, 2500);
                } catch (e) {}
            }
        });

        // 详情弹窗关闭
        document.getElementById('v2-detail-close').addEventListener('click', function () {
            document.getElementById('v2-detail-overlay').style.display = 'none';
        });
        document.getElementById('v2-detail-overlay').addEventListener('click', function (e) {
            if (e.target === this) this.style.display = 'none';
        });

        // 预存帮助弹窗
        document.getElementById('v2-precache-help').addEventListener('click', function (e) {
            e.stopPropagation();
            document.getElementById('v2-help-overlay').style.display = 'flex';
        });
        document.getElementById('v2-help-close').addEventListener('click', function () {
            document.getElementById('v2-help-overlay').style.display = 'none';
        });
        document.getElementById('v2-help-overlay').addEventListener('click', function (e) {
            if (e.target === this) this.style.display = 'none';
        });

        // 主说明弹窗
        document.getElementById('v2-help-btn').addEventListener('click', function () {
            document.getElementById('v2-main-help-overlay').style.display = 'flex';
        });
        document.getElementById('v2-main-help-close').addEventListener('click', function () {
            document.getElementById('v2-main-help-overlay').style.display = 'none';
        });
        document.getElementById('v2-main-help-overlay').addEventListener('click', function (e) {
            if (e.target === this) this.style.display = 'none';
        });

        // 调剂弹窗
        document.getElementById('v2-alt-help').addEventListener('click', function () {
            renderAltList();
            document.getElementById('v2-alt-help-overlay').style.display = 'flex';
        });
        document.getElementById('v2-alt-help-close').addEventListener('click', function () {
            document.getElementById('v2-alt-help-overlay').style.display = 'none';
            // 关闭后刷新概览/套餐栏（用户可能改了勾选或排序）
            if (acceptAlternativeEnabled()) updateProductInfo();
        });
        document.getElementById('v2-alt-help-overlay').addEventListener('click', function (e) {
            if (e.target === this && e.target.id === 'v2-alt-help-overlay') {
                // 不自动关闭，只能点"知道了"关闭
            }
        });

        // 调剂重置按钮
        document.getElementById('v2-alt-reset-btn').addEventListener('click', function () {
            saveAlternativeOrder(ALT_DEFAULT_ORDER.map(function(item) {
                return { key: item.key, enabled: item.enabled };
            }));
            renderAltList();
            if (acceptAlternativeEnabled()) updateProductInfo();
        });

        // 调剂模式复选框：切换「单选套餐 / 多套餐概览」
        document.getElementById('v2-accept-alternative').addEventListener('change', function () {
            saveSetting('v2_accept_alternative', String(this.checked));
            applyAltModeVisibility();
            updateProductInfo();
        });

        // 控流复选框
        document.getElementById('v2-throttle').addEventListener('change', function () {
            saveSetting('v2_throttle', String(this.checked));
        });

        // 初始应用一次调剂模式显隐
        applyAltModeVisibility();

        // 刷新产品数据
        document.getElementById('v2-refresh-btn').addEventListener('click', async function () {
            // 锁定窗口内不允许手动刷新（按钮应已 disabled，此处兜底）
            if (isRefreshLocked()) {
                log('锁定', '锁定窗口内不可手动刷新（剩余 ' + refreshLockRemainingSec() + 's）');
                return;
            }
            setRefreshButtonState('loading');
            try {
                await requestBatchPreview({ source: '手动' });
            } catch (e) {
                log('产品', '刷新失败: ' + e.message);
            } finally {
                // 恢复按钮：仍在锁定窗口则保持 disabled，否则 normal
                setRefreshButtonState(isRefreshLocked() ? 'disabled' : 'normal');
            }
        });

        document.getElementById('v2-test-btn').addEventListener('click', async function () {
            this.disabled = true;
            this.textContent = '识别中...';
            try {
                log('测试', '弹出验证码...');
                var result = await getCaptchaTicket();
                log('测试', '验证码通过！ticket: ' + result.ticket.substring(0, 30) + '...');
            } catch (e) {
                log('测试', '失败: ' + e.message);
            } finally {
                this.disabled = false;
                this.textContent = '测试验证码';
            }
        });

        // 保存设置
        document.getElementById('v2-buy-time').addEventListener('change', function () {
            saveSetting('v2_buy_time', this.value);
        });
        document.querySelectorAll('input[name="v2-package"]').forEach(function (r) {
            r.addEventListener('change', function () {
                saveSetting('v2_package', this.value);
                updateProductInfo();
                clickPagePackageTab();
                highlightPackageTab();
                // 切换套餐后等待页面卡片更新再高亮
                setTimeout(highlightPackageCard, 500);
                updateSoldOutTags();
            });
        });
        document.querySelectorAll('input[name="v2-tier"]').forEach(function (r) {
            r.addEventListener('change', function () {
                saveSetting('v2_tier', this.value);
                updateProductInfo();
                highlightPackageCard();
                updateSoldOutTags();
            });
        });

        // 拖拽
        makeDraggable(panel);

        // 恢复位置（clamp 防止负值导致面板不可见）
        var savedPos = loadSetting('v2_panel_pos', null);
        if (savedPos) {
            try {
                var pos = JSON.parse(savedPos);
                var clamped = clampPanelPos(pos.left, pos.top, 280, 100);
                panel.style.left = clamped.left + 'px';
                panel.style.top = clamped.top + 'px';
                panel.style.right = 'auto';
            } catch (e) {}
        }

        updateProductInfo();
    }

    function updateProductInfo() {
        var el = document.getElementById('v2-product-info');

        // 调剂模式：套餐栏只显示概览摘要，明细见 #v2-alt-summary
        if (acceptAlternativeEnabled()) {
            var order = getAlternativeOrder();
            var enabled = 0, inStock = 0;
            for (var i = 0; i < order.length; i++) {
                if (!order[i].enabled) continue;
                enabled++;
                var pa = parseAltKey(order[i].key);
                var pp = PRODUCTS[pa.period] && PRODUCTS[pa.period][pa.tier];
                if (pp && !pp.confirmedSoldOut && !pp.soldOut) inStock++;
            }
            var lockedAlt = isRefreshLocked();
            var codeTagAlt = lockedAlt ? ' ·锁定' : (state.lastRefreshResult ? ' ·' + state.lastRefreshResult.code : '');
            if (el) {
                el.textContent = '调剂模式 ·' + enabled + '个(' + inStock + '有货)' + codeTagAlt;
                el.style.color = inStock > 0 ? '#67c23a' : '#e6a23c';
            }
            renderAltSummary();
            return;
        }

        var pkg = getSelectedPackageType();
        var tier = getSelectedTier();
        var product = PRODUCTS[pkg][tier];
        if (el && product) {
            var priceText = product.payAmount ? '¥' + product.payAmount : '¥' + product.price;
            // 锁定窗口内强制乐观认定非售罄；窗口外用 batch-preview 的 soldOut（仅展示）
            var locked = isRefreshLocked();
            var effSoldOut = locked ? false : product.soldOut;
            // 附带最近一次 batch-preview 真实返回码（窗口内显示「锁定」）
            var codeTag = locked ? ' ·锁定' : (state.lastRefreshResult ? ' ·' + state.lastRefreshResult.code : '');
            var showSoldOut = hasReachedBuyTime();
            var stockText = effSoldOut ? ' [售罄]' : ' [有货]';
            if (!showSoldOut && effSoldOut) {
                // 抢购开始前，不显示售罄字样，但颜色用橙色提示
                stockText = '';
                el.textContent = product.productId + ' ' + priceText + codeTag;
                el.style.color = '#e6a23c';
            } else {
                el.textContent = product.productId + ' ' + priceText + stockText + codeTag;
                el.style.color = effSoldOut ? '#f56c6c' : '#67c23a';
            }
        }
        updateSoldOutTags();
    }

    function hasReachedBuyTime() {
        var now = new Date(getServerTime());
        var t = parseBuyTime();
        // 向后取整到分钟：秒>0 则分钟+1
        var roundedMin = t.s > 0 ? t.m + 1 : t.m;
        var roundedH = roundedMin >= 60 ? t.h + 1 : t.h;
        if (roundedMin >= 60) roundedMin = 0;
        var target = new Date(now);
        target.setHours(roundedH, roundedMin, 0, 0);
        return now >= target;
    }

    function updateSoldOutTags() {
        var pkg = getSelectedPackageType();
        var tier = getSelectedTier();
        var showSoldOut = hasReachedBuyTime();
        // 月/季/年 大分类标签：该大分类下3个档位全部售罄才显示"罄"
        var periodKeys = ['month', 'quarter', 'year'];
        var periodIds = ['v2-pkg-month', 'v2-pkg-quarter', 'v2-pkg-year'];
        periodIds.forEach(function(id, i) {
            var label = document.querySelector('label[for="' + id + '"]');
            if (!label) return;
            var existing = label.querySelector('.v2-soldout-tag');
            var allTiersSoldOut = PRODUCTS[periodKeys[i]].lite.soldOut
                && PRODUCTS[periodKeys[i]].pro.soldOut
                && PRODUCTS[periodKeys[i]].max.soldOut;
            if (showSoldOut && allTiersSoldOut) {
                if (!existing) {
                    var span = document.createElement('span');
                    span.className = 'v2-soldout-tag';
                    span.textContent = '罄';
                    label.appendChild(span);
                }
            } else {
                if (existing) existing.remove();
            }
        });
        // Lite/Pro/Max 档位标签：在当前选中的大分类下，该档位售罄就显示"罄"
        var tierKeys = ['lite', 'pro', 'max'];
        var tierIds = ['v2-tier-lite', 'v2-tier-pro', 'v2-tier-max'];
        tierIds.forEach(function(id, i) {
            var label = document.querySelector('label[for="' + id + '"]');
            if (!label) return;
            var existing = label.querySelector('.v2-soldout-tag');
            if (showSoldOut && PRODUCTS[pkg][tierKeys[i]].soldOut) {
                if (!existing) {
                    var span = document.createElement('span');
                    span.className = 'v2-soldout-tag';
                    span.textContent = '罄';
                    label.appendChild(span);
                }
            } else {
                if (existing) existing.remove();
            }
        });
    }

    function updateAltHelpSoldOutTags() {
        var overlay = document.getElementById('v2-alt-help-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        var showSoldOut = hasReachedBuyTime();
        var items = overlay.querySelectorAll('.v2-alt-item');
        items.forEach(function(item) {
            var key = item.getAttribute('data-alt-key');
            var parts = parseAltKey(key);
            var product = PRODUCTS[parts.period] && PRODUCTS[parts.period][parts.tier];
            var tag = item.querySelector('.v2-alt-soldout');
            if (showSoldOut && product && product.soldOut) {
                if (!tag) {
                    tag = document.createElement('span');
                    tag.className = 'v2-alt-soldout';
                    tag.textContent = '售罄';
                    item.querySelector('.v2-alt-name').appendChild(tag);
                }
            } else {
                if (tag) tag.remove();
            }
        });
    }

    function renderAltList() {
        var container = document.getElementById('v2-alt-list');
        if (!container) return;
        var order = getAlternativeOrder();
        var html = '';
        for (var i = 0; i < order.length; i++) {
            var parts = parseAltKey(order[i].key);
            var product = PRODUCTS[parts.period] && PRODUCTS[parts.period][parts.tier];
            var name = product ? product.name : order[i].key;
            var price = product ? ('¥' + (product.payAmount || product.price)) : '';
            var soldOutHtml = (hasReachedBuyTime() && product && product.soldOut) ? '<span class="v2-alt-soldout">售罄</span>' : '';
            var checkedAttr = order[i].enabled ? ' checked' : '';
            html += '<div class="v2-alt-item" data-alt-key="' + order[i].key + '" data-alt-idx="' + i + '">' +
                '<span class="v2-alt-drag-handle" title="拖拽排序">⠿</span>' +
                '<input type="checkbox" class="v2-alt-checkbox"' + checkedAttr + ' data-alt-key="' + order[i].key + '" />' +
                '<span class="v2-alt-name">' + name + ' ' + price + soldOutHtml + '</span>' +
                '</div>';
        }
        container.innerHTML = html;

        // 绑定复选框事件
        container.querySelectorAll('.v2-alt-checkbox').forEach(function(cb) {
            cb.addEventListener('change', function() {
                var key = this.getAttribute('data-alt-key');
                var currentOrder = getAlternativeOrder();
                for (var j = 0; j < currentOrder.length; j++) {
                    if (currentOrder[j].key === key) {
                        currentOrder[j].enabled = this.checked;
                        break;
                    }
                }
                saveAlternativeOrder(currentOrder);
            });
        });

        // 绑定拖拽排序
        initAltListDrag(container);
    }

    function initAltListDrag(container) {
        var dragItem = null;
        var placeholder = null;
        var startY = 0;

        container.querySelectorAll('.v2-alt-drag-handle').forEach(function(handle) {
            handle.addEventListener('mousedown', function(e) {
                e.preventDefault();
                var item = handle.parentElement;
                dragItem = item;
                startY = e.clientY;

                // 创建占位符
                placeholder = document.createElement('div');
                placeholder.className = 'v2-alt-placeholder';
                placeholder.style.height = item.offsetHeight + 'px';
                item.parentNode.insertBefore(placeholder, item.nextSibling);
                item.classList.add('v2-alt-dragging');
                item.style.position = 'fixed';
                item.style.zIndex = '1000';
                item.style.width = item.offsetWidth + 'px';
                item.style.left = item.getBoundingClientRect().left + 'px';
                item.style.top = item.getBoundingClientRect().top + 'px';
            });
        });

        document.addEventListener('mousemove', function(e) {
            if (!dragItem || !placeholder) return;
            var dy = e.clientY - startY;
            var top = parseFloat(dragItem.style.top) + dy;
            dragItem.style.top = top + 'px';
            startY = e.clientY;

            // 检查占位符位置
            var items = container.querySelectorAll('.v2-alt-item:not(.v2-alt-dragging)');
            for (var i = 0; i < items.length; i++) {
                var rect = items[i].getBoundingClientRect();
                if (e.clientY < rect.top + rect.height / 2) {
                    placeholder.parentNode.insertBefore(placeholder, items[i]);
                    return;
                }
            }
            placeholder.parentNode.appendChild(placeholder);
        });

        document.addEventListener('mouseup', function() {
            if (!dragItem || !placeholder) return;
            dragItem.classList.remove('v2-alt-dragging');
            dragItem.style.position = '';
            dragItem.style.zIndex = '';
            dragItem.style.width = '';
            dragItem.style.left = '';
            dragItem.style.top = '';

            // 将拖拽项插入到占位符位置
            placeholder.parentNode.insertBefore(dragItem, placeholder);
            placeholder.remove();

            // 读取新的顺序并保存
            var newOrder = [];
            container.querySelectorAll('.v2-alt-item').forEach(function(item) {
                var key = item.getAttribute('data-alt-key');
                var cb = item.querySelector('.v2-alt-checkbox');
                newOrder.push({ key: key, enabled: cb ? cb.checked : true });
            });
            saveAlternativeOrder(newOrder);

            dragItem = null;
            placeholder = null;
        });
    }

    function updatePanelState(text, statusClass) {
        var dot = document.getElementById('v2-status-dot');
        var textEl = document.getElementById('v2-status-text');
        if (textEl) textEl.textContent = text;
        if (dot) {
            dot.className = 'v2-status-dot';
            if (statusClass) dot.classList.add('v2-' + statusClass);
        }
    }

    function resetStartButton() {
        var btn = document.getElementById('v2-start-btn');
        if (btn) {
            btn.textContent = '开始抢购';
            btn.className = 'v2-btn v2-btn-primary';
        }
    }

    function terminateScript(message) {
        state.running = false;
        clearTimeout(state.timer);
        stopConnectionPreheat();
        stopBatchPreviewPoll();
        stopRefreshLockout();
        setRefreshButtonState('normal');
        resetStartButton();
        updatePanelState(message, 'idle');
        log('终止', message);
    }

    function addSoldOutTokenRow(message) {
        var tbody = document.getElementById('v2-token-tbody');
        if (!tbody) return;
        // 移除空行提示
        var emptyRow = tbody.querySelector('.v2-token-empty');
        if (emptyRow) emptyRow.parentElement.remove();
        var row = document.createElement('tr');
        row.innerHTML = '<td colspan="6" style="text-align:center;padding:6px 4px;">' +
            '<span class="v2-tag v2-tag-warn" style="font-size:12px;padding:2px 8px;">' + message + '</span>' +
            '</td>';
        tbody.appendChild(row);
    }

    var logLines = [];
    function updateLog(msg) {
        logLines.push(new Date().toLocaleTimeString() + ' ' + msg);
        if (logLines.length > 50) logLines.shift();
        var el = document.getElementById('v2-log-area');
        if (el) {
            el.textContent = logLines.join('\n');
            el.scrollTop = el.scrollHeight;
        }
    }

    function clampPanelPos(left, top, elWidth, elHeight) {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var minVisible = 40;
        var w = elWidth || 280;
        var h = elHeight || 100;
        // 左侧至少 minVisible 可见：left >= -(w - minVisible)
        // 右侧至少 minVisible 可见：left <= vw - minVisible
        var clampedLeft = Math.max(-(w - minVisible), Math.min(left, vw - minVisible));
        var clampedTop = Math.max(-(h - minVisible), Math.min(top, vh - minVisible));
        return { left: clampedLeft, top: clampedTop };
    }

    function makeDraggable(el) {
        var isDragging = false;
        var startX, startY, elStartX, elStartY;

        el.addEventListener('mousedown', function (e) {
            if (['BUTTON', 'INPUT', 'LABEL', 'TEXTAREA'].indexOf(e.target.tagName) >= 0) return;
            // 详情弹窗内允许文本选择，不触发拖拽
            if (e.target.closest && e.target.closest('.v2-detail-overlay')) return;
            // 调剂弹窗内拖拽排序，不触发面板拖拽
            if (e.target.closest && e.target.closest('.v2-help-overlay')) return;
            isDragging = true;
            el.classList.add('v2-dragging');
            startX = e.clientX;
            startY = e.clientY;
            var rect = el.getBoundingClientRect();
            elStartX = rect.left;
            elStartY = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!isDragging) return;
            el.style.left = (elStartX + e.clientX - startX) + 'px';
            el.style.top = (elStartY + e.clientY - startY) + 'px';
            el.style.right = 'auto';
        });

        document.addEventListener('mouseup', function () {
            if (isDragging) {
                isDragging = false;
                el.classList.remove('v2-dragging');
                var rect = el.getBoundingClientRect();
                var clamped = clampPanelPos(rect.left, rect.top, rect.width, rect.height);
                el.style.left = clamped.left + 'px';
                el.style.top = clamped.top + 'px';
                saveSetting('v2_panel_pos', JSON.stringify(clamped));
            }
        });
    }

    // ==================== 样式 ====================
    function injectStyles() {
        var css = '' +
            '#v2-control-panel {' +
            '  position: fixed; top: 50px; right: 10px; z-index: 2000000022;' +
            '  background: rgba(0,0,0,0.88); color: #fff;' +
            '  padding: 10px 14px; border-radius: 8px;' +
            '  font: 13px/1.6 "SF Mono", Consolas, monospace;' +
            '  user-select: none; cursor: move;' +
            '  box-shadow: 0 2px 8px rgba(0,0,0,0.3);' +
            '  min-width: 340px; max-width: 420px;' +
            '}' +
            '#v2-control-panel.v2-dragging { opacity: 0.8; }' +
            '.v2-panel-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }' +
            '.v2-label { color: #ccc; font-size: 12px; width: 32px; flex-shrink: 0; }' +
            '.v2-radio-group { display: flex; gap: 2px; }' +
            '.v2-radio-group input { display: none; }' +
            '.v2-radio-group label {' +
            '  padding: 2px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;' +
            '  background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3);' +
            '  transition: all 0.15s;' +
            '}' +
            '.v2-radio-group input:checked + label {' +
            '  background: #409eff; border-color: #409eff; color: #fff;' +
            '}' +
            'input[name="v2-package"]:checked + label { background: #e6a23c; border-color: #e6a23c; }' +
            '#v2-buy-time {' +
            '  width: 90px; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 6px; font: 12px monospace;' +
            '}' +
            '.v2-status-dot {' +
            '  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;' +
            '  background: #909399;' +
            '}' +
            '.v2-status-dot.v2-running { background: #67c23a; animation: v2-pulse 1s infinite; }' +
            '.v2-status-dot.v2-waiting { background: #e6a23c; }' +
            '.v2-status-dot.v2-success { background: #67c23a; }' +
            '.v2-status-dot.v2-idle { background: #909399; }' +
            '@keyframes v2-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }' +
            '.v2-btn-row { margin-top: 8px; }' +
            '.v2-btn {' +
            '  cursor: pointer; color: #fff; border: none; border-radius: 4px;' +
            '  padding: 5px 14px; font: 12px monospace;' +
            '}' +
            '.v2-btn-primary { background: #409eff; }' +
            '.v2-btn-primary:hover { background: #66b1ff; }' +
            '.v2-btn-danger { background: #f56c6c; }' +
            '.v2-btn-danger:hover { background: #f78989; }' +
            '.v2-btn-secondary { background: #67c23a; }' +
            '.v2-btn-secondary:hover { background: #85ce61; }' +
            '.v2-btn:disabled { background: #909399; cursor: not-allowed; }' +
            '.v2-btn-mini {' +
            '  cursor: pointer; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 10px; font-size: 12px; margin-left: 4px;' +
            '}' +
            '.v2-btn-mini:hover { background: rgba(255,255,255,0.25); }' +
            '.v2-btn-mini:disabled { opacity: 0.5; cursor: not-allowed; }' +
            '.v2-stepper { display: flex; align-items: center; gap: 0; }' +
            '.v2-stepper-btn {' +
            '  width: 22px; height: 22px; border: 1px solid rgba(255,255,255,0.3);' +
            '  background: rgba(255,255,255,0.15); color: #fff; font-size: 14px;' +
            '  cursor: pointer; display: flex; align-items: center; justify-content: center;' +
            '  line-height: 1; padding: 0;' +
            '}' +
            '.v2-stepper-btn:first-child { border-radius: 4px 0 0 4px; }' +
            '.v2-stepper-btn:last-child { border-radius: 0 4px 4px 0; }' +
            '.v2-stepper-btn:hover { background: rgba(255,255,255,0.3); }' +
            '.v2-stepper-val {' +
            '  width: 28px; height: 22px; border-top: 1px solid rgba(255,255,255,0.3);' +
            '  border-bottom: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.3);' +
            '  color: #fff; font-size: 12px; text-align: center; line-height: 22px;' +
            '}' +
            '.v2-num-input {' +
            '  width: 40px; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 4px; font: 12px monospace; text-align: center;' +
            '}' +
            '.v2-hint { color: #999; font-size: 11px; }' +
            '.v2-help-btn {' +
            '  display: inline-flex; align-items: center; justify-content: center;' +
            '  width: 14px; height: 14px; border-radius: 50%;' +
            '  background: rgba(255,255,255,0.2); color: #fff; font-size: 10px;' +
            '  border: 1px solid rgba(255,255,255,0.3); cursor: pointer;' +
            '  margin-left: 4px; padding: 0; line-height: 1; vertical-align: middle;' +
            '}' +
            '.v2-help-btn:hover { background: #409eff; border-color: #409eff; }' +
            '.v2-help-overlay {' +
            '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;' +
            '  z-index: 2000000024; display: flex; align-items: center; justify-content: center;' +
            '  background: rgba(0,0,0,0.5);' +
            '}' +
            '.v2-help-box {' +
            '  background: #fff; color: #333; border-radius: 12px;' +
            '  max-width: 480px; width: 90%; max-height: 80vh; overflow-y: auto; padding: 24px 32px;' +
            '  box-shadow: 0 4px 20px rgba(0,0,0,0.3);' +
            '}' +
            '.v2-help-box h3 { margin: 0 0 16px 0; font-size: 18px; color: #409eff; border-bottom: 1px solid #eee; padding-bottom: 12px; }' +
            '.v2-help-box p { margin: 6px 0; font-size: 13px; line-height: 1.8; color: #333; }' +
            '.v2-help-box .v2-help-highlight { color: #e6a23c; font-weight: bold; }' +
            '.v2-help-box .v2-help-step { color: #67c23a; font-weight: bold; }' +
            '.v2-help-close {' +
            '  margin-top: 20px; cursor: pointer; background: #409eff; color: #fff;' +
            '  border: none; border-radius: 6px; padding: 8px 32px; font-size: 14px;' +
            '}' +
            '.v2-help-close:hover { background: #66b1ff; }' +
            '.v2-help-item {' +
            '  margin-bottom: 16px; padding-left: 24px; position: relative;' +
            '  font-size: 14px; line-height: 1.8; color: #333;' +
            '}' +
            '.v2-help-num {' +
            '  position: absolute; left: 0; color: #409eff; font-weight: bold;' +
            '}' +
            '.v2-bizid-input {' +
            '  flex: 1; min-width: 0; background: rgba(255,255,255,0.15); color: #fff;' +
            '  border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;' +
            '  padding: 2px 6px; font: 11px monospace;' +
            '}' +
            '.v2-bizid-input::placeholder { color: rgba(255,255,255,0.4); }' +
            '.v2-product-info { color: #67c23a; font-size: 11px; }' +
            '.v2-log-area {' +
            '  margin-top: 8px; max-height: 120px; overflow-y: auto;' +
            '  background: rgba(0,0,0,0.3); border-radius: 4px; padding: 6px 8px;' +
            '  font-size: 10px; color: #ccc; white-space: pre-wrap; word-break: break-all;' +
            '}' +
            '.v2-log-area::-webkit-scrollbar { width: 4px; }' +
            '.v2-log-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }' +
            '.v2-log-hidden { display: none; }' +
            '.v2-separator { border-top: 1px solid rgba(255,255,255,0.15); margin: 6px 0; }' +
            '.v2-precache-row { gap: 4px !important; }' +
            '.v2-token-count { font-size: 12px; color: #e6a23c; min-width: 30px; text-align: center; }' +
            '.v2-token-table {' +
            '  width: 100%; border-collapse: collapse; margin: 4px 0;' +
            '  font-size: 10px; color: #ccc;' +
            '  display: block;' +
            '}' +
            '.v2-token-table thead { display: table; width: 100%; table-layout: fixed; }' +
            '.v2-token-table tbody {' +
            '  display: block; max-height: 220px; overflow-y: auto; width: 100%;' +
            '}' +
            '.v2-token-table thead tr, .v2-token-table tbody tr { display: table; width: 100%; table-layout: fixed; }' +
            '.v2-token-table tbody::-webkit-scrollbar { width: 3px; }' +
            '.v2-token-table tbody::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }' +
            '.v2-token-table th {' +
            '  text-align: left; padding: 2px 4px; color: #999; font-weight: normal;' +
            '  border-bottom: 1px solid rgba(255,255,255,0.15);' +
            '}' +
            '.v2-token-table td { padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
            '.v2-token-table tr:hover { background: rgba(255,255,255,0.08); }' +
            '.v2-token-expired td { color: #666; text-decoration: line-through; }' +
            '.v2-token-empty { color: #666; font-style: italic; text-align: center; }' +
            '.v2-refresh-table tbody { max-height: 160px; }' +
            '.v2-refresh-loading { opacity: 0.6; cursor: wait; }' +
            '#v2-refresh-btn:disabled { opacity: 0.55; cursor: not-allowed; }' +
            '.v2-tabs { display: flex; gap: 4px; margin: 6px 0 2px; }' +
            '.v2-tab { flex: 1; padding: 3px 6px; font-size: 11px; color: #bbb; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; cursor: pointer; }' +
            '.v2-tab:hover { color: #ddd; }' +
            '.v2-tab.v2-tab-active { color: #fff; background: rgba(64,158,255,0.25); border-color: #409eff; }' +
            '.v2-alt-summary-box { margin: 2px 0; font-size: 11px; }' +
            '.v2-alt-sum-header { color: #bbb; padding: 2px 0 4px; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 4px; }' +
            '.v2-alt-sum-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }' +
            '.v2-alt-sum-idx { width: 14px; color: #888; font-size: 10px; }' +
            '.v2-alt-sum-name { flex: 1; color: #ddd; }' +
            '.v2-alt-sum-price { color: #e6a23c; font-size: 10px; }' +
            '.v2-tag {' +
            '  display: inline-block; padding: 0 4px; border-radius: 2px; font-size: 9px;' +
            '}' +
            '.v2-tag-ok { background: rgba(103,194,58,0.2); color: #67c23a; }' +
            '.v2-tag-warn { background: rgba(230,162,60,0.2); color: #e6a23c; }' +
            '.v2-tag-err { background: rgba(245,108,108,0.2); color: #f56c6c; }' +
            '.v2-tag-sending { background: rgba(64,158,255,0.2); color: #409eff; }' +
            '.v2-checkbox-label {' +
            '  display: flex; align-items: center; gap: 4px; cursor: pointer;' +
            '  font-size: 12px; color: #ccc;' +
            '}' +
            '.v2-checkbox-label input { margin: 0; }' +
            '.v2-detail-overlay {' +
            '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;' +
            '  z-index: 2000000023; display: flex; align-items: center; justify-content: center;' +
            '  background: rgba(0,0,0,0.5);' +
            '}' +
            '.v2-detail-box {' +
            '  background: #fff; color: #333; border-radius: 12px;' +
            '  max-width: 500px; width: 90%; max-height: 60vh; overflow: hidden;' +
            '  box-shadow: 0 4px 20px rgba(0,0,0,0.3);' +
            '  user-select: text; -webkit-user-select: text;' +
            '}' +
            '.v2-detail-header {' +
            '  display: flex; justify-content: space-between; align-items: center;' +
            '  padding: 12px 16px; border-bottom: 1px solid #eee;' +
            '  font-size: 14px; font-weight: bold; color: #333;' +
            '}' +
            '.v2-detail-header button {' +
            '  background: none; border: none; color: #999; font-size: 18px; cursor: pointer;' +
            '}' +
            '.v2-detail-body {' +
            '  padding: 16px; overflow-y: auto; max-height: 50vh; margin: 0;' +
            '  font-size: 12px; white-space: pre-wrap; word-break: break-all;' +
            '  color: #333; background: none;' +
            '}' +
            /* 套餐卡片高亮 */
            '.package-card-box.auto-buy-selected {' +
            '  border: 3px solid #e6a23c !important;' +
            '  box-shadow: 0 0 12px rgba(230, 162, 60, 0.5) !important;' +
            '}' +
            '.switch-tab-item.auto-buy-pkg-selected {' +
            '  border: 2px solid #e6a23c !important;' +
            '  box-shadow: 0 0 8px rgba(230, 162, 60, 0.5) !important;' +
            '  border-radius: 6px;' +
            '}' +
            '.v2-soldout-tag {' +
            '  display: inline-flex; align-items: center; justify-content: center;' +
            '  background: #f56c6c;' +
            '  color: #fff;' +
            '  font-size: 9px; font-weight: bold;' +
            '  width: 16px; height: 16px;' +
            '  border-radius: 50%;' +
            '  margin-left: 3px;' +
            '  vertical-align: middle;' +
            '  line-height: 1;' +
            '}' +
            '.v2-alt-list {' +
            '  margin-top: 12px;' +
            '  border: 1px solid #eee;' +
            '  border-radius: 6px;' +
            '  overflow: hidden;' +
            '}' +
            '.v2-alt-item {' +
            '  display: flex; align-items: center; gap: 8px;' +
            '  padding: 8px 12px; background: #fff;' +
            '  border-bottom: 1px solid #f0f0f0;' +
            '  font-size: 13px; color: #333;' +
            '  cursor: default;' +
            '}' +
            '.v2-alt-item:last-child { border-bottom: none; }' +
            '.v2-alt-drag-handle {' +
            '  cursor: grab; color: #bbb; font-size: 14px;' +
            '  user-select: none; padding: 0 4px;' +
            '}' +
            '.v2-alt-drag-handle:hover { color: #409eff; }' +
            '.v2-alt-checkbox { margin: 0; cursor: pointer; }' +
            '.v2-alt-name { flex: 1; }' +
            '.v2-alt-soldout {' +
            '  display: inline-block;' +
            '  background: rgba(245,108,108,0.15);' +
            '  color: #f56c6c; font-size: 11px;' +
            '  padding: 1px 6px; border-radius: 3px;' +
            '  margin-left: 6px;' +
            '}' +
            '.v2-alt-item.v2-alt-dragging {' +
            '  opacity: 0.8; box-shadow: 0 2px 8px rgba(0,0,0,0.2);' +
            '  background: #f5f7fa;' +
            '}' +
            '.v2-alt-placeholder {' +
            '  background: rgba(64,158,255,0.08);' +
            '  border: 2px dashed #409eff;' +
            '  border-radius: 4px;' +
            '}';

        if (typeof GM_addStyle !== 'undefined') {
            GM_addStyle(css);
        } else {
            var style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    // ==================== 页面套餐高亮 ====================
    // 点击页面上对应的套餐 tab（月/季/年）
    // optProduct：可选，传入后会按该产品所属周期点击页面 tab（调剂模式用）
    function clickPagePackageTab(optProduct) {
        var pkgType = (optProduct ? findProductUnit(optProduct) : null) || getSelectedPackageType();
        var tabIndex;
        switch (pkgType) {
            case 'month':   tabIndex = 0; break;
            case 'quarter': tabIndex = 1; break;
            case 'year':    tabIndex = 2; break;
            default:        tabIndex = 1;
        }
        var tabItems = document.querySelectorAll('.switch-tab-box .switch-tab-item');
        if (tabItems.length > tabIndex) {
            var targetTab = tabItems[tabIndex];
            if (targetTab && !targetTab.classList.contains('active')) {
                targetTab.click();
            }
        }
    }

    // 高亮页面上当前选择的档位卡片（Lite=0, Pro=1, Max=2）
    function highlightPackageCard() {
        var tier = getSelectedTier();
        var idx;
        switch (tier) {
            case 'lite': idx = 0; break;
            case 'pro':  idx = 1; break;
            case 'max':  idx = 2; break;
            default:     idx = 2;
        }
        var cards = document.querySelectorAll('.package-card-box');
        cards.forEach(function (card, i) {
            if (i === idx) {
                card.classList.add('auto-buy-selected');
            } else {
                card.classList.remove('auto-buy-selected');
            }
        });
    }

    // 高亮页面上当前选择的套餐 tab
    function highlightPackageTab() {
        var pkgType = getSelectedPackageType();
        var tabIndex;
        switch (pkgType) {
            case 'month':   tabIndex = 0; break;
            case 'quarter': tabIndex = 1; break;
            case 'year':    tabIndex = 2; break;
            default:        tabIndex = 1;
        }
        var tabItems = document.querySelectorAll('.switch-tab-box .switch-tab-item');
        tabItems.forEach(function (item, i) {
            if (i === tabIndex) {
                item.classList.add('auto-buy-pkg-selected');
            } else {
                item.classList.remove('auto-buy-pkg-selected');
            }
        });
    }

    // ==================== 激活页面购买按钮 ====================
    // 修改 Vue 组件的产品数据，让页面上所有"已售罄"的按钮变为可点击
    function activatePageButtons() {
        function tryActivate() {
            var claudeBox = document.querySelector('.claude-code-box');
            var vue = claudeBox && claudeBox.__vue__;
            if (!vue || !Array.isArray(vue.allCardDataList) || vue.allCardDataList.length === 0) {
                setTimeout(tryActivate, 300);
                return;
            }
            vue.allCardDataList.forEach(function (item) {
                item.soldOut = false;
                item.canPurchase = true;
                item.disabled = false;
            });
            win.vueApp = vue;
            log('页面', '已激活所有购买按钮（soldOut=false）');

            // 初始化高亮
            highlightPackageCard();
            clickPagePackageTab();
            highlightPackageTab();
            // 点击tab后等待卡片更新再高亮一次
            setTimeout(highlightPackageCard, 600);
        }
        setTimeout(tryActivate, 500);
    }

    // v3：探测本地 /health。后端能转发即可（有无代理不影响）；仅后端真不具备转发能力才终止
    async function checkProxyHealth() {
        if (!state.proxyEnabled) {
            state.proxyReady = false;
            updateProxyStatusUI();
            return;
        }
        try {
            var resp = await new Promise(function (resolve, reject) {
                GM_xmlhttpRequest({
                    method: 'GET', url: CONFIG.PROXY_HEALTH_URL, timeout: 3000,
                    onload: function (r) { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
                    onerror: function () { reject(new Error('OCR 服务不可达')); },
                    ontimeout: function () { reject(new Error('OCR 服务超时')); }
                });
            });
            var pi = resp.proxy || {};
            state.proxyReady = !!pi.ready;              // 后端能转发 /proxy
            state.proxyHasProxies = !!pi.has_proxies;   // 是否有实际代理（无则后端直连转发）
            updateProxyStatusUI();
            if (!state.proxyReady) {
                terminateScript(
                    '本地服务不具备代理转发能力（未装 curl-cffi/httpx 或服务异常），脚本启动失败。\n' +
                    '请：pip install -r captcha/requirements.txt 并重启 ddddocr_server.py'
                );
            } else {
                if (state.proxyHasProxies) {
                    log('代理', '就绪：' + (pi.healthy || 0) + ' 个代理，后端 ' + (pi.backend || '?'));
                } else {
                    log('代理', '后端就绪但未配置代理——请求经后端直连转发（填 proxies.txt + 重启即启用代理）');
                }
                setupProxyInterceptor();
            }
        } catch (e) {
            state.proxyReady = false;
            updateProxyStatusUI();
            terminateScript('无法连接本地 OCR 服务（' + e.message + '），脚本启动失败。\n请先启动 captcha/ddddocr_server.py');
        }
    }

    function updateProxyStatusUI() {
        var el = document.getElementById('v3-proxy-status');
        if (!el) return;
        if (!state.proxyEnabled) el.textContent = '';
        else if (!state.proxyReady) el.textContent = '✗后端不可用';
        else if (state.proxyHasProxies) {
            var ipInfo = state.lastProxyIp ? (' [' + state.lastProxyIp + ']') : '';
            el.textContent = '✓代理就绪' + ipInfo;
        }
        else el.textContent = '⚠直连(无代理)';
    }

    // ==================== 初始化 ====================
    async function init() {
        if (inCaptchaFrame) return;
        injectStyles();
        createControlPanel();

        // v3：读取代理开关 + 探测后端 /health（仅当后端不具备转发能力时才 terminateScript）
        state.proxyEnabled = isProxyEnabled();
        syncLastProxyIp();
        await checkProxyHealth();

        log('初始化', 'v3 代理池模式启动');

        // 服务器时间同步
        syncServerTime();

        // 加载验证码SDK（重试3次）
        var sdkLoaded = false;
        for (var sdkRetry = 0; sdkRetry < 3; sdkRetry++) {
            try {
                await loadCaptchaScript();
                log('初始化', '腾讯验证码SDK已加载');
                sdkLoaded = true;
                break;
            } catch (e) {
                log('初始化', '验证码SDK加载失败(第' + (sdkRetry + 1) + '次): ' + e.message);
                if (sdkRetry < 2) await sleep(2000);
            }
        }
        if (!sdkLoaded) {
            log('初始化', '验证码SDK多次加载失败，将在抢购时继续尝试');
        }

        // 并行：获取用户信息 + 产品价格 + 检测OCR
        var initTasks = [];

        // 获取用户信息
        initTasks.push(
            fetchCustomerInfo().then(function (resp) {
                if (resp.code === 200 && resp.data) {
                    state.userInfo = resp.data;
                    state.customerNumber = resp.data.customerNumber;
                    state.customerName = resp.data.customerName;
                    log('初始化', '用户: ' + resp.data.customerName + ' (' + resp.data.customerNumber + ')');
                }
            }).catch(function (e) {
                log('初始化', '获取用户信息失败: ' + e.message);
            })
        );

        // 调用 batch-preview 获取最新产品价格和库存
        initTasks.push(
            requestBatchPreview().catch(function (e) {
                log('产品', 'batch-preview 失败: ' + e.message);
            })
        );

        await Promise.all(initTasks);

        // 检测本地OCR
        checkLocalOcrService();

        // 激活页面按钮（参考v1：把Vue组件中所有产品的 soldOut/disabled 修改为可购买状态）
        activatePageButtons();

        // 启动 token 显示刷新
        startTokenDisplayRefresh();

        // 注：batch-preview 定期轮询仅在「开始抢购」后启动（start 处理器调用 startBatchPreviewPoll），
        // 非抢购期间不自动轮询，避免空闲期持续请求 batch-preview。

        log('初始化', '就绪，点击「开始抢购」启动');
    }

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    win.win2 = window;
})(unsafeWindow);
