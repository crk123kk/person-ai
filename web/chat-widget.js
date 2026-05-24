/**
 * RAG 智能客服插件
 *
 * <script src="https://your-domain/chat-widget.js"></script>
 *
 * 功能：
 * - 右下角悬浮气泡，可拖拽移动
 * - 点击气泡打开浮动对话窗口
 * - 窗口可拖拽标题栏移动，可拖拽右下角调整大小
 * - 侧边栏模式：点击扩展按钮，窗口变为全高侧边栏
 * - 流式输出、本地记录、自动绑定知识库
 */

(function () {
  'use strict';

  var currentScript = document.currentScript || document.querySelector('script[src*="chat-widget"]');
  var scriptSrc = currentScript ? currentScript.src : '';
  var serverUrl = '';
  try { if (scriptSrc) serverUrl = new URL(scriptSrc).origin; } catch {}

  var dataset = currentScript ? currentScript.dataset : {};
  var config = {
    serverUrl: dataset.serverUrl || serverUrl || window.location.origin,
    kbId: dataset.kbId || '',
    title: dataset.title || '国际站运营助手',
    welcome: dataset.welcome || '你好，我是阿里国际站运营知识库助手。你可以向我提问阿里国际站相关问题，我会优先基于已整理的本地知识库进行回答。如果当前知识库暂未覆盖你的问题，我会将该问题记录为待补充内容，并在后续统一整理更新。知识库更新后，你可以再次提问获取更完整的答案。',
    placeholder: dataset.placeholder || '输入你的问题...',
    primaryColor: dataset.primaryColor || '#4f46e5',
    avatar: dataset.avatar || '',
  };

  // ===== Storage helpers =====
  var SP = 'rag_cw_';
  function sk(k) { return SP + (config.kbId || 'widget') + '_' + k; }
  function loadJ(k, d) { try { var v = localStorage.getItem(sk(k)); return v ? JSON.parse(v) : d; } catch { return d; } }
  function saveJ(k, v) { try { localStorage.setItem(sk(k), JSON.stringify(v)); } catch {} }
  function loadS(k) { try { return localStorage.getItem(sk(k)) || ''; } catch { return ''; } }
  function saveS(k, v) { try { localStorage.setItem(sk(k), v); } catch {} }

  // ===== Util =====
  function esc(t) { var d = document.createElement('div'); d.appendChild(document.createTextNode(t)); return d.innerHTML; }
  function fmtTime(d) { var dt = new Date(d); return dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0'); }

  function renderMD(text) {
    var h = esc(text);
    h = h.replace(/```(\w*)\n([\s\S]*?)```/g, function(_,l,c){ return '<pre class="rag-cw-pre"><code class="rag-cw-code">'+c.trim()+'</code></pre>'; });
    h = h.replace(/`([^`]+)`/g, '<code class="rag-cw-inline-code">$1</code>');
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
    h = h.replace(/^### (.+)$/gm, '<h4 class="rag-cw-h">$1</h4>');
    h = h.replace(/^## (.+)$/gm, '<h4 class="rag-cw-h">$1</h4>');
    h = h.replace(/^# (.+)$/gm, '<h4 class="rag-cw-h">$1</h4>');
    h = h.replace(/^\- (.+)$/gm, '<li>$1</li>');
    h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  // ===== CSS =====
  var C = config.primaryColor;
  var styleEl = document.createElement('style');
  styleEl.textContent = [
    '.rag-cw-bubble{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:'+C+';color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:999999;transition:box-shadow .2s;user-select:none;touch-action:none}',
    '.rag-cw-bubble:hover{box-shadow:0 6px 24px rgba(0,0,0,.3)}',
    '.rag-cw-bubble.dragging{cursor:grabbing;opacity:.85}',
    '.rag-cw-bubble svg{width:28px;height:28px;pointer-events:none}',
    '.rag-cw-badge{position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;font-size:11px;display:none;align-items:center;justify-content:center}',

    '.rag-cw-window{position:fixed;right:24px;bottom:92px;width:400px;height:560px;min-width:320px;min-height:400px;max-width:700px;border-radius:16px;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,.15);display:none;flex-direction:column;z-index:999998;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;color:#1f2937}',
    '.rag-cw-window.open{display:flex;animation:rag-cw-up .25s ease}',
    '.rag-cw-window.docked{right:0!important;bottom:0!important;top:0!important;left:auto!important;border-radius:0;height:100vh!important;max-height:100vh;min-height:100vh;width:800px!important}',
    '@keyframes rag-cw-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}',

    '.rag-cw-header{background:'+C+';color:#fff;padding:12px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0;cursor:move;user-select:none}',
    '.rag-cw-header-avatar{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden}',
    '.rag-cw-header-avatar img{width:100%;height:100%;object-fit:cover}',
    '.rag-cw-header-title{flex:1;font-weight:600;font-size:15px}',
    '.rag-cw-header-actions{display:flex;gap:6px}',
    '.rag-cw-header-btn{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.2);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}',
    '.rag-cw-header-btn:hover{background:rgba(255,255,255,.4)}',
    '.rag-cw-header-btn svg{width:16px;height:16px}',

    '.rag-cw-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:#f9fafb}',
    '.rag-cw-messages::-webkit-scrollbar{width:4px}',
    '.rag-cw-messages::-webkit-scrollbar-track{background:transparent}',
    '.rag-cw-messages::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:4px}',

    '.rag-cw-msg{display:flex;gap:8px;max-width:88%}',
    '.rag-cw-msg.user{align-self:flex-end;flex-direction:row-reverse}',
    '.rag-cw-msg-avatar{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px}',
    '.rag-cw-msg.bot .rag-cw-msg-avatar{background:'+C+'18;color:'+C+'}',
    '.rag-cw-msg.user .rag-cw-msg-avatar{background:#e5e7eb;color:#6b7280}',
    '.rag-cw-msg-content{padding:10px 14px;border-radius:12px;line-height:1.6;word-break:break-word}',
    '.rag-cw-msg.bot .rag-cw-msg-content{background:#fff;border:1px solid #e5e7eb;border-top-left-radius:4px}',
    '.rag-cw-msg.user .rag-cw-msg-content{background:'+C+';color:#fff;border-top-right-radius:4px}',
    '.rag-cw-msg-time{font-size:11px;color:#9ca3af;margin-top:4px}',
    '.rag-cw-msg.user .rag-cw-msg-time{text-align:right}',

    '.rag-cw-h{margin:8px 0 4px;font-size:14px;font-weight:600}',
    '.rag-cw-pre{background:#1e293b;color:#e2e8f0;padding:10px 12px;border-radius:8px;overflow-x:auto;margin:6px 0;font-size:13px}',
    '.rag-cw-code{font-family:"Fira Code",Consolas,monospace}',
    '.rag-cw-inline-code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:13px;font-family:"Fira Code",Consolas,monospace;color:#e11d48}',
    '.rag-cw-msg-content li{margin-left:16px;margin-bottom:2px}',

    '.rag-cw-input-area{padding:12px 16px;border-top:1px solid #e5e7eb;background:#fff;display:flex;gap:8px;flex-shrink:0}',
    '.rag-cw-input{flex:1;border:1px solid #d1d5db;border-radius:20px;padding:8px 16px;font-size:14px;outline:none;transition:border-color .2s;font-family:inherit;resize:none;min-height:38px;max-height:80px;line-height:1.4}',
    '.rag-cw-input:focus{border-color:'+C+'}',
    '.rag-cw-input::placeholder{color:#9ca3af}',
    '.rag-cw-send{width:38px;height:38px;border-radius:50%;background:'+C+';color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity .2s,transform .15s;flex-shrink:0}',
    '.rag-cw-send:hover{opacity:.9}',
    '.rag-cw-send:active{transform:scale(.95)}',
    '.rag-cw-send:disabled{opacity:.5;cursor:not-allowed}',
    '.rag-cw-send svg{width:18px;height:18px}',
    '.rag-cw-thinking-text{color:#6b7280;font-style:italic;font-size:13px}',
    '.rag-cw-error{color:#ef4444;font-size:13px}',
    '.rag-cw-status{color:#9ca3af;font-size:12px;text-align:center;padding:8px}',

    '.rag-cw-resize{position:absolute;bottom:0;right:0;width:20px;height:20px;cursor:nwse-resize;z-index:10}',
    '.rag-cw-resize::after{content:"";position:absolute;bottom:4px;right:4px;width:8px;height:8px;border-right:2px solid #c0c0c0;border-bottom:2px solid #c0c0c0;opacity:.5;transition:opacity .15s}',
    '.rag-cw-resize:hover::after{opacity:1}',
    '.rag-cw-window.docked .rag-cw-resize{display:block;left:0;right:auto;top:0;width:6px;height:100%;cursor:ew-resize;background:transparent;transition:background .2s;z-index:11}',
    '.rag-cw-window.docked .rag-cw-resize:hover{background:rgba(59,130,246,.15)}',
    '.rag-cw-window.docked .rag-cw-resize::after{content:"";position:absolute;top:50%;left:1px;width:2px;height:40px;transform:translateY(-50%);border-radius:1px;background:#c0c0c0;transition:background .2s,height .2s}',
    '.rag-cw-window.docked .rag-cw-resize:hover::after{background:'+C+';height:60px}',
    '.rag-cw-sources{margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb}',
    '.rag-cw-sources-title{font-size:11px;color:#9ca3af;margin-bottom:4px}',
    '.rag-cw-source-item{font-size:12px;color:#6b7280;padding:2px 0;display:flex;align-items:center;gap:4px;line-height:1.4}',
    '.rag-cw-source-dot{width:4px;height:4px;border-radius:50%;background:'+C+';flex-shrink:0}',
    '.rag-cw-source-link{color:'+C+';text-decoration:none;word-break:break-all}',
    '.rag-cw-source-link:hover{text-decoration:underline}',
  ].join('\n');
  document.head.appendChild(styleEl);

  // ===== DOM =====
  var bubble = document.createElement('div');
  bubble.className = 'rag-cw-bubble';
  bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><div class="rag-cw-badge" id="ragCwBadge">1</div>';

  var win = document.createElement('div');
  win.className = 'rag-cw-window';
  win.id = 'ragCwWindow';

  var avHtml = config.avatar ? '<img src="'+esc(config.avatar)+'" alt="avatar">' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';

  // Expand icon (sidebar)
  var expandSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  // Collapse icon (back to window)
  var collapseSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  win.innerHTML = [
    '<div class="rag-cw-header" id="ragCwHeader">',
    '  <div class="rag-cw-header-avatar">'+avHtml+'</div>',
    '  <div class="rag-cw-header-title">'+esc(config.title)+'</div>',
    '  <div class="rag-cw-header-actions">',
    '    <button class="rag-cw-header-btn" id="ragCwDockBtn" title="展开为侧边栏">'+expandSvg+'</button>',
    '    <button class="rag-cw-header-btn" id="ragCwClearBtn" title="清空记录"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>',
    '    <button class="rag-cw-header-btn" id="ragCwCloseBtn" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>',
    '  </div>',
    '</div>',
    '<div class="rag-cw-messages" id="ragCwMessages"></div>',
    '<div class="rag-cw-input-area">',
    '  <textarea class="rag-cw-input" id="ragCwInput" placeholder="'+esc(config.placeholder)+'" rows="1"></textarea>',
    '  <button class="rag-cw-send" id="ragCwSendBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>',
    '</div>',
    '<div class="rag-cw-resize" id="ragCwResize"></div>',
  ].join('');

  document.body.appendChild(bubble);
  document.body.appendChild(win);

  // ===== Refs =====
  var messagesEl = document.getElementById('ragCwMessages');
  var inputEl = document.getElementById('ragCwInput');
  var sendBtn = document.getElementById('ragCwSendBtn');
  var closeBtn = document.getElementById('ragCwCloseBtn');
  var clearBtn = document.getElementById('ragCwClearBtn');
  var dockBtn = document.getElementById('ragCwDockBtn');
  var badge = document.getElementById('ragCwBadge');
  var resizeHandle = document.getElementById('ragCwResize');
  var headerEl = document.getElementById('ragCwHeader');

  // ===== State =====
  var isOpen = false;
  var isDocked = false;
  var isStreaming = false;
  var messages = [];
  var currentAbort = null;
  var kbReady = false;

  // ===== Restore saved size =====
  var ss = loadJ('size', null);
  if (ss) { win.style.width = ss.w + 'px'; win.style.height = ss.h + 'px'; }

  // ===== Bubble drag =====
  var bDrag = false, bMoved = false, bSX, bSY, bSL, bST;

  bubble.addEventListener('pointerdown', function(e) {
    e.preventDefault();
    bDrag = true; bMoved = false;
    bubble.classList.add('dragging');
    bubble.setPointerCapture(e.pointerId);
    var r = bubble.getBoundingClientRect();
    bSX = e.clientX; bSY = e.clientY; bSL = r.left; bST = r.top;
    document.body.style.userSelect = 'none';
  });

  bubble.addEventListener('pointermove', function(e) {
    if (!bDrag) return;
    var dx = e.clientX - bSX, dy = e.clientY - bSY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) bMoved = true;
    var nl = Math.max(0, Math.min(window.innerWidth - 56, bSL + dx));
    var nt = Math.max(0, Math.min(window.innerHeight - 56, bST + dy));
    bubble.style.left = nl + 'px'; bubble.style.top = nt + 'px';
    bubble.style.right = 'auto'; bubble.style.bottom = 'auto';
  });

  bubble.addEventListener('pointerup', function(e) {
    if (!bDrag) return;
    bDrag = false;
    bubble.classList.remove('dragging');
    bubble.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = '';
    var r = bubble.getBoundingClientRect();
    saveJ('bubble_pos', { x: r.left, y: r.top });
    // If not dragged, treat as click
    if (!bMoved) openWindow();
  });

  // Restore bubble position
  var bp = loadJ('bubble_pos', null);
  if (bp) { bubble.style.left = bp.x + 'px'; bubble.style.top = bp.y + 'px'; bubble.style.right = 'auto'; bubble.style.bottom = 'auto'; }

  // ===== Window drag (header) =====
  var wDrag = false, wMoved = false, wSX, wSY, wSL, wST;

  headerEl.addEventListener('pointerdown', function(e) {
    if (e.target.closest('.rag-cw-header-btn') || isDocked) return;
    e.preventDefault();
    wDrag = true; wMoved = false;
    headerEl.setPointerCapture(e.pointerId);
    var r = win.getBoundingClientRect();
    wSX = e.clientX; wSY = e.clientY; wSL = r.left; wST = r.top;
    document.body.style.userSelect = 'none';
  });

  headerEl.addEventListener('pointermove', function(e) {
    if (!wDrag) return;
    var dx = e.clientX - wSX, dy = e.clientY - wSY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wMoved = true;
    var nl = Math.max(0, Math.min(window.innerWidth - win.offsetWidth, wSL + dx));
    var nt = Math.max(0, Math.min(window.innerHeight - 60, wST + dy));
    win.style.left = nl + 'px'; win.style.top = nt + 'px';
    win.style.right = 'auto'; win.style.bottom = 'auto';
  });

  headerEl.addEventListener('pointerup', function(e) {
    if (!wDrag) return;
    wDrag = false;
    headerEl.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = '';
    var r = win.getBoundingClientRect();
    saveJ('win_pos', { x: r.left, y: r.top });
  });

  // ===== Resize =====
  var rDrag = false, rSX, rSY, rSW, rSH;

  resizeHandle.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    rDrag = true;
    resizeHandle.setPointerCapture(e.pointerId);
    rSX = e.clientX; rSY = e.clientY;
    rSW = win.offsetWidth; rSH = win.offsetHeight;
    document.body.style.userSelect = 'none';
  });

  resizeHandle.addEventListener('pointermove', function(e) {
    if (!rDrag) return;
    var dx = e.clientX - rSX, dy = e.clientY - rSY;
    if (isDocked) {
      // Docked: drag left edge — leftward = wider, rightward = narrower
      var nw = Math.min(1200, Math.max(400, rSW - dx));
      win.style.width = nw + 'px';
    } else {
      var nw = Math.min(700, Math.max(320, rSW + dx));
      var nh = Math.min(window.innerHeight - 40, Math.max(400, rSH + dy));
      win.style.width = nw + 'px'; win.style.height = nh + 'px';
    }
  });

  resizeHandle.addEventListener('pointerup', function(e) {
    if (!rDrag) return;
    rDrag = false;
    resizeHandle.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = '';
    if (isDocked) {
      saveJ('docked_size', { w: win.offsetWidth });
    } else {
      saveJ('size', { w: win.offsetWidth, h: win.offsetHeight });
    }
  });

  // ===== Dock / Undock =====
  dockBtn.addEventListener('click', function() {
    isDocked = !isDocked;
    if (isDocked) {
      // Save current position before docking
      var r = win.getBoundingClientRect();
      saveJ('win_pos', { x: r.left, y: r.top });
      saveJ('size', { w: win.offsetWidth, h: win.offsetHeight });

      win.classList.add('docked');
      win.style.left = 'auto';
      // Clear inline positioning so CSS .docked rules apply
      win.style.top = ''; win.style.bottom = ''; win.style.right = '';
      var dw = loadJ('docked_size', null);
      if (dw) { win.style.width = dw.w + 'px'; }
      dockBtn.innerHTML = collapseSvg;
      dockBtn.title = '还原为窗口';
    } else {
      win.classList.remove('docked');
      // Restore saved position
      var sp = loadJ('win_pos', null);
      var ss2 = loadJ('size', null);
      if (sp) { win.style.left = sp.x + 'px'; win.style.top = sp.y + 'px'; win.style.right = 'auto'; win.style.bottom = 'auto'; }
      if (ss2) { win.style.width = ss2.w + 'px'; win.style.height = ss2.h + 'px'; }
      dockBtn.innerHTML = expandSvg;
      dockBtn.title = '展开为侧边栏';
    }
    saveJ('docked', isDocked);
  });

  // Restore dock state
  if (loadJ('docked', false)) {
    isDocked = true;
    win.classList.add('docked');
    win.style.left = 'auto'; win.style.top = ''; win.style.bottom = ''; win.style.right = '';
    var dw2 = loadJ('docked_size', null);
    if (dw2) { win.style.width = dw2.w + 'px'; }
    dockBtn.innerHTML = collapseSvg;
    dockBtn.title = '还原为窗口';
  }

  // ===== Open / Close =====
  function openWindow() {
    isOpen = true;
    win.classList.add('open');
    bubble.style.display = 'none';
    badge.style.display = 'none';

    // Restore saved position, or let CSS defaults handle positioning
    if (!isDocked) {
      var sp = loadJ('win_pos', null);
      if (sp) {
        win.style.left = sp.x + 'px'; win.style.top = sp.y + 'px';
        win.style.right = 'auto'; win.style.bottom = 'auto';
      } else {
        // Clear any leftover inline positioning so CSS defaults apply
        win.style.left = ''; win.style.top = '';
        win.style.right = ''; win.style.bottom = '';
      }
    }

    ensureKbId().then(function() { renderMessages(); inputEl.focus(); });
  }

  closeBtn.addEventListener('click', function() {
    isOpen = false;
    isDocked = false;
    win.classList.remove('open');
    win.classList.remove('docked');
    bubble.style.display = 'flex';
    dockBtn.innerHTML = expandSvg;
    dockBtn.title = '展开为侧边栏';
    saveJ('docked', false);
  });

  // ===== KB =====
  function ensureKbId() {
    if (config.kbId) {
      return fetch(config.serverUrl + '/api/kb', { headers: {'Content-Type':'application/json'} })
      .then(function(r){return r.json();})
      .then(function(d){ if((d.knowledgeBases||[]).find(function(k){return k.id===config.kbId;})){kbReady=true;return;} return fetchWidgetKb(); })
      .catch(fetchWidgetKb);
    }
    return fetchWidgetKb();
  }

  function fetchWidgetKb() {
    return fetch(config.serverUrl + '/api/widget/kb', { headers: {'Content-Type':'application/json'} })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(d){ config.kbId=d.kbId; messages=[]; kbReady=true; })
    .catch(function(){ showErr('无法连接服务器，请检查服务是否启动'); });
  }

  // ===== Render =====
  var botIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
  var usrIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

  function renderMessages() {
    messagesEl.innerHTML = '';
    if (!messages.length) {
      var d = document.createElement('div'); d.className = 'rag-cw-msg bot';
      d.innerHTML = '<div class="rag-cw-msg-avatar">'+botIco+'</div><div><div class="rag-cw-msg-content">'+esc(config.welcome)+'</div><div class="rag-cw-msg-time">'+fmtTime(new Date())+'</div></div>';
      messagesEl.appendChild(d); return;
    }
    for (var i=0;i<messages.length;i++) appendMsg(messages[i]);
    scrB();
  }

  function appendMsg(m) {
    var d = document.createElement('div'); d.className = 'rag-cw-msg '+m.role;
    var ico = m.role==='user'?usrIco:botIco;
    var cnt = m.role==='bot'?renderMD(m.content):esc(m.content);
    var srcHtml = '';
    if (false) {
      srcHtml = '<div class="rag-cw-sources"><div class="rag-cw-sources-title">参考来源</div>';
      for (var si = 0; si < m.sources.length; si++) {
        var s = m.sources[si];
        var meta = s.metadata || {};
        var name = meta.displayName || s.fileName || meta.title || '未知来源';
        var url = meta.source || s.url || '';
        var link = url ? '<a class="rag-cw-source-link" href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(name)+'</a>' : esc(name);
        var score = s.score ? (' <span style="color:#b0b0b0;font-size:11px">'+Math.round(s.score*100)+'%</span>') : '';
        srcHtml += '<div class="rag-cw-source-item"><span class="rag-cw-source-dot"></span>'+link+score+'</div>';
      }
      srcHtml += '</div>';
    }
    d.innerHTML = '<div class="rag-cw-msg-avatar">'+ico+'</div><div><div class="rag-cw-msg-content">'+cnt+srcHtml+'</div><div class="rag-cw-msg-time">'+fmtTime(m.time)+'</div></div>';
    messagesEl.appendChild(d);
  }

  function showErr(t) { var d=document.createElement('div'); d.className='rag-cw-status rag-cw-error'; d.textContent=t; messagesEl.appendChild(d); scrB(); }
  function scrB() { requestAnimationFrame(function(){ messagesEl.scrollTop=messagesEl.scrollHeight; }); }

  // ===== Chat =====
  function sendMsg() {
    var t = inputEl.value.trim();
    if (!t || isStreaming) return;
    inputEl.value = ''; inputEl.style.height = 'auto';
    var um = {role:'user',content:t,time:new Date().toISOString()};
    messages.push(um); appendMsg(um); scrB();
    if (!kbReady) { ensureKbId().then(function(){if(kbReady)doChat(t);}); return; }
    doChat(t);
  }

  function doChat(q) {
    var td=document.createElement('div'); td.className='rag-cw-msg bot'; td.id='ragCwThinking';
    td.innerHTML='<div class="rag-cw-msg-avatar">'+botIco+'</div><div><div class="rag-cw-msg-content"><span class="rag-cw-thinking-text" id="ragCwThinkingText">正在思考...</span><div id="ragCwStreamContent"></div></div></div>';
    messagesEl.appendChild(td); scrB();
    isStreaming=true; sendBtn.disabled=true;

    var sid=loadS('session');
    var url=config.serverUrl+'/api/'+encodeURIComponent(config.kbId)+'/chat/stream';
    currentAbort=new AbortController();

    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q,sessionId:sid}),signal:currentAbort.signal})
    .then(function(res){
      if(!res.ok) return res.text().then(function(b){var m='服务器错误('+res.status+')';try{var p=JSON.parse(b);if(p.error)m=p.error;}catch{}throw new Error(m);});
      var reader=res.body.getReader(),dec=new TextDecoder('utf-8'),buf='',bot='',sources=[];
      var thEl=document.getElementById('ragCwThinkingText'),stEl=document.getElementById('ragCwStreamContent');
      function proc(){
        return reader.read().then(function(r){
          if(r.done){fin(bot,sources);return;}
          buf+=dec.decode(r.value,{stream:true});var ls=buf.split('\n');buf=ls.pop();
          for(var i=0;i<ls.length;i++){
            var ln=ls[i].trim();if(!ln||!ln.startsWith('data: '))continue;
            try{
              var d=JSON.parse(ln.slice(6));
              if(d.type==='thinking'){if(thEl)thEl.textContent=d.message||'正在思考...';}
              else if(d.type==='content'){
                if(thEl&&thEl.parentNode){thEl.remove();thEl=null;}
                if(d.content){bot+=d.content;if(stEl)stEl.innerHTML=renderMD(bot);scrB();}
                if(d.sessionId)saveS('session',d.sessionId);
                if(d.sources&&d.sources.length){sources=d.sources;}
              }else if(d.type==='done'){if(d.sessionId)saveS('session',d.sessionId);fin(bot,sources);return;}
              else if(d.type==='error'){fin(bot||('出错了：'+(d.error||'未知错误')),[]);return;}
            }catch{}
          }
          return proc();
        });
      }
      return proc();
    })
    .catch(function(e){if(e.name==='AbortError')return;handleChatError(e,q);});
  }

  function handleChatError(e, q) {
    isStreaming = false; sendBtn.disabled = false; currentAbort = null;
    var td = document.getElementById('ragCwThinking'); if (td) td.remove();
    var msg = e.message || '';
    // KB was deleted — auto rebind and retry
    if (msg.indexOf('知识库不存在') !== -1) {
      kbReady = false;
      config.kbId = '';
      saveS('session', '');
      showStatus('知识库已更新，正在重新绑定...');
      fetchWidgetKb().then(function() {
        removeLastUserMsg();
        doChat(q);
      }).catch(function() {
        showErr('知识库绑定失败，请刷新页面重试');
      });
      return;
    }
    showErr('无法连接服务器，请检查网络或服务是否启动。');
  }

  function removeLastUserMsg() {
    // Remove the last user message bubble and the thinking bubble from display
    var last = messages.pop(); // pop the user message we just added
    if (last && last.role !== 'user') messages.push(last);
    renderMessages();
  }

  function showStatus(t) {
    var d = document.createElement('div'); d.className = 'rag-cw-status'; d.textContent = t;
    messagesEl.appendChild(d); scrB();
  }

  function fin(content,sources){
    isStreaming=false;sendBtn.disabled=false;currentAbort=null;
    var td=document.getElementById('ragCwThinking');if(td)td.remove();
    if(content){
      var bm={role:'bot',content:content,time:new Date().toISOString(),sources:sources||[]};
      messages.push(bm);appendMsg(bm);scrB();
    }
    if(!isOpen){badge.style.display='flex';badge.textContent='1';}
  }

  // ===== Events =====
  clearBtn.addEventListener('click',function(){if(isStreaming)return;messages=[];localStorage.removeItem(sk('session'));renderMessages();});
  sendBtn.addEventListener('click',sendMsg);
  inputEl.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
  inputEl.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,80)+'px';});

  renderMessages();
})();
