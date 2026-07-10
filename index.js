// ==UserScript==
// @name         GLM抢号
// @namespace    05info
// @author       Spanky
// @version      2.0.1
// @match        https://*.bigmodel.cn/glm-coding*
// @match        https://*.gtimg.com/*
// @match        https://*.captcha.qcloud.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      turing.captcha.qcloud.com
// @connect      127.0.0.1:9898
// @connect      127.0.0.1
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
        function log(msg) { console.log('%c[CaptchaSolver] ' + msg, 'color:#58a6ff'); }

        function fetchImage(url) {
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
            var cx = rect.left + x * scaleX;
            var cy = rect.top + y * scaleY;
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
                await sleep(150);
            }

            await sleep(300);
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

    // document.querySelector('[view-name=CheckBox]')
    win.$ = $;

    function getQueryString(name) {
        var reg = new RegExp("(^|&)" + name + "=([^&]*)(&|$)", "i");
        var r = window.location.search.substr(1).match(reg);
        if (r != null) return decodeURI(r[2]);
        return null;
    }

    function getQueryObject(queryString) {
      var query = {};
      if (queryString) {
        const params = queryString.replace(/^\?/, '').split("&");
        for (let param of params) {
          const [key, value] = param.split("=");
          query[key] = decodeURIComponent(value);
        }
      }
      return query;
    }

    function getQueryString2(url, name) {
        var reg = new RegExp("(^|&)" + name + "=([^&]*)(&|$)", "i");
        var r = new URL(url).search.substr(1).match(reg);
        if (r != null) return decodeURI(r[2]);
        return null;
    }

    win.getQueryString = getQueryString;
    win.getQueryString2 = getQueryString2;
    win.getQueryObject = getQueryObject;





// ==================== API 响应拦截 ====================
// 直接拦截 /biz/pay/preview 的 XHR 响应，比读 Vue 响应式状态可靠得多
// Vue 中 isSoldOut 默认值是 true，API 响应前不可靠
var lastPreviewResult = null;
var retryingPreview = false;

// ── 测试模式 ──
// 设为 0 关闭测试；设为 N>0 则前 N 次按序返回：555繁忙 → 200售罄 → 200成功
// 之后恢复正常。推荐值 3。
var TEST_PREVIEW_COUNT = 0;

// ── 555 繁忙自动重试 ──
// 验证码通过后 API 返回 555 时，直接重发请求（验证码 token 仍有效）
// 设为 0 关闭；设为 N 则最多重试 N 次，全部失败才提示繁忙
var RETRY_ON_BUSY = 0;
var RETRY_INTERVAL = 300; // 重试间隔(ms)

// ── 预解题状态 ──
var captchaPreSolved = false;       // 验证码汉字已点选，未确认
var captchaPreOpenAttempted = false; // 已尝试提前点击购买按钮
// preview 成功后直接调 create-sign，跳过 pay-middle-page 延迟
var autoLockEnabled = false;
var lockOrderInProgress = false;
var lockOrderDone = false;

function setupAPIInterceptor() {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    // 获取 XHR 原型上的原始 getter（用于读取真实响应，绕过我们的覆盖）
    var protoGetResponseText, protoGetResponse;
    try {
        protoGetResponseText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;
        protoGetResponse = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get;
    } catch (e) {
        console.warn('[拦截] 无法获取 XHR 原型 getter');
    }

    XMLHttpRequest.prototype.open = function(method, url) {
        this._autoBuyUrl = (typeof url === 'string') ? url : '';
        return origOpen.apply(this, arguments);
    };

    // 捕获请求头，供重试时复用
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (!this._autoBuyHeaders) this._autoBuyHeaders = {};
        this._autoBuyHeaders[name] = value;
        return origSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        if (this._autoBuyUrl.indexOf('/biz/pay/preview') !== -1 && !this._autoBuyRetry) {
            var xhr = this;
            var requestBody = body;
            var testOverrideText = null;  // 测试模式假响应
            var vueModifiedText = null;   // 缓存：555→1505 转换后的响应

            // ── 随机请求指纹 ──
            try {
                xhr.setRequestHeader('X-Request-Id', Math.random().toString(36).slice(2, 15));
                xhr.setRequestHeader('X-Timestamp', String(Date.now()));
                var _q = (0.5 + Math.random() * 0.5).toFixed(1);
                xhr.setRequestHeader('Accept-Language', 'zh-CN,zh;q=' + _q + ',en;q=' + (_q * 0.7).toFixed(1));
            } catch(e) {}

            // ── 测试模式：生成假响应 ──
            if (TEST_PREVIEW_COUNT > 0) {
                if (typeof window.__testPreviewSeq === 'undefined') window.__testPreviewSeq = 0;
                window.__testPreviewSeq++;

                if (window.__testPreviewSeq <= TEST_PREVIEW_COUNT) {
                    switch (window.__testPreviewSeq) {
                        case 1:
                            testOverrideText = JSON.stringify({code: 555, msg: "繁忙", success: false});
                            break;
                        case 2:
                            testOverrideText = JSON.stringify({code: 200, msg: "操作成功", success: true, data: {soldOut: true}});
                            break;
                        default:
                            testOverrideText = JSON.stringify({
                                code: 200, msg: "操作成功", success: true,
                                data: {
                                    productId: "product-5d3a03", soldOut: false,
                                    originalAmount: 1407, payAmount: 1266.3,
                                    thirdPartyAmount: 1266.3, bizId: "TEST" + Date.now(),
                                    renewAmount: 1266.3
                                }
                            });
                    }
                    console.log('[测试] 第' + window.__testPreviewSeq + '次 → ' +
                        (window.__testPreviewSeq === 1 ? '555 繁忙' :
                         window.__testPreviewSeq === 2 ? '200 售罄' : '200 成功'));
                }
            }

            // ── 覆盖 responseText / response ──
            // 将 555 响应转为 code 1505（axios 白名单 [200,1505,1005]）
            // Vue 的 payPreviewFn 对 1505 不做任何处理，从而阻止繁忙弹窗出现
            if (protoGetResponseText && protoGetResponse) {
                try {
                    Object.defineProperty(xhr, 'responseText', {
                        get: function() {
                            if (vueModifiedText !== null) return vueModifiedText;
                            var raw = testOverrideText !== null ? testOverrideText : protoGetResponseText.call(xhr);
                            try {
                                if (JSON.parse(raw).code === 555) {
                                    vueModifiedText = JSON.stringify({code: 1505, msg: '', success: false});
                                    return vueModifiedText;
                                }
                            } catch (e) {}
                            return raw;
                        }
                    });
                    Object.defineProperty(xhr, 'response', {
                        get: function() {
                            if (vueModifiedText !== null) return vueModifiedText;
                            var raw = testOverrideText !== null ? testOverrideText : protoGetResponse.call(xhr);
                            try {
                                if (JSON.parse(raw).code === 555) {
                                    vueModifiedText = JSON.stringify({code: 1505, msg: '', success: false});
                                    return vueModifiedText;
                                }
                            } catch (e) {}
                            return raw;
                        }
                    });
                } catch (e) {
                    console.warn('[拦截] 无法覆盖 responseText:', e);
                }
            }

            // ── load 事件：读取真实响应用于自身逻辑 ──
            xhr.addEventListener('load', function() {
                try {
                    var resp;
                    if (testOverrideText !== null) {
                        resp = JSON.parse(testOverrideText);
                    } else if (protoGetResponseText) {
                        resp = JSON.parse(protoGetResponseText.call(xhr));
                    } else {
                        resp = JSON.parse(xhr.responseText);
                    }

                    // 555 繁忙 → 自动重发请求（验证码 token 仍有效，无需重新识别）
                    if (resp.code === 555 && RETRY_ON_BUSY > 0 && testOverrideText === null) {
                        console.log('[拦截] 555繁忙，启动自动重试 (最多' + RETRY_ON_BUSY + '次)');
                        retryingPreview = true;
                        retryPreview(requestBody, xhr._autoBuyHeaders, RETRY_ON_BUSY);
                        return;
                    }

                    lastPreviewResult = resp;

                    handlePreviewResponse(resp);
                } catch (e) {
                    console.warn('[拦截] 解析响应失败:', e);
                }
            });
        }
        return origSend.apply(this, arguments);
    };
    console.log('[拦截] /biz/pay/preview 拦截器已安装' +
        (TEST_PREVIEW_COUNT > 0 ? ' (测试: 555繁忙 → 200售罄 → 200成功)' : '') +
        (RETRY_ON_BUSY > 0 ? ' (555重试: ' + RETRY_ON_BUSY + '次)' : ''));
}

// 555 繁忙时自动重发请求
function retryPreview(requestBody, headers, maxRetries) {
    (async function() {
        for (var i = 0; i < maxRetries; i++) {
            await sleep(RETRY_INTERVAL);
            vueApp.$message('[爆破] 第' + (i + 1) + '/' + maxRetries + '次...');

            try {
                var result = await sendPreviewRequest(requestBody, headers);
                console.log('[重试] 响应: code=' + result.code +
                    (result.data ? (result.data.soldOut ? ' 售罄' : ' 有货!') : ''));

                if (result.code === 200 && result.data) {
                    if (!result.data.soldOut) {
                        // 重试成功！手动触发 Vue 支付流程
                        lastPreviewResult = result;
                        var payRef = win.vueApp?.$refs?.payComponentRef;
                        if (payRef) {
                            payRef.isServerBusy = false;
                            payRef.isSoldOut = false;
                            payRef.captchaVerified = true;
                            setTimeout(function() { payRef.priceData = result.data; }, 100);
                            try { payRef.getPayStatusFn(); } catch(e) {}
                        }
                        console.log('[重试] 抢购成功！');
                        retryingPreview = false;
                        return;
                    } else {
                        // 售罄
                        lastPreviewResult = result;
                        handlePreviewResponse(result);
                        retryingPreview = false;
                        return;
                    }
                }
                // 555 → 继续重试（验证码 token 可能仍有效）
            } catch (e) {
                // 405 / 非 JSON / 网络错误 → 服务器拒绝，验证码已失效，立即放弃重试
                console.warn('[重试] 服务器拒绝 (HTTP ' + (e.status || '?') + ')，停止重试，重新输入验证码');
                break;
            }
        }

        // 全部重试失败或被拒绝
        console.log('[重试] 结束，交给 autoPay 重新购买');
        lastPreviewResult = {code: 555, msg: '繁忙', success: false};
        handlePreviewResponse(lastPreviewResult);
        retryingPreview = false;
    })();
}

// 发送 /biz/pay/preview 请求（不经过拦截器）
function sendPreviewRequest(body, headers) {
    return new Promise(function(resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr._autoBuyRetry = true; // 标记为重试，跳过拦截器
        xhr.open('POST', '/api/biz/pay/preview');
        if (headers) {
            for (var name in headers) {
                try { xhr.setRequestHeader(name, headers[name]); } catch(e) {}
            }
        }
        // 随机请求指纹 — 每次请求看起来不同，降低被识别为脚本的概率
        try {
            xhr.setRequestHeader('X-Request-Id', Math.random().toString(36).slice(2, 15));
            xhr.setRequestHeader('X-Timestamp', String(Date.now()));
            var _q = (0.5 + Math.random() * 0.5).toFixed(1);
            xhr.setRequestHeader('Accept-Language', 'zh-CN,zh;q=' + _q + ',en;q=' + (_q * 0.7).toFixed(1));
        } catch(e) {}
        xhr.onload = function() {
            // HTTP 非 200（如 405）→ 服务器拒绝，验证码已失效
            if (xhr.status !== 200) {
                reject({status: xhr.status, msg: 'HTTP ' + xhr.status});
                return;
            }
            try {
                let rpd = JSON.parse(xhr.responseText);
                resolve(rpd);
            } catch(e) {
                // 非 JSON 响应（HTML 错误页）→ 同样视为拒绝
                reject({status: xhr.status, msg: '非JSON响应'});
            }
        };
        xhr.onerror = function() { reject({status: 0, msg: 'network error'}); };
        xhr.send(body);
    });
}

function handlePreviewResponse(resp) {
    var payRef = win.vueApp?.$refs?.payComponentRef;
    if (resp.code === 555) {
        // 繁忙：responseText 已被转为 code 1505，Vue 不会弹出繁忙弹窗
        // 此处同步关闭弹窗（XHR load 事件先于 axios microtask）
        if (payRef) {
            payRef.payDialogVisible = false;
            payRef.captchaVerified = false;
            payRef.isServerBusy = false;
        }
        win.vueApp?.$message({ message: '抢购人数太多,继续抢购...', type: 'warning', duration: 1500 });
    } else if (resp.code === 500) {
        // 服务端500：重置验证码状态，允许重新弹出验证码
        if (payRef) {
            payRef.payDialogVisible = false;
            payRef.captchaVerified = false;
            payRef.isServerBusy = false;
        }
        win.vueApp?.$message({ message: '服务器错误(500)，继续抢购...', type: 'warning', duration: 1500 });
    } else if (resp.code === 200 && resp.data && resp.data.soldOut) {
        // 售罄：Vue 已自动关闭弹窗并弹出 warning
        win.vueApp?.$message({ message: '已售罄，继续抢购...', type: 'warning', duration: 1500 });
    }
    // 成功（code 200, !soldOut）：不干预，让 Vue 正常弹出支付弹窗
}

// ==================== 配置 ====================
// BUY_TIME 改为从面板输入框读取，此变量仅作默认值
var BUY_TIME_DEFAULT = '09:59:59';
// 抢购按钮选择：0=第一个(Lite), 1=第二个(Pro), 2=第三个(Max)
var buyBtnIndex = 2;
// 套餐类型：'month'=月, 'quarter'=季, 'year'=年
var PACKAGE_TYPE_DEFAULT = 'quarter';

// ── 验证码识别：仅支持本地 ddddocr HTTP 服务（~100ms） ──

var DDDDOCR_URL = 'http://127.0.0.1:9898/click';

var CAPTCHA_MAX_RETRY = 3;

// ── 服务器时间同步 ──
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
            console.warn('[时间同步] 采样失败:', e.message);
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
    var direction = offset > 0 ? '服务器快' : '本机快';
    console.log('[时间同步] offset=' + offset.toFixed(0) + 'ms (' + direction + Math.abs(offset).toFixed(0) + 'ms)');
    // 面板上永久显示偏移量
    var offsetEl = document.getElementById('auto-buy-offset');
    if (offsetEl) {
        offsetEl.textContent = (offset > 0 ? '+' : '') + (offset / 1000).toFixed(2) + 's';
        offsetEl.title = '时钟偏移: ' + direction + Math.abs(offset).toFixed(0) + 'ms';
    }
    win.vueApp?.$message({
        message: '时钟偏移: ' + (offset > 0 ? '+' : '') + (offset / 1000).toFixed(3) + 's (' + direction + ')',
        type: 'info', duration: 4000
    });
}

function getServerTime() {
    return Date.now() + serverTimeOffset;
}

// ── 连接预热 ──
var preheatTimer = null;

function startConnectionPreheat() {
    if (preheatTimer) return;
    console.log('[预热] 开始连接预热 (每2s一次 batch-preview)');
    preheatTimer = setInterval(function() {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/biz/pay/batch-preview');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({}));
    }, 2000);
}

function stopConnectionPreheat() {
    if (preheatTimer) {
        clearInterval(preheatTimer);
        preheatTimer = null;
        console.log('[预热] 停止连接预热');
    }
}

// ==================== 检测本地验证码识别服务 ====================
function checkLocalOcrService() {
    var baseUrl = DDDDOCR_URL.replace(/\/click$/, '/');
    var onError = function() {
        vueApp.$message({ message: '未启动本地验证码识别服务（ddddocr），请先运行 captcha/ddddocr_server.py', type: 'warning', duration: 5000 });
    };
    var onSuccess = function() {
        vueApp.$message({ message: '本地验证码识别服务已启动', type: 'success', duration: 3000 });
    };
    if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
            method: 'GET',
            url: baseUrl,
            timeout: 2000,
            onload: onSuccess,
            onerror: onError,
            ontimeout: onError
        });
    } else {
        var controller = new AbortController();
        var tid = setTimeout(function() { controller.abort(); }, 2000);
        fetch(baseUrl, { mode: 'no-cors', signal: controller.signal })
            .then(function() { clearTimeout(tid); onSuccess(); })
            .catch(function() { clearTimeout(tid); onError(); });
    }
}

// ==================== 控制面板 ====================
var running = false;
var timer = null;

function createControlPanel() {
    var panel = document.createElement('div');
    panel.id = 'auto-buy-panel';
    panel.innerHTML = `
        <style>
            #auto-buy-panel {
                position: fixed;
                top: 50px;
                right: 10px;
                z-index: 2000000022;
                display: flex;
                align-items: center;
                gap: 8px;
                background: rgba(0,0,0,0.75);
                color: #fff;
                padding: 8px 14px;
                border-radius: 8px;
                font-size: 13px;
                font-family: monospace;
                user-select: none;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                cursor: move;
            }
            #auto-buy-panel.dragging {
                opacity: 0.8;
            }
            #auto-buy-panel .status {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #67c23a;
                flex-shrink: 0;
            }
            #auto-buy-panel .status.paused { background: #e6a23c; }
            #auto-buy-panel .status.idle { background: #909399; }
            #auto-buy-btn, #auto-captcha-btn {
                cursor: pointer;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 4px 12px;
                font-size: 12px;
                font-family: monospace;
            }
            #auto-buy-btn { background: #409eff; }
            #auto-buy-btn:hover { background: #66b1ff; }
            #auto-captcha-btn { background: #67c23a; display: none; }
            #auto-buy-panel .countdown { color: #e6a23c; font-size: 12px; }
            #auto-buy-panel input[type="time"] {
                width: 90px;
                background: rgba(255,255,255,0.15);
                color: #fff;
                border: 1px solid rgba(255,255,255,0.3);
                border-radius: 4px;
                padding: 2px 6px;
                font-size: 12px;
                font-family: monospace;
            }
            #auto-buy-panel .buy-btn-group {
                display: flex;
                gap: 2px;
            }
            #auto-buy-panel .buy-btn-group label {
                padding: 2px 8px;
                border-radius: 4px;
                font-size: 11px;
                cursor: pointer;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.2);
                transition: all 0.15s;
            }
            #auto-buy-panel .buy-btn-group input:checked + label {
                background: #409eff;
                border-color: #409eff;
            }
            #auto-buy-panel .buy-btn-group input { display: none; }
            #auto-buy-panel .package-group {
                display: flex;
                gap: 2px;
            }
            #auto-buy-panel .package-group label {
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 11px;
                cursor: pointer;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.2);
                transition: all 0.15s;
            }
            #auto-buy-panel .package-group input:checked + label {
                background: #e6a23c;
                border-color: #e6a23c;
            }
            #auto-buy-panel .package-group input { display: none; }
            #auto-buy-panel .sep {
                width: 1px;
                height: 18px;
                background: rgba(255,255,255,0.2);
            }
            .package-card-box.auto-buy-selected {
                border: 3px solid #e6a23c !important;
                box-shadow: 0 0 12px rgba(230, 162, 60, 0.5) !important;
            }
            .switch-tab-item.auto-buy-pkg-selected {
                border: 2px solid #e6a23c !important;
                box-shadow: 0 0 8px rgba(230, 162, 60, 0.5) !important;
                border-radius: 6px;
            }
        </style>
        <div class="status"></div>
        <span id="auto-buy-label">等待中</span>
        <span id="auto-buy-countdown" class="countdown"></span>
        <span id="auto-buy-offset" style="color:#67c23a;font-size:10px;"></span>
        <div class="sep"></div>
        <div class="package-group" title="套餐类型">
            <input type="radio" name="package-type" id="pkg-month" value="month"><label for="pkg-month">月</label>
            <input type="radio" name="package-type" id="pkg-quarter" value="quarter" checked><label for="pkg-quarter">季</label>
            <input type="radio" name="package-type" id="pkg-year" value="year"><label for="pkg-year">年</label>
        </div>
        <input type="time" id="buy-time-input" step="1" value="${BUY_TIME_DEFAULT}" title="抢购时间" />
        <div class="buy-btn-group">
            <input type="radio" name="buy-btn" id="buy-btn-0" value="0"><label for="buy-btn-0">Lite</label>
            <input type="radio" name="buy-btn" id="buy-btn-1" value="1"><label for="buy-btn-1">Pro</label>
            <input type="radio" name="buy-btn" id="buy-btn-2" value="2" checked><label for="buy-btn-2">Max</label>
        </div>
        <button id="auto-buy-btn">暂停</button>
        <button id="auto-captcha-btn" style="display:none;">测试验证码</button>
        <label title="preview成功后直接调create-sign锁单，跳过pay-middle-page延迟" style="cursor:pointer;display:flex;align-items:center;gap:3px;font-size:11px;color:#e6a23c;">
            <input type="checkbox" id="auto-lock-check" style="margin:0;" />
            锁单
        </label>
        <button id="help-btn" style="background:#909399;">说明</button>
    `;
    document.body.appendChild(panel);

    // ── 说明弹窗 ──
    document.getElementById('help-btn').addEventListener('click', function() {
        showHelpDialog();
    });

    // ── 拖拽功能 ──
    var isDragging = false;
    var dragStartX, dragStartY, panelStartX, panelStartY;

    // 从缓存恢复位置
    var savedPos = localStorage.getItem('autoBuy_panelPos');
    if (savedPos) {
        try {
            var pos = JSON.parse(savedPos);
            panel.style.left = pos.left + 'px';
            panel.style.top = pos.top + 'px';
            panel.style.right = 'auto';
        } catch (e) {}
    }

    panel.addEventListener('mousedown', function(e) {
        // 如果点击的是按钮或输入框，不触发拖拽
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') {
            return;
        }
        isDragging = true;
        panel.classList.add('dragging');
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        var rect = panel.getBoundingClientRect();
        panelStartX = rect.left;
        panelStartY = rect.top;
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        var deltaX = e.clientX - dragStartX;
        var deltaY = e.clientY - dragStartY;
        panel.style.left = (panelStartX + deltaX) + 'px';
        panel.style.top = (panelStartY + deltaY) + 'px';
        panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', function() {
        if (isDragging) {
            isDragging = false;
            panel.classList.remove('dragging');
            // 保存位置到缓存
            var rect = panel.getBoundingClientRect();
            localStorage.setItem('autoBuy_panelPos', JSON.stringify({
                left: rect.left,
                top: rect.top
            }));
        }
    });

    var btn = document.getElementById('auto-buy-btn');
    var label = document.getElementById('auto-buy-label');
    var statusDot = panel.querySelector('.status');

    // ── 从缓存恢复设置 ──
    var savedTime = localStorage.getItem('autoBuy_time');
    if (savedTime) {
        document.getElementById('buy-time-input').value = savedTime;
    }
    var savedPkg = localStorage.getItem('autoBuy_package') || PACKAGE_TYPE_DEFAULT;
    var pkgRadio = document.querySelector('input[name="package-type"][value="' + savedPkg + '"]');
    if (pkgRadio) pkgRadio.checked = true;
    var savedBtnIdx = localStorage.getItem('autoBuy_btnIdx');
    if (savedBtnIdx !== null) {
        var btnRadio = document.querySelector('input[name="buy-btn"][value="' + savedBtnIdx + '"]');
        if (btnRadio) btnRadio.checked = true;
    }
    var savedAutoLock = localStorage.getItem('autoBuy_autoLock');
    if (savedAutoLock === 'true') {
        document.getElementById('auto-lock-check').checked = true;
    }

    // ── 保存设置到缓存 ──
    document.getElementById('buy-time-input').addEventListener('change', function() {
        localStorage.setItem('autoBuy_time', this.value);
    });
    document.getElementById('auto-lock-check').addEventListener('change', function() {
        localStorage.setItem('autoBuy_autoLock', this.checked ? 'true' : 'false');
    });
    document.querySelectorAll('input[name="package-type"]').forEach(function(radio) {
        radio.addEventListener('change', function() {
            if (this.checked) {
                localStorage.setItem('autoBuy_package', this.value);
                clickPagePackageTab();
                highlightPackageTab();
                // 切换套餐后需要等待页面卡片更新再高亮
                setTimeout(highlightPackageCard, 500);
            }
        });
    });
    document.querySelectorAll('input[name="buy-btn"]').forEach(function(radio) {
        radio.addEventListener('change', function() {
            if (this.checked) {
                localStorage.setItem('autoBuy_btnIdx', this.value);
                highlightPackageCard();
            }
        });
    });

    // ── 初始化页面状态（等待页面数据加载完成）─
    function initPageState() {
        var claudeBox = document.querySelector('.claude-code-box');
        var products = claudeBox?.__vue__?.allCardDataList;
        if (!products || !Array.isArray(products) || products.length === 0) {
            // 数据还没加载，继续等待
            setTimeout(initPageState, 200);
            return;
        }

        let l = document.querySelector('.claude-code-box').__vue__;
        win.vueApp = l;
        l.allCardDataList.forEach(n => {
            n.soldOut = false;
            n.canPurchase = true;
            n.disabled = false;
        })
        vueApp.$message('脚本注入成功')
        checkLocalOcrService();

        highlightPackageCard();
        clickPagePackageTab();
        highlightPackageTab();
        // 点击tab后等待卡片更新再高亮一次
        console.log('点击tab后等待卡片更新再高亮一次');
        setTimeout(highlightPackageCard, 600);
    }
    console.log('setTimeout(initPageState, 500);');
    setTimeout(initPageState, 500);

    btn.addEventListener('click', function () {
        running = !running;
        updatePanelUI();
        if (running) {
            // 重置锁单状态（重新开始抢购）
            lockOrderInProgress = false;
            lockOrderDone = false;
            captchaPreSolved = false;
            captchaPreOpenAttempted = false;
            removePreSolveHint();
            var overlay = document.getElementById('auto-lock-qr-overlay');
            if (overlay) overlay.remove();
            scheduleNext();
        } else {
            clearTimeout(timer);
            timer = null;
        }
    });

    var capBtn = document.getElementById('auto-captcha-btn');
    capBtn.addEventListener('click', async function () {
        if (!isCaptchaVisible()) {
            console.warn('[验证码] 未检测到弹窗');
            return;
        }
        // 关键：测试期间必须停掉 autoPay，否则 handleCaptcha(true) 结束后
        // autoPay 会看到验证码还在，再调一次非测试版，导致点确认→刷新
        running = false;
        clearTimeout(timer);
        timer = null;
        updatePanelUI();
        capBtn.disabled = true;
        capBtn.textContent = '识别中…';
        try {
            await handleCaptcha(true);
        } finally {
            capBtn.disabled = false;
            capBtn.textContent = '测试验证码';
        }
    });

    function updatePanelUI() {
        if (running) {
            btn.textContent = '暂停';
            statusDot.className = 'status';
            label.textContent = '运行中';
        } else {
            btn.textContent = '开始';
            statusDot.className = 'status paused';
            label.textContent = '已暂停';
        }
    }

    // 暴露更新方法
    win.__autoBuyUpdateUI = function (text, state) {
        label.textContent = text;
        if (state === 'paused') {
            statusDot.className = 'status paused';
        } else if (state === 'idle') {
            statusDot.className = 'status idle';
        } else {
            statusDot.className = 'status';
        }
    };

    win.__autoBuyShowCountdown = function (text) {
        var el = document.getElementById('auto-buy-countdown');
        if (el) el.textContent = text;
    };

    updatePanelUI();
}

// ==================== 说明弹窗 ====================
function showHelpDialog() {
    // 检查是否已存在弹窗
    if (document.getElementById('help-dialog')) return;

    var dialog = document.createElement('div');
    dialog.id = 'help-dialog';
    dialog.innerHTML = `
        <style>
            #help-dialog {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                z-index: 2000000023;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0,0,0,0.5);
            }
            #help-dialog .help-content {
                background: #fff;
                border-radius: 12px;
                padding: 24px 32px;
                max-width: 480px;
                max-height: 80vh;
                overflow-y: auto;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                font-size: 14px;
                line-height: 1.8;
                color: #333;
            }
            #help-dialog .help-title {
                font-size: 18px;
                font-weight: bold;
                margin-bottom: 16px;
                color: #409eff;
                border-bottom: 1px solid #eee;
                padding-bottom: 12px;
            }
            #help-dialog .help-item {
                margin-bottom: 16px;
                padding-left: 24px;
                position: relative;
            }
            #help-dialog .help-item::before {
                content: attr(data-num);
                position: absolute;
                left: 0;
                color: #409eff;
                font-weight: bold;
            }
            #help-dialog .help-highlight {
                color: #e6a23c;
                font-weight: bold;
            }
            #help-dialog .help-link {
                color: #409eff;
                text-decoration: none;
            }
            #help-dialog .help-link:hover {
                text-decoration: underline;
            }
            #help-dialog .help-close {
                margin-top: 20px;
                text-align: center;
            }
            #help-dialog .help-close button {
                background: #409eff;
                color: #fff;
                border: none;
                border-radius: 6px;
                padding: 8px 32px;
                font-size: 14px;
                cursor: pointer;
            }
            #help-dialog .help-close button:hover {
                background: #66b1ff;
            }
        </style>
        <div class="help-content">
            <div class="help-title">使用说明 <span style="font-size:12px;color:#999;font-weight:normal;">v2.0.0</span></div>
            <div class="help-item" data-num="1.">
                请<span class="help-highlight">提前进入抢号界面</span>，高峰期页面可能无法加载。进入后<span class="help-highlight">不要刷新</span>。选择需要的套餐后点击"开始"，到点自动抢购。请提前打开支付宝扫码支付，手速慢依然可能售罄。
            </div>
            <div class="help-item" data-num="2.">
                可以将倒计时设置为当日更早的时间进行<span class="help-highlight">测试</span>，验证脚本是否正常工作。
            </div>
            <div class="help-item" data-num="3.">
                验证码识别使用本地 ddddocr 服务（<span class="help-highlight">需提前启动 captcha/ddddocr_server.py</span>），识别速度约100ms。若未启动本地服务，脚本启动时会弹出警告提示。
            </div>
            <div class="help-item" data-num="4.">
                脚本原理是自动激活购买按钮，不使用暴力手段。能否抢到仍需运气，欢迎邀请好友一起参与，祝您好运！
            </div>
            <div class="help-item" data-num="5.">
                <span class="help-highlight">自动锁单</span>（左上角黄色复选框）：勾选后，preview成功时会直接调create-sign接口锁单，跳过扫码→pay-middle-page的延迟。锁单成功后弹出支付宝支付二维码，扫码即可直接订阅，无需担心售罄。
            </div>
            <div class="help-close">
                <p style="color:#409eff;margin-bottom:12px;">QQ交流群: <strong>981656846</strong></p>
                <button id="help-close-btn">我知道了</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);

    // 点击关闭按钮
    document.getElementById('help-close-btn').addEventListener('click', function() {
        dialog.remove();
    });

    // 点击背景关闭
    dialog.addEventListener('click', function(e) {
        if (e.target === dialog) {
            dialog.remove();
        }
    });
}

// ==================== 验证码识别面板（左上角） ====================
function createCaptchaPanel() {
    var panel = document.createElement('div');
    panel.id = 'captcha-solve-panel';
    panel.innerHTML = `
        <style>
            #captcha-solve-panel {
                position: fixed;
                top: 10px;
                left: 10px;
                z-index: 2000000022;
                display: flex;
                align-items: center;
                gap: 8px;
                background: rgba(0,0,0,0.75);
                color: #fff;
                padding: 8px 14px;
                border-radius: 8px;
                font-size: 13px;
                font-family: monospace;
                user-select: none;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            }
            #solve-captcha-btn {
                cursor: pointer;
                background: #67c23a;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 4px 12px;
                font-size: 12px;
                font-family: monospace;
            }
            #solve-captcha-btn:hover {
                background: #85ce61;
            }
            #solve-captcha-btn:disabled {
                background: #909399;
                cursor: not-allowed;
            }
            #captcha-solve-panel label {
                display: flex;
                align-items: center;
                gap: 4px;
                cursor: pointer;
                font-size: 12px;
            }
        </style>
        <button id="solve-captcha-btn">识别验证码</button>
        <label>
            <input type="checkbox" id="auto-confirm-check" />
            自动确认
        </label>
    `;
    document.body.appendChild(panel);

    var btn = document.getElementById('solve-captcha-btn');
    btn.addEventListener('click', async function () {
        if (!isCaptchaVisible()) {
            console.warn('[验证码] 未检测到验证码弹窗');
            btn.textContent = '无验证码';
            setTimeout(function () { btn.textContent = '识别验证码'; }, 1500);
            return;
        }
        btn.disabled = true;
        btn.textContent = '识别中…';
        try {
            var autoConfirm = document.getElementById('auto-confirm-check').checked;
            await solveCaptchaManual(autoConfirm);
        } finally {
            btn.disabled = false;
            btn.textContent = '识别验证码';
        }
    });
}

async function solveCaptchaManual(autoConfirm) {
    if (captchaHandling) return;
    captchaHandling = true;
    var panelBtn = document.getElementById('solve-captcha-btn');
    var maxRetries = autoConfirm ? 5 : 1;

    try {
        for (var attempt = 0; attempt < maxRetries; attempt++) {
            if (attempt > 0) {
                if (panelBtn) panelBtn.textContent = '重试 ' + attempt + '/' + (maxRetries - 1);
            }

            // ── 识别 + 点击 ──
            var T0 = performance.now();
            var chars = extractCaptchaChars();
            var url = extractCaptchaBgUrl();
            if (!chars || !url) throw new Error('未找到提示字或背景图');
            console.log('[验证码] #' + (attempt + 1) + ' 汉字:', chars);

            var base64 = await fetchImageBase64(url);
            var size = await getImageSize(base64);
            var result = await recognizeCaptcha(base64, chars);
            console.log('[验证码] OCR耗时:', (performance.now() - T0).toFixed(0) + 'ms, 结果:', result);

            for (var i = 0; i < result.points.length; i++) {
                clickOnCaptcha(result.points[i], size, null);
                await sleep(100);
            }

            // ── 非自动确认：点完字符就结束 ──
            if (!autoConfirm) return;

            // ── 自动确认：点击确定，等待结果 ──
            await sleep(100);
            clickCaptchaConfirm();
            console.log('[验证码] 已点击确定，等待结果...');

            // MutationObserver 即时检测验证结果
            var captchaResult = await waitForCaptchaResult(1000);

            if (captchaResult === 'closed') {
                console.log('[验证码] 验证成功！');
                return;
            }

            // error 或 timeout → 刷新验证码
            console.log('[验证码] 验证错误，准备刷新重试');
            clickCaptchaRefresh();
            await waitForCaptchaImageChange(extractCaptchaBgUrl(), 1000);
            await sleep(100);
        }

        console.warn('[验证码] 重试次数用尽 (' + maxRetries + ')');
    } catch (e) {
        console.warn('[验证码] 手动识别失败:', e);
    } finally {
        captchaHandling = false;
    }
}

function _isVerifyErrorVisible() {
    var el = document.querySelector('.tencent-captcha-dy__verify-error-text');
    if (!el) return false;
    return isElementTrulyVisible(el);
}

// ==================== 自动抢购逻辑 ====================
function getBuyTimeStr() {
    var el = document.getElementById('buy-time-input');
    var timeStr = el && el.value ? el.value : BUY_TIME_DEFAULT;
    return timeStr;
}

function parseBuyTime() {
    var parts = getBuyTimeStr().split(':');
    return {
        h: parseInt(parts[0], 10) || 0,
        m: parseInt(parts[1], 10) || 0,
        s: parseInt(parts[2], 10) || 0
    };
}

function isBuyTimeReached() {
    var now = new Date(getServerTime());
    var t = parseBuyTime();
    return now.getHours() > t.h
        || (now.getHours() === t.h && now.getMinutes() > t.m)
        || (now.getHours() === t.h && now.getMinutes() === t.m && now.getSeconds() >= t.s);
}

function getSecondsToBuyTime() {
    var now = new Date(getServerTime());
    var t = parseBuyTime();
    var target = new Date(now);
    target.setHours(t.h, t.m, t.s, 0);
    if (now >= target) return 0;
    return Math.floor((target - now) / 1000);
}

// 获取用户选择的套餐类型
function getPackageType() {
    var radio = document.querySelector('input[name="package-type"]:checked');
    return radio ? radio.value : PACKAGE_TYPE_DEFAULT;
}

// 点击页面上对应的套餐 tab
function clickPagePackageTab() {
    var pkgType = getPackageType();
    var tabIndex;
    switch (pkgType) {
        case 'month':  tabIndex = 0; break;  // 第1个 tab-item（包月）
        case 'quarter': tabIndex = 1; break; // 第2个 tab-item（包季）
        case 'year':   tabIndex = 2; break;  // 第3个 tab-item（包年）
        default:       tabIndex = 1;
    }
    var tabItems = document.querySelectorAll('.switch-tab-box .switch-tab-item');
    if (tabItems.length > tabIndex) {
        var targetTab = tabItems[tabIndex];
        if (targetTab && !targetTab.classList.contains('active')) {
            targetTab.click();
            console.log('[套餐切换] 已点击: ' + pkgType);
        }
    }
}

// 高亮页面上当前选择的档位卡片
function highlightPackageCard() {
    var idx = parseInt(document.querySelector('input[name="buy-btn"]:checked')?.value);
    if (isNaN(idx)) idx = 2;
    var cards = document.querySelectorAll('.package-card-box');
    cards.forEach(function(card, i) {
        if (i === idx) {
            card.classList.add('auto-buy-selected');
        } else {
            card.classList.remove('auto-buy-selected');
        }
    });
}

// 高亮页面上当前选择的套餐 tab
function highlightPackageTab() {
    var pkgType = getPackageType();
    var tabIndex;
    switch (pkgType) {
        case 'month':  tabIndex = 0; break;
        case 'quarter': tabIndex = 1; break;
        case 'year':   tabIndex = 2; break;
        default:       tabIndex = 1;
    }
    var tabItems = document.querySelectorAll('.switch-tab-box .switch-tab-item');
    tabItems.forEach(function(item, i) {
        if (i === tabIndex) {
            item.classList.add('auto-buy-pkg-selected');
        } else {
            item.classList.remove('auto-buy-pkg-selected');
        }
    });
}

// ==================== 验证码处理 ====================
var captchaHandling = false;

function getCaptchaRoot() {
    return document.getElementById('tCaptchaDyMainWrap');
}

// 逐级向上检查祖先的 display / visibility / opacity / 是否出屏
// 单独检查元素自身不够：opacity 不会继承到子元素的 computed style
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
    // 出屏判定：腾讯隐藏验证码时常用 top:-10000px 的手段
    if (rect.right <= 0 || rect.bottom <= 0) return false;
    if (rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
    return true;
}

function isCaptchaVisible() {
    // 以实际显示的背景图元素作为判据——wrap/transform 层可能残留在 DOM 里
    var bg = document.querySelector('.tencent-captcha-dy__verify-bg-img');
    if (!bg) return false;
    if (!isElementTrulyVisible(bg)) return false;
    // 必须真的有图片（关闭态时 backgroundImage 通常被清空）
    var bgImage = bg.style.backgroundImage || '';
    if (bgImage.indexOf('url(') === -1) return false;
    return true;
}

// 提取提示中的汉字（过滤掉"请依次点击："等）
function extractCaptchaChars() {
    var el = document.querySelector('.tencent-captcha-dy__header-text');
    if (!el) return '';
    var text = el.textContent || '';
    var m = text.match(/[\u4e00-\u9fa5]/g) || [];
    // 去掉"请依次点击"5字
    var filtered = m.filter(function (c) { return '请依次点击'.indexOf(c) < 0; });
    return filtered.join('');
}

function extractCaptchaBgUrl() {
    var el = document.querySelector('.tencent-captcha-dy__verify-bg-img');
    if (!el) return null;
    var bg = el.style.backgroundImage || '';
    var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
}

// 跨域取图 + 转 base64（优先用 GM_xmlhttpRequest，失败回退 fetch）
function fetchImageBase64(url) {
    return new Promise(function (resolve, reject) {
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: function (res) {
                    var reader = new FileReader();
                    reader.onloadend = function () {
                        var b64 = String(reader.result).split(',')[1];
                        resolve(b64);
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

// 获取原图尺寸（用于坐标缩放）
function getImageSize(base64) {
    return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = reject;
        img.src = 'data:image/png;base64,' + base64;
    });
}

// 调 ddddocr 本地服务识别（~100ms）
function recognizeCaptcha(base64, chars) {
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
                    reject(new Error('ddddocr 识别失败: ' + text));
                }
            } catch (e) { reject(e); }
        };
        var notRunning = function () {
            reject(new Error('本地验证码识别服务未启动，请先运行 captcha/ddddocr_server.py'));
        };
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'POST',
                url: DDDDOCR_URL,
                headers: { 'Content-Type': 'application/json' },
                data: payload,
                onload: function (res) { handleRes(res.responseText); },
                onerror: notRunning
            });
        } else {
            fetch(DDDDOCR_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).then(function (r) { return r.text(); }).then(handleRes).catch(notRunning);
        }
    });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 使用 MutationObserver 即时检测验证码验证结果（比轮询快数十倍）
function waitForCaptchaResult(timeoutMs) {
    return new Promise(function(resolve) {
        var settled = false;
        var observer;

        function done(r) {
            if (settled) return;
            settled = true;
            if (observer) observer.disconnect();
            resolve(r);
        }

        function check() {
            if (settled) return;
            if (_isVerifyErrorVisible()) { done('error'); return; }
            if (!isCaptchaVisible()) { done('closed'); return; }
        }

        observer = new MutationObserver(check);
        var root = document.getElementById('tCaptchaDyMainWrap');
        if (root) {
            observer.observe(root, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['style', 'class']
            });
        }
        check(); // 立即检查一次
        setTimeout(function() { done('timeout'); }, timeoutMs);
    });
}

// 使用 MutationObserver 等待验证码背景图刷新完成
function waitForCaptchaImageChange(prevUrl, timeoutMs) {
    return new Promise(function(resolve) {
        var settled = false;
        var observer;

        function done(r) {
            if (settled) return;
            settled = true;
            if (observer) observer.disconnect();
            resolve(r);
        }

        function check() {
            if (settled) return;
            var nu = extractCaptchaBgUrl();
            if (nu && nu !== prevUrl) done('changed');
        }

        observer = new MutationObserver(check);
        var bgImg = document.querySelector('.tencent-captcha-dy__verify-bg-img');
        if (bgImg) {
            observer.observe(bgImg, { attributes: true, attributeFilter: ['style'] });
        }
        check();
        setTimeout(function() { done('timeout'); }, timeoutMs);
    });
}

// 在坐标位置画一个红点标记，便于人工核对点击位置
function drawClickMarker(clientX, clientY, label) {
    var dot = document.createElement('div');
    dot.className = '__captcha_test_marker';
    dot.textContent = label || '';
    dot.style.cssText = [
        'position:fixed',
        'left:' + (clientX - 10) + 'px',
        'top:' + (clientY - 10) + 'px',
        'width:20px','height:20px','border-radius:50%',
        'background:rgba(255,0,0,0.75)','color:#fff',
        'font:bold 12px/20px monospace','text-align:center',
        'z-index:2147483647','pointer-events:none',
        'box-shadow:0 0 0 2px #fff'
    ].join(';');
    document.body.appendChild(dot);
}

function clearClickMarkers() {
    document.querySelectorAll('.__captcha_test_marker').forEach(function (n) { n.remove(); });
}

// 在验证码图片上按坐标模拟点击（坐标相对原图，内部自动缩放到显示尺寸）
function clickOnCaptcha(point, imgSize, markerLabel) {
    var bg = document.querySelector('.tencent-captcha-dy__verify-bg-img');
    if (!bg) return;

    var rect = bg.getBoundingClientRect();
    var scaleX = rect.width / imgSize.w;
    var scaleY = rect.height / imgSize.h;
    var clientX = rect.left + point.x * scaleX;
    var clientY = rect.top + point.y * scaleY;

    if (markerLabel != null) drawClickMarker(clientX, clientY, markerLabel);
    // 固定派发到 bg-img 自身：composed/elementFromPoint 会把事件传到外层，
    // 很容易触发到"点击外侧关闭/刷新"逻辑，导致只点一次就整张图刷新
    var target = bg;
    // 注意：油猴沙箱中 window 是 Proxy，不是真正的 Window 实例，
    // 传给 MouseEvent 构造函数会报 "Failed to convert value to 'Window'"，
    // 因此直接省略 view 字段
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
    // 鼠标 + 指针 事件
    target.dispatchEvent(new MouseEvent('mouseover', baseOpts));
    target.dispatchEvent(new MouseEvent('mousemove', baseOpts));
    if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
    }
    target.dispatchEvent(new MouseEvent('mousedown', baseOpts));
    if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
    }
    target.dispatchEvent(new MouseEvent('mouseup', baseOpts));
    target.dispatchEvent(new MouseEvent('click', baseOpts));
}

function clickCaptchaConfirm() {
    var btn = document.querySelector('.tencent-captcha-dy__verify-confirm-btn');
    if (btn) btn.click();
}

function clickCaptchaRefresh() {
    var btn = document.querySelector('.tencent-captcha-dy__footer-icon--refresh img');
    if (btn) btn.click();
}

async function solveCaptchaOnce(isTest) {
    var T0 = performance.now();
    var chars = extractCaptchaChars();
    var url = extractCaptchaBgUrl();
    if (!chars || !url) throw new Error('未找到提示字或背景图');
    console.log('[验证码] 汉字:', chars);

    var t1 = performance.now();
    var base64 = await fetchImageBase64(url);
    var t2 = performance.now();
    console.log('[⏱] 下载背景图:', (t2 - t1).toFixed(0) + 'ms, 大小:', base64.length);

    var size = await getImageSize(base64);
    var t3 = performance.now();
    console.log('[⏱] 解码图片尺寸:', (t3 - t2).toFixed(0) + 'ms,', size.w + 'x' + size.h);

    var result = await recognizeCaptcha(base64, chars);
    var t4 = performance.now();
    console.log('[⏱] OCR识别(ddddocr):', (t4 - t3).toFixed(0) + 'ms, 返回:', result);

    console.log('[⏱] 首次点击前总耗时:', (t4 - T0).toFixed(0) + 'ms');

    if (isTest) clearClickMarkers();
    for (var i = 0; i < result.points.length; i++) {
        clickOnCaptcha(result.points[i], size, isTest ? String(i + 1) : null);
        await sleep(100);
    }
    var t5 = performance.now();
    console.log('[⏱] 三次点击完成:', (t5 - t4).toFixed(0) + 'ms');

    if (!isTest) {
        clickCaptchaConfirm();
        lastPreviewResult = null;
        console.log('[⏱] 点击完成，等待验证结果...');

        // MutationObserver 即时检测验证结果（错误/关闭），无需轮询
        var captchaResult = await waitForCaptchaResult(1000);

        if (captchaResult === 'error') {
            console.log('[验证码] 验证失败，需刷新重试');
            return false;
        }

        // 验证通过（closed）或超时 → 等待 API 响应
        if (captchaResult === 'closed' || !isCaptchaVisible()) {
            for (var w = 0; w < 40; w++) {
                await sleep(50);
                if (!lastPreviewResult) continue;

                if (lastPreviewResult.code === 200 && lastPreviewResult.data && !lastPreviewResult.data.soldOut) {
                    console.log('[验证码] 抢购成功！');
                    return true;
                }
                console.log('[验证码] ' + (lastPreviewResult.code === 555 ? '服务器繁忙' : '售罄'));
                return false;
            }
        }

        return !isCaptchaVisible();
    }
    return false;
}

// ==================== 预解题（提前10s弹出验证码，点选汉字但不确认） ====================
function showPreSolveHint() {
    if (document.getElementById('pre-solve-hint')) return;
    var hint = document.createElement('div');
    hint.id = 'pre-solve-hint';
    hint.innerHTML =
        '<style>' +
        '#pre-solve-hint {' +
        '  position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        '  background:linear-gradient(135deg,#e6a23c,#f56c6c);color:#fff;' +
        '  text-align:center;padding:10px 16px;font:bold 14px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;' +
        '  box-shadow:0 2px 12px rgba(230,162,60,0.4);' +
        '  cursor:pointer;user-select:none;' +
        '}' +
        '#pre-solve-hint:hover { filter:brightness(1.1); }' +
        '#pre-solve-hint:active { filter:brightness(0.95); }' +
        '</style>' +
        '验证码已自动识别，倒计时结束后会自动点击确定。若识别有误，<u>点击此处</u>刷新并重新识别。';
    hint.addEventListener('click', function() {
        if (captchaHandling) return;
        captchaPreSolved = false;
        // 刷新验证码
        clickCaptchaRefresh();
        console.log('[预解题] 用户点击浮窗，刷新验证码并重新识别');
        // 等刷新完成后再重新识别
        setTimeout(function() {
            if (isCaptchaVisible() && !captchaHandling && !captchaPreSolved) {
                preSolveCaptcha();
            }
        }, 1500);
    });
    document.body.appendChild(hint);
}

function removePreSolveHint() {
    var hint = document.getElementById('pre-solve-hint');
    if (hint) hint.remove();
}

async function preSolveCaptcha() {
    if (captchaHandling) return;
    captchaHandling = true;
    try {
        for (var i = 0; i < CAPTCHA_MAX_RETRY; i++) {
            if (!isCaptchaVisible()) break;
            var chars = extractCaptchaChars();
            var url = extractCaptchaBgUrl();
            if (!chars || !url) { await sleep(500); continue; }

            var base64 = await fetchImageBase64(url);
            var size = await getImageSize(base64);
            var result = await recognizeCaptcha(base64, chars);

            for (var j = 0; j < result.points.length; j++) {
                clickOnCaptcha(result.points[j], size, null);
                await sleep(100);
            }
            captchaPreSolved = true;
            showPreSolveHint();
            console.log('[预解题] 验证码已预解，等待到点确认');
            break;
        }
    } catch (e) {
        console.warn('[预解题] 预解失败:', e);
    } finally {
        captchaHandling = false;
    }
}

async function handleCaptcha(isTest) {
    if (captchaHandling) return;
    captchaHandling = true;
    try {
        var prevUrl = null;
        for (var i = 0; i < CAPTCHA_MAX_RETRY; i++) {
            try {
                var ok = await solveCaptchaOnce(isTest);
                if (ok) { console.log('[验证码] 通过'); return; }
                if (isTest) return;
                // 验证码已确认但 API 返回繁忙/售罄 → 腾讯验证码已关闭，无需刷新重试
                // 直接退出，让 autoPay 重新点击购买按钮弹出新的验证码
                if (!isCaptchaVisible()) {
                    console.log('[验证码] 验证码已关闭（API返回繁忙/售罄），交给 autoPay 重新购买');
                    return;
                }
                // 验证码还在（OCR识别失败等），刷新换图重试
                console.log('[验证码] 未通过，刷新换图');
                prevUrl = extractCaptchaBgUrl();
                clickCaptchaRefresh();
                await waitForCaptchaImageChange(prevUrl, 2000);
                await sleep(100);
            } catch (e) {
                console.warn('[验证码] 第' + (i + 1) + '次失败:', e);
                if (isTest) return;
                // 验证码已关闭，不要重试
                if (!isCaptchaVisible()) {
                    console.log('[验证码] 验证码已关闭，交给 autoPay 重新购买');
                    return;
                }
                clickCaptchaRefresh();
                await waitForCaptchaImageChange(extractCaptchaBgUrl(), 2000);
                await sleep(100);
            }
        }
        console.warn('[验证码] 重试次数用尽，关闭验证码面板');
        clickCaptchaRefresh();
        await waitForCaptchaImageChange(extractCaptchaBgUrl(), 2000);
    } finally {
        captchaHandling = false;
    }
}

// 停止抢购并标记成功
function stopSuccess(msg) {
    running = false;
    clearTimeout(timer);
    timer = null;
    removePreSolveHint();
    win.__autoBuyUpdateUI && win.__autoBuyUpdateUI('抢到了！', 'paused');
    var btn = document.getElementById('auto-buy-btn');
    if (btn) btn.textContent = '已抢到';
    console.log('[自动抢购] ' + msg);
}

// 检查 canvas 是否为空白（售罄时弹窗闪现空白canvas）
function isCanvasBlank(canvas) {
    if (!canvas || canvas.width === 0 || canvas.height === 0) return true;
    try {
        var ctx = canvas.getContext('2d');
        var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (var i = 0; i < data.length; i += 4) {
            // 检查是否有非白色非透明像素（QR码是黑色的）
            if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
                return false;
            }
        }
        return true;
    } catch (e) {
        return true;
    }
}

// 截取官方 canvas 二维码并在新窗口展示
function saveAndOpenQRCode(qrCanvas, payRef) {
    try {
        if (isCanvasBlank(qrCanvas)) {
            console.warn('[自动抢购] 二维码canvas为空白，跳过保存（可能已售罄）');
            return;
        }
        if (!payRef?.priceData?.thirdPartyAmount) {
            console.warn('[自动抢购] 无支付金额，跳过保存（可能已售罄）');
            return;
        }
        var dataUrl = qrCanvas.toDataURL('image/png');
        var amount = payRef.priceData.thirdPartyAmount;
        var productName = payRef.cardData?.productName || '';

        console.log('[自动抢购] bizId:', payRef.priceData?.bizId);
        console.log('[自动抢购] thirdPartyAmount:', amount);

        // 新窗口展示官方二维码
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

        // 自动下载二维码图片
        var link = document.createElement('a');
        link.download = 'qrcode_' + Date.now() + '.png';
        link.href = dataUrl;
        link.click();

        console.log('[自动抢购] 二维码已保存并打开');
    } catch (e) {
        console.warn('[自动抢购] 保存二维码失败:', e);
    }
}

// ==================== 自动锁单 ====================
// preview 成功后直接调 create-sign，跳过 pay-middle-page 延迟

function loadQRLibrary() {
    if (typeof win.QRCode !== 'undefined') return;
    var s = document.createElement('script');
    s.src = 'https://cdn.bootcdn.net/ajax/libs/qrcode/1.5.0/qrcode.min.js';
    s.onload = function() { console.log('[锁单] QR库加载成功'); };
    s.onerror = function() { console.warn('[锁单] QR库加载失败'); };
    document.head.appendChild(s);
}

function getCustomerId() {
    try {
        var store = win.vueApp?.$store;
        if (store?.state?.User?.userInfo?.customerNumber) {
            return store.state.User.userInfo.customerNumber;
        }
        var payRef = win.vueApp?.$refs?.payComponentRef;
        if (payRef?.userInfo?.customerNumber) {
            return payRef.userInfo.customerNumber;
        }
        var root = win.vueApp?.$root;
        if (root?.$store?.state?.User?.userInfo?.customerNumber) {
            return root.$store.state.User.userInfo.customerNumber;
        }
    } catch (e) {
        console.warn('[锁单] 获取customerId失败:', e);
    }
    return null;
}

function tryLockOrder() {
    if (lockOrderInProgress || lockOrderDone) return;
    lockOrderInProgress = true;

    var priceData = lastPreviewResult.data;
    var customerId = getCustomerId();
    if (!customerId) {
        console.warn('[锁单] 无法获取customerId，放弃锁单');
        lockOrderInProgress = false;
        return;
    }

    var payload = JSON.stringify({
        payType: 'ALI',
        productId: priceData.productId,
        customerId: customerId,
        bizId: priceData.bizId
    });

    console.log('[锁单] 发起create-sign, productId:', priceData.productId, 'bizId:', priceData.bizId);

    var signUrl = priceData.lastSubscriptionSummary ? '/api/biz/pay/product/update/sign' : '/api/biz/pay/create-sign';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', signUrl);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
        lockOrderInProgress = false;
        try {
            var resp = JSON.parse(xhr.responseText);
            console.log('[锁单] 响应:', resp.code, resp.msg || '', resp.data ? '(有data)' : '');
            if (resp.code === 200 && resp.data && resp.data.sign) {
                if (resp.data.code === '500' || resp.data.code === 500) {
                    console.log('[锁单] 已订阅该套餐');
                    lockOrderDone = true;
                    stopSuccess('已订阅该套餐');
                    return;
                }
                lockOrderDone = true;
                stopSuccess('锁单成功！');
                showPaymentQRPopup(resp.data.sign, priceData);
            } else {
                console.log('[锁单] 失败:', resp.msg || resp.code);
                onLockOrderFailed(resp.msg || 'create-sign失败');
            }
        } catch (e) {
            lockOrderInProgress = false;
            console.warn('[锁单] 解析响应失败:', e);
            onLockOrderFailed('响应解析失败');
        }
    };
    xhr.onerror = function() {
        lockOrderInProgress = false;
        console.warn('[锁单] 请求失败');
        onLockOrderFailed('网络错误');
    };
    xhr.send(payload);
}

function onLockOrderFailed(msg) {
    lockOrderDone = true;
    lockOrderInProgress = false;
    running = false;
    clearTimeout(timer);
    timer = null;
    win.__autoBuyUpdateUI && win.__autoBuyUpdateUI('锁单失败', 'paused');
    var btn = document.getElementById('auto-buy-btn');
    if (btn) btn.textContent = '锁单失败';
    win.vueApp?.$message({ message: '锁单失败：' + msg, type: 'error', duration: 3000 });
    console.log('[锁单] 失败，停止抢购:', msg);

    // 尝试打开官方二维码，用户仍可尝试扫码（页面跳转能及时发现问题）
    var payRef = win.vueApp?.$refs?.payComponentRef;
    var qrCanvas = document.querySelector('.scan-qrcode-box canvas');
    if (qrCanvas && payRef?.priceData?.thirdPartyAmount) {
        // 修改标题标注锁单已失败
        try {
            var dataUrl = qrCanvas.toDataURL('image/png');
            var amount = payRef.priceData.thirdPartyAmount;
            var productName = payRef.cardData?.productName || '';
            var newWin = window.open('', '_blank');
            if (newWin) {
                newWin.document.write(
                    '<html><head><title>锁单失败 - 支付二维码</title></head>' +
                    '<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#fff3f3;">' +
                    '<div style="text-align:center;">' +
                    '<h2 style="color:#f56c6c;">锁单失败(' + msg + ')，以下为官方二维码（可能已售罄）</h2>' +
                    '<p style="color:#e6a23c;font-size:24px;font-weight:bold;">¥' + amount + (productName ? ' - ' + productName : '') + '</p>' +
                    '<img src="' + dataUrl + '" style="width:300px;height:300px;border:1px solid #ddd;" />' +
                    '<p style="color:#999;font-size:14px;">扫码后如果提示售罄则无法支付</p>' +
                    '</div></body></html>'
                );
                newWin.document.close();
            }
        } catch (e) {
            console.warn('[锁单] 打开官方二维码失败:', e);
        }
    }
}

function showQRPopup(qrDataUrl, amount, productName, subtitle, payUrl, large) {
    var existing = document.getElementById('v1-pay-popup');
    if (existing) existing.remove();
    var existingOverlay = document.getElementById('v1-pay-overlay');
    if (existingOverlay) existingOverlay.remove();

    var qrSize = large ? 350 : 240;
    var popupWidth = large ? 490 : 440;

    var popup = document.createElement('div');
    popup.id = 'v1-pay-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
        'background:#fff;border-radius:12px;padding:28px 32px;z-index:999999;min-width:340px;max-width:' + popupWidth + 'px;' +
        'box-shadow:0 8px 30px rgba(0,0,0,0.25);text-align:center;font-family:system-ui,sans-serif;';
    popup.innerHTML =
        '<div style="font-size:18px;font-weight:600;color:#333;margin-bottom:8px;">抢购成功！请扫码支付</div>' +
        '<div style="font-size:14px;color:#666;margin-bottom:4px;">' + (productName || '') + '</div>' +
        '<div style="font-size:28px;font-weight:bold;color:#e6a23c;margin-bottom:16px;">¥' + amount + '</div>' +
        '<div style="margin-bottom:12px;"><img src="' + qrDataUrl + '" style="width:' + qrSize + 'px;height:' + qrSize + 'px;border:1px solid #eee;border-radius:8px;" /></div>' +
        '<div style="font-size:12px;color:#999;margin-bottom:8px;">' + (subtitle || '请尽快用支付宝扫码支付') + '</div>' +
        (payUrl ? '<textarea readonly onclick="this.select()" style="width:100%;max-width:360px;height:48px;font-size:11px;color:#409eff;border:1px solid #ddd;border-radius:4px;padding:4px 6px;resize:none;margin-bottom:16px;word-break:break-all;line-height:1.3;outline:none;cursor:pointer;">' + payUrl + '</textarea>' : '') +
        '<div style="display:flex;gap:10px;justify-content:center;margin-top:12px;">' +
        '<button id="v1-pay-download" style="background:#67c23a;color:#fff;border:none;border-radius:6px;' +
        'padding:8px 20px;font-size:14px;cursor:pointer;">下载二维码</button>' +
        '<button id="v1-pay-close" style="background:#409eff;color:#fff;border:none;border-radius:6px;' +
        'padding:8px 28px;font-size:14px;cursor:pointer;">关闭</button></div>';
    document.body.appendChild(popup);

    var overlay = document.createElement('div');
    overlay.id = 'v1-pay-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:999998;';
    document.body.appendChild(overlay);

    var closePopup = function () { popup.remove(); overlay.remove(); };
    document.getElementById('v1-pay-close').onclick = closePopup;
    overlay.onclick = null;

    var dlBtn = document.getElementById('v1-pay-download');
    if (dlBtn) {
        dlBtn.onclick = function () {
            var a = document.createElement('a');
            a.href = qrDataUrl;
            a.download = 'pay_qr_' + Date.now() + '.png';
            a.click();
        };
    }
}

function showPaymentQRPopup(signUrl, priceData) {
    var amount = priceData.thirdPartyAmount || priceData.payAmount;
    var productName = priceData.productName || '';

    function renderQR() {
        win.QRCode.toDataURL(signUrl, { width: 600, margin: 4, errorCorrectionLevel: 'L' }, function(err, qrDataUrl) {
            if (err) {
                console.warn('[锁单] QR生成失败:', err);
                win.vueApp?.$message({ message: 'QR生成失败', type: 'error', duration: 5000 });
                return;
            }
            // 页面内弹窗
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
                    w.document.write(
                        '<html><head><title>锁单成功 - 支付宝扫码支付</title><style>' +
                        'body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}' +
                        'img{width:350px;height:350px;border:2px solid #eee;border-radius:8px;}' +
                        'h2{color:#333;}.price{color:#e6a23c;font-size:28px;font-weight:bold;}' +
                        '.tip{color:#999;font-size:14px;margin-top:12px;}' +
                        '</style></head>' +
                        '<body><div style="text-align:center;">' +
                        '<h2>锁单成功！请用支付宝扫码</h2>' +
                        '<p class="price">&yen;' + amount + (productName ? ' - ' + productName : '') + '</p>' +
                        '<img src="' + qrDataUrl + '" />' +
                        '<p class="tip">请尽快用支付宝扫码支付</p>' +
                        '</div></body></html>'
                    );
                    w.document.close();
                }
            } catch (e) {}
            console.log('[锁单] 支付二维码已弹出');
        });
    }

    if (typeof win.QRCode !== 'undefined') {
        renderQR();
    } else {
        console.log('[锁单] QR库未就绪，等待加载...');
        var waitCount = 0;
        var waitTimer = setInterval(function() {
            waitCount++;
            if (typeof win.QRCode !== 'undefined') {
                clearInterval(waitTimer);
                renderQR();
            } else if (waitCount > 50) {
                clearInterval(waitTimer);
                console.warn('[锁单] QR库加载超时');
                win.vueApp?.$message({ message: 'QR库加载失败，请刷新重试', type: 'error', duration: 5000 });
            }
        }, 100);
    }
}

function autoPay() {
    if (!running) return;

    // 更新自动锁单开关状态
    autoLockEnabled = document.getElementById('auto-lock-check')?.checked || false;

    // 验证码处理中 或 555重试中 或 锁单中，等待
    if (captchaHandling || retryingPreview || lockOrderInProgress) {
        timer = setTimeout(autoPay, 100);
        return;
    }

    // 锁单已成功，不再继续抢购（stopSuccess已停止running）
    if (lockOrderDone) return;

    // 检查支付弹窗状态
    var payRef = win.vueApp?.$refs?.payComponentRef;
    // 成功：支付成功弹窗出现
    if (payRef?.paySuccessDialogVisible) {
        stopSuccess('抢到了！paySuccessDialogVisible=true');
        return;
    }
    // 成功：二维码已渲染（非锁单模式下走原流程）
    if (!autoLockEnabled) {
        var qrCanvas = document.querySelector('.scan-qrcode-box canvas');
        if (qrCanvas && payRef?.priceData?.thirdPartyAmount) {
            stopSuccess('抢到了！二维码已显示');
            saveAndOpenQRCode(qrCanvas, payRef);
            return;
        }
    }
    // ── 自动锁单：preview 成功后直接调 create-sign ──
    if (autoLockEnabled && lastPreviewResult && lastPreviewResult.code === 200
        && lastPreviewResult.data && !lastPreviewResult.data.soldOut) {
        win.__autoBuyUpdateUI && win.__autoBuyUpdateUI('锁单中...');
        tryLockOrder();
        timer = setTimeout(autoPay, 100);
        return;
    }
    // API 返回成功，等待二维码渲染（非锁单模式）
    if (!autoLockEnabled && lastPreviewResult && lastPreviewResult.code === 200
        && lastPreviewResult.data && !lastPreviewResult.data.soldOut
        && payRef?.payDialogVisible && payRef?.captchaVerified) {
        win.__autoBuyUpdateUI && win.__autoBuyUpdateUI('等待二维码渲染...');
        timer = setTimeout(autoPay, 100);
        return;
    }
    // 繁忙弹窗仍开着（兜底关闭，正常由 handlePreviewResponse 处理）
    if (payRef?.payDialogVisible && payRef?.isServerBusy) {
        payRef.payDialogVisible = false;
        payRef.captchaVerified = false;
        payRef.isServerBusy = false;
    }

    // 不到时间：倒计时 + 预解题
    if (!isBuyTimeReached()) {
        var secs = getSecondsToBuyTime();
        var m = Math.floor(secs / 60);
        var s = secs % 60;
        win.__autoBuyShowCountdown && win.__autoBuyShowCountdown(m + ':' + (s < 10 ? '0' : '') + s);
        win.__autoBuyUpdateUI && win.__autoBuyUpdateUI('等待' + getBuyTimeStr(), 'idle');
        // 倒计时 ≤ 30s 开始连接预热
        if (secs <= 30 && secs > 0) {
            startConnectionPreheat();
        }
        // 预解题：20s 前点击购买按钮弹出验证码
        if (secs <= 20 && secs > 0 && !captchaPreOpenAttempted && !isCaptchaVisible()) {
            captchaPreOpenAttempted = true;
            clickPagePackageTab();
            var preBuyBtns = $('button.el-button.el-tooltip.buy-btn.el-button--primary');
            var preIdx = parseInt(document.querySelector('input[name="buy-btn"]:checked')?.value) || 0;
            preBuyBtns.eq(preIdx).click();
            console.log('[预解题] 已点击购买按钮，等待验证码弹出');
        }
        // 预解题：验证码弹出后 OCR 识别 + 点击汉字（不确认）
        if (secs <= 20 && secs > 0 && isCaptchaVisible() && !captchaPreSolved && !captchaHandling) {
            preSolveCaptcha();
        }
        // 轮询加速：1s 内切 50ms 精确卡点
        var interval = secs <= 1 ? 50 : 1000;
        timer = setTimeout(autoPay, interval);
        return;
    }

    // 到点：停止预热
    stopConnectionPreheat();

    // 清除倒计时显示
    win.__autoBuyShowCountdown && win.__autoBuyShowCountdown('');
    win.__autoBuyUpdateUI && win.__autoBuyUpdateUI('抢购中');

    // ── 到点后先切换套餐 tab ──
    clickPagePackageTab();

    // ★ 预解题确认：验证码已预解，到点只需点确认
    if (captchaPreSolved && isCaptchaVisible()) {
        removePreSolveHint();
        clickCaptchaConfirm();
        lastPreviewResult = null;
        captchaPreSolved = false;
        console.log('[预解题] 到点！点击确认');
        win.__autoBuyUpdateUI && win.__autoBuyUpdateUI('确认中');
        timer = setTimeout(autoPay, 50);
        return;
    }

    // 到点后：如果验证码已弹出，优先识别；否则点击购买按钮
    if (isCaptchaVisible()) {
        handleCaptcha();
        timer = setTimeout(autoPay, 50);
        return;
    }

    var buyBtns = $('button.el-button.el-tooltip.buy-btn.el-button--primary');
    var idx = parseInt(document.querySelector('input[name="buy-btn"]:checked')?.value) || 0;
    buyBtns.eq(idx).click();
    // 重置拦截器结果，等待新一轮 API 响应
    lastPreviewResult = null;
    timer = setTimeout(autoPay, 50);
}

function scheduleNext() {
    clearTimeout(timer);
    timer = setTimeout(autoPay, 300);
}

// ==================== 启动 ====================
function init() {
    if (inCaptchaFrame) return;

    // 安装 API 拦截器（拦截 /biz/pay/preview 响应）
    setupAPIInterceptor();

    createControlPanel();
    // createCaptchaPanel(); // 去掉这个按钮，有歧义
    loadQRLibrary();
    syncServerTime();
    scheduleNext();
    // 延迟检查页面高度
    setTimeout(checkPageHeight, 100);
}

// 检查页面高度是否足够显示二维码（最低900px）
function checkPageHeight() {
    var MIN_HEIGHT = 900;
    var warned = false;

    function check() {
        var windowHeight = window.innerHeight;
        if (windowHeight < MIN_HEIGHT && !warned) {
            console.warn('[自动抢购] ⚠️ 页面高度不足900px(' + windowHeight + 'px)，二维码可能无法正常显示！');
            warned = true;
        } else if (windowHeight >= MIN_HEIGHT) {
            warned = false;
        }
    }

    // 初始检查
    check();

    // 监听窗口大小变化
    window.addEventListener('resize', check);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

})(unsafeWindow);