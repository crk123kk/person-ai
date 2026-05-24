/**
 * RAG Assistant - Multi knowledge base frontend
 */

let currentKbId = '';
let currentSessionId = '';
let isLoading = false;
let modelLoaded = false;
let sessionsData = [];
let kbList = [];
let currentAbortController = null;
let chatRequestId = 0;
const uploadStates = new Map(); // kbId -> { eventSource, latestProgress }

// Init
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSidebarResize();
  loadKnowledgeBases();
  checkModelStatus();
});

/* ===== Sidebar Resize ===== */

function initSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebarResizeHandle');
  if (!sidebar || !handle) return;

  // 恢复保存的宽度
  const saved = localStorage.getItem('sidebarWidth');
  if (saved) {
    const w = parseInt(saved);
    if (w >= 200 && w <= 480) {
      sidebar.style.setProperty('--sidebar-width', w + 'px');
    }
  }

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', function(e) {
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.min(480, Math.max(200, startWidth + delta));
    sidebar.style.setProperty('--sidebar-width', newWidth + 'px');
  });

  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const width = sidebar.offsetWidth;
    if (width >= 200 && width <= 480) {
      localStorage.setItem('sidebarWidth', width);
    }
  });
}

/* ===== Theme ===== */

/* ===== Theme ===== */

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    updateThemeUI(true);
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }
  updateThemeUI(!isDark);
}

function updateThemeUI(isDark) {
  const lightIcon = document.getElementById('themeIconLight');
  const darkIcon = document.getElementById('themeIconDark');
  const label = document.getElementById('themeLabel');
  if (isDark) {
    lightIcon.style.display = 'none';
    darkIcon.style.display = 'block';
    label.textContent = '白天模式';
  } else {
    lightIcon.style.display = 'block';
    darkIcon.style.display = 'none';
    label.textContent = '暗夜模式';
  }
}

/* ===== Knowledge Base Management ===== */

async function loadKnowledgeBases() {
  try {
    const response = await fetch('/api/kb');
    const data = await response.json();
    kbList = data.knowledgeBases || [];

    // Auto-select first KB or restore saved
    const savedKb = localStorage.getItem('currentKbId');
    if (savedKb && kbList.find(kb => kb.id === savedKb)) {
      currentKbId = savedKb;
    } else if (kbList.length > 0) {
      currentKbId = kbList[0].id;
    }

    renderKbList();
    if (currentKbId) {
      loadSessions();
      loadDocs();
      loadWebsites();
    }
  } catch (error) {
    console.error('Failed to load knowledge bases:', error);
  }
}

function renderKbList() {
  const countEl = document.getElementById('kbCount');
  const listEl = document.getElementById('kbListItems');
  if (countEl) countEl.textContent = kbList.length;

  if (kbList.length === 0) {
    listEl.innerHTML = '<div style="padding: 8px 12px 8px 28px; font-size: 0.75rem; color: var(--text-muted);">暂无知识库</div>';
    return;
  }

  let html = '';
  for (const kb of kbList) {
    const isActive = kb.id === currentKbId;
    html += `
      <div class="kb-list-item ${isActive ? 'active' : ''}" onclick="selectKb('${kb.id}')">
        <span class="kb-item-name">${escapeHtml(kb.name)}</span>
        <button class="kb-item-delete" onclick="event.stopPropagation(); deleteKb('${kb.id}')" title="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;
  }
  listEl.innerHTML = html;
}

function toggleKbList() {
  const header = document.querySelector('.kb-list-header');
  const list = document.getElementById('kbListItems');
  header.classList.toggle('collapsed');
  list.classList.toggle('collapsed');
}

function showUploadProgressForKb(kbId) {
  const state = uploadStates.get(kbId);
  const progressContainer = document.getElementById('uploadProgress');
  if (state && state.latestProgress) {
    progressContainer.classList.add('active');
    updateProgressUI(state.latestProgress);
  } else {
    progressContainer.classList.remove('active');
  }
}

function updateProgressUI(progress) {
  document.getElementById('uploadProgressFill').style.width = `${progress.overallProgress}%`;
  document.getElementById('uploadProgressPercent').textContent = `${progress.overallProgress}%`;
  const currentStage = progress.stages.find(function(s) { return s.status === 'processing'; }) ||
                       progress.stages.find(function(s) { return s.status === 'pending'; });
  if (currentStage) document.getElementById('uploadProgressStage').textContent = currentStage.message || currentStage.name;
}

async function selectKb(kbId) {
  showUploadProgressForKb(kbId);

  currentKbId = kbId;
  currentSessionId = '';
  localStorage.setItem('currentKbId', kbId);

  renderKbList();
  showWelcomeScreen();
  loadSessions();
  loadDocs();
  loadWebsites();
}

async function createKb() {
  const name = prompt('输入知识库名称：');
  if (!name || !name.trim()) return;

  try {
    const response = await fetch('/api/kb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    const kb = await response.json();

    if (kb.id) {
      currentKbId = kb.id;
      localStorage.setItem('currentKbId', kb.id);
      await loadKnowledgeBases();
      showWelcomeScreen();
      showNotification(`知识库「${name}」已创建`, 'success');
    }
  } catch (error) {
    showNotification('创建知识库失败', 'error');
  }
}

async function deleteKb(kbId) {
  const kb = kbList.find(k => k.id === kbId);
  if (!confirm(`确定要删除知识库「${kb?.name || kbId}」吗？所有文档和对话将被删除。`)) return;

  try {
    await fetch(`/api/kb/${kbId}`, { method: 'DELETE' });

    if (currentKbId === kbId) {
      currentKbId = '';
      currentSessionId = '';
    }

    await loadKnowledgeBases();

    if (!currentKbId && kbList.length > 0) {
      currentKbId = kbList[0].id;
      localStorage.setItem('currentKbId', currentKbId);
      renderKbList();
    }

    showWelcomeScreen();
    loadSessions();
    showNotification('知识库已删除', 'success');
  } catch (error) {
    showNotification('删除失败', 'error');
  }
}

/* ===== KB Websites Panel ===== */

function toggleWebsitesPanel() {
  const header = document.getElementById('kbWebsitesHeader');
  const list = document.getElementById('kbWebsitesList');
  header.classList.toggle('collapsed');
  list.classList.toggle('collapsed');
}

function toggleWebsiteExpand(idx) {
  const pagesEl = document.getElementById('ws-pages-' + idx);
  const arrowEl = document.getElementById('ws-arrow-' + idx);
  if (pagesEl) pagesEl.classList.toggle('collapsed');
  if (arrowEl) arrowEl.classList.toggle('expanded');
}

async function loadWebsites() {
  if (!currentKbId) {
    document.getElementById('kbWebsitesCount').textContent = '0';
    document.getElementById('kbWebsitesList').innerHTML = '<div class="kb-websites-empty">暂无网站</div>';
    return;
  }

  try {
    const response = await fetch(`/api/${currentKbId}/websites`);
    const data = await response.json();
    const websites = data.websites || [];

    document.getElementById('kbWebsitesCount').textContent = websites.length;

    if (websites.length === 0) {
      document.getElementById('kbWebsitesList').innerHTML = '<div class="kb-websites-empty">暂无网站</div>';
      return;
    }

    let html = '';
    for (let i = 0; i < websites.length; i++) {
      const site = websites[i];
      const displayUrl = escapeHtml(site.url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
      const safeUrl = encodeURIComponent(site.url);
      const pages = site.pages || [];

      html += `
        <div class="kb-website-item" onclick="toggleWebsiteExpand(${i})">
          <svg class="website-expand-arrow" id="ws-arrow-${i}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <polyline points="9 6 15 12 9 18"></polyline>
          </svg>
          <span class="website-url" title="${escapeHtml(site.url)}">${displayUrl}</span>
          <span class="website-chunks">${site.chunks} 块</span>
          <button class="website-delete-btn" onclick="event.stopPropagation(); deleteWebsite('${safeUrl}')" title="删除网站">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="website-pages collapsed" id="ws-pages-${i}">
      `;

      for (const page of pages) {
        const pageTitle = escapeHtml(page.title || page.url.split('/').filter(Boolean).pop() || page.url);
        html += `
          <div class="website-page-item" title="${escapeHtml(page.url)}">
            <span class="page-title">${pageTitle}</span>
            <span class="page-chunks">${page.chunks}</span>
          </div>
        `;
      }

      if (pages.length === 0) {
        html += '<div class="website-page-empty">暂无页面</div>';
      }

      html += '</div>';
    }
    document.getElementById('kbWebsitesList').innerHTML = html;
  } catch (error) {
    console.error('Failed to load websites:', error);
  }
}

async function deleteWebsite(url) {
  if (!currentKbId) return;
  const displayUrl = decodeURIComponent(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!confirm(`确定要从知识库中删除网站「${displayUrl}」吗？`)) return;

  try {
    const response = await fetch(`/api/${currentKbId}/websites?url=${url}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('删除失败');
    showNotification(`已删除「${displayUrl}」`, 'success');
    loadWebsites();
  } catch (error) {
    showNotification(`删除失败：${error.message}`, 'error');
  }
}

/* ===== KB Documents Panel ===== */

function toggleDocsPanel() {
  const header = document.getElementById('kbDocsHeader');
  const list = document.getElementById('kbDocsList');
  header.classList.toggle('collapsed');
  list.classList.toggle('collapsed');
}

function toggleConversationList() {
  const header = document.getElementById('conversationHeader');
  const list = document.getElementById('conversationList');
  header.classList.toggle('collapsed');
  list.classList.toggle('collapsed');
}

async function loadDocs() {
  if (!currentKbId) {
    document.getElementById('kbDocsCount').textContent = '0';
    document.getElementById('kbDocsList').innerHTML = '<div class="kb-docs-empty">暂无文档</div>';
    return;
  }

  try {
    const response = await fetch(`/api/${currentKbId}/documents`);
    const data = await response.json();
    const docs = data.documents || [];

    document.getElementById('kbDocsCount').textContent = docs.length;

    if (docs.length === 0) {
      document.getElementById('kbDocsList').innerHTML = '<div class="kb-docs-empty">暂无文档</div>';
      return;
    }

    let html = '';
    for (const doc of docs) {
      const name = escapeHtml(doc.displayName || doc.source);
      const safeSource = encodeURIComponent(doc.source);
      html += `
        <div class="kb-doc-item">
          <span class="doc-name" title="${name}">${name}</span>
          <span class="doc-chunks">${doc.chunks} 块</span>
          <button class="doc-delete-btn" onclick="event.stopPropagation(); deleteDocument('${safeSource}')" title="删除文档">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `;
    }
    document.getElementById('kbDocsList').innerHTML = html;
  } catch (error) {
    console.error('Failed to load docs:', error);
  }
}

async function deleteDocument(source) {
  if (!currentKbId) return;
  const name = decodeURIComponent(source).split(/[\\/]/).pop() || source;
  if (!confirm(`确定要从知识库中删除「${name}」吗？`)) return;

  try {
    const response = await fetch(`/api/${currentKbId}/documents?source=${source}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('删除失败');
    showNotification(`已删除「${name}」`, 'success');
    loadDocs();
  } catch (error) {
    showNotification(`删除失败：${error.message}`, 'error');
  }
}

/* ===== Sidebar ===== */

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

async function loadSessions() {
  if (!currentKbId) return;

  try {
    const response = await fetch(`/api/${currentKbId}/sessions`);
    const data = await response.json();
    sessionsData = data.sessions || [];

    const titles = await Promise.all(
      sessionsData.map(async (session) => {
        try {
          const res = await fetch(`/api/${currentKbId}/sessions/${session.id}`);
          const detail = await res.json();
          const firstUserMsg = (detail.messages || []).find(m => m.role === 'user');
          return firstUserMsg ? firstUserMsg.content.slice(0, 50) : null;
        } catch {
          return null;
        }
      })
    );

    sessionsData.forEach((session, i) => {
      session.firstMessage = titles[i];
    });

    renderConversationList();
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

function renderConversationList() {
  const list = document.getElementById('conversationList');
  const groups = groupSessionsByTime(sessionsData);
  const groupOrder = ['今天', '昨天', '最近 7 天', '更早'];

  let html = '';
  for (const label of groupOrder) {
    const sessions = groups[label];
    if (!sessions || sessions.length === 0) continue;
    html += `<div class="conversation-group-label">${label}</div>`;
    for (const session of sessions) {
      html += renderSessionItem(session);
    }
    // 在"今天"分组后插入添加对话按钮
    if (label === '今天') {
      html += `<div class="section-add-area">
        <button class="section-add-btn" onclick="startNewChat()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          添加对话
        </button>
      </div>`;
    }
  }

  if (!html) {
    // 没有对话时也显示添加按钮
    html = `<div class="section-add-area">
      <button class="section-add-btn" onclick="startNewChat()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        添加对话
      </button>
    </div>`;
  }

  list.innerHTML = html;
}

function renderSessionItem(session) {
  const isActive = session.id === currentSessionId;
  const title = escapeHtml(session.firstMessage || formatSessionTitle(session));
  return `
    <div class="conversation-item ${isActive ? 'active' : ''}" onclick="switchSession('${session.id}')">
      <span class="conv-title">${title}</span>
      <button class="delete-btn" onclick="event.stopPropagation(); deleteSession('${session.id}')" title="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
        </svg>
      </button>
    </div>
  `;
}

function groupSessionsByTime(sessions) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups = { '今天': [], '昨天': [], '最近 7 天': [], '更早': [] };

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    if (date >= today) groups['今天'].push(session);
    else if (date >= yesterday) groups['昨天'].push(session);
    else if (date >= weekAgo) groups['最近 7 天'].push(session);
    else groups['更早'].push(session);
  }

  return groups;
}

function startNewChat() {
  currentSessionId = '';
  showWelcomeScreen();
  renderConversationList();
  document.getElementById('messageInput').focus();
}

async function switchSession(sessionId) {
  currentSessionId = sessionId;
  renderConversationList();

  try {
    const response = await fetch(`/api/${currentKbId}/sessions/${sessionId}`);
    const session = await response.json();

    if (session.messages && session.messages.length > 0) {
      showChatMessages(session.messages);
    } else {
      showWelcomeScreen();
    }
  } catch (error) {
    console.error('Failed to load session:', error);
    showWelcomeScreen();
  }
}

async function deleteSession(sessionId) {
  try {
    const response = await fetch(`/api/${currentKbId}/sessions/${sessionId}`, { method: 'DELETE' });
    const result = await response.json();

    if (result.success) {
      if (currentSessionId === sessionId) startNewChat();
      loadSessions();
    }
  } catch (error) {
    console.error('Failed to delete session:', error);
  }
}

/* ===== Chat Display ===== */

function showWelcomeScreen() {
  const chatArea = document.getElementById('chatArea');
  const kb = kbList.find(k => k.id === currentKbId);
  chatArea.innerHTML = `
    <div class="welcome" id="welcomeScreen">
      <h1 class="welcome-title">有什么可以帮你的？</h1>
      ${kb ? `<p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 8px;">知识库：${escapeHtml(kb.name)}</p>` : ''}
    </div>
  `;
}

function showChatMessages(messages) {
  const chatArea = document.getElementById('chatArea');
  chatArea.innerHTML = '<div class="messages-container" id="messagesContainer"></div>';

  const container = document.getElementById('messagesContainer');
  for (const msg of messages) {
    appendMessage(msg.content, msg.role);
  }
}

function appendMessage(text, role) {
  let container = document.getElementById('messagesContainer');
  if (!container) {
    document.getElementById('chatArea').innerHTML = '<div class="messages-container" id="messagesContainer"></div>';
    container = document.getElementById('messagesContainer');
  }

  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  if (role === 'assistant') {
    row.innerHTML = `
      <div class="message-avatar assistant-avatar">AI</div>
      <div class="message-content">
        <div class="markdown-content">${marked.parse(text)}</div>
      </div>
    `;
  } else {
    row.innerHTML = `
      <div class="message-content">${escapeHtml(text)}</div>
      <div class="message-avatar user-avatar">You</div>
    `;
  }

  container.appendChild(row);
  scrollToBottom();
}

function createAssistantMessage() {
  let container = document.getElementById('messagesContainer');
  if (!container) {
    document.getElementById('chatArea').innerHTML = '<div class="messages-container" id="messagesContainer"></div>';
    container = document.getElementById('messagesContainer');
  }

  const row = document.createElement('div');
  row.className = 'message-row assistant';

  row.innerHTML = `
    <div class="message-avatar assistant-avatar">AI</div>
    <div class="message-content">
      <div class="markdown-content">
        <div class="thinking-indicator">
          <span class="thinking-text">正在思考</span>
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
      <div class="sources" style="display:none;"></div>
    </div>
  `;

  container.appendChild(row);
  scrollToBottom();

  return row;
}

function scrollToBottom() {
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;
}

/* ===== Website Crawl ===== */

let crawlMode = 'site'; // 'site' or 'page'

function openCrawlModal() {
  if (!currentKbId) {
    showNotification('请先选择知识库', 'error');
    return;
  }
  if (!modelLoaded) {
    showNotification('请先启动模型', 'error');
    return;
  }
  const modal = document.getElementById('crawlModal');
  modal.classList.remove('hidden');
  const input = document.getElementById('crawlUrlInput');
  input.value = '';
  crawlMode = 'site';
  document.querySelector('input[name="crawlMode"][value="site"]').checked = true;
  updateCrawlPlaceholder();
  input.focus();
}

function closeCrawlModal() {
  document.getElementById('crawlModal').classList.add('hidden');
}

function updateCrawlPlaceholder() {
  const selected = document.querySelector('input[name="crawlMode"]:checked');
  crawlMode = selected ? selected.value : 'site';
  const input = document.getElementById('crawlUrlInput');
  const title = document.getElementById('crawlModalTitle');
  if (crawlMode === 'page') {
    input.placeholder = '输入网页地址，如 https://example.com/article';
    title.textContent = '添加网页到知识库';
  } else {
    input.placeholder = '输入网站地址，如 https://example.com';
    title.textContent = '添加网站到知识库';
  }
}

async function startCrawl() {
  const url = document.getElementById('crawlUrlInput').value.trim();
  if (!url) {
    showNotification('请输入地址', 'error');
    return;
  }

  try {
    new URL(url);
  } catch {
    showNotification('请输入有效的地址', 'error');
    return;
  }

  // Read current mode from radio
  const selected = document.querySelector('input[name="crawlMode"]:checked');
  crawlMode = selected ? selected.value : 'site';

  closeCrawlModal();

  const kbId = currentKbId;
  const isSinglePage = crawlMode === 'page';

  const progressContainer = document.getElementById('uploadProgress');
  progressContainer.classList.add('active');
  document.getElementById('uploadProgressFill').style.width = '0%';
  document.getElementById('uploadProgressPercent').textContent = '0%';
  document.getElementById('uploadProgressStage').textContent = isSinglePage ? '正在抓取网页...' : '正在发现文章列表...';

  let eventSource = null;

  try {
    const endpoint = isSinglePage ? `/api/${kbId}/crawl-page` : `/api/${kbId}/crawl`;
    const crawlResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const result = await crawlResponse.json();

    if (!result.success) throw new Error(result.error || '爬取失败');

    const fileId = result.fileId;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        eventSource.close();
        uploadStates.delete(kbId);
        showUploadProgressForKb(currentKbId);
        reject(new Error('爬取超时'));
      }, 1800000);

      eventSource = new EventSource(`/api/${kbId}/upload-progress/${fileId}`);
      uploadStates.set(kbId, { eventSource, latestProgress: null });

      eventSource.onmessage = (event) => {
        try {
          const progress = JSON.parse(event.data);

          const state = uploadStates.get(kbId);
          if (state) state.latestProgress = progress;

          if (kbId === currentKbId) updateProgressUI(progress);

          if (progress.status === 'completed') {
            clearTimeout(timeout); eventSource.close();
            uploadStates.delete(kbId);
            showUploadProgressForKb(currentKbId);
            resolve(progress);
          } else if (progress.status === 'failed') {
            clearTimeout(timeout); eventSource.close();
            uploadStates.delete(kbId);
            showUploadProgressForKb(currentKbId);
            reject(new Error(progress.error || '爬取失败'));
          }
        } catch (e) { console.error('Progress parse error:', e); }
      };
      eventSource.onerror = () => {
        clearTimeout(timeout); eventSource.close();
        uploadStates.delete(kbId);
        showUploadProgressForKb(currentKbId);
        reject(new Error('SSE 连接中断'));
      };
    });

    showNotification('网站爬取成功！', 'success');
    loadDocs();
    loadWebsites();
  } catch (error) {
    showNotification(`爬取失败：${error.message}`, 'error');
  } finally {
    if (eventSource) eventSource.close();
    uploadStates.delete(kbId);
    showUploadProgressForKb(currentKbId);
  }
}

// Handle Enter key in crawl URL input
document.addEventListener('DOMContentLoaded', () => {
  const crawlInput = document.getElementById('crawlUrlInput');
  if (crawlInput) {
    crawlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        startCrawl();
      }
    });
  }
});

/* ===== File Upload ===== */

function handleFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) uploadFile(files[0]);
}

async function uploadFile(file) {
  if (!currentKbId) {
    showNotification('请先选择知识库', 'error');
    return;
  }
  if (!modelLoaded) {
    showNotification('请先启动模型再上传文件', 'error');
    return;
  }

  const kbId = currentKbId;
  const formData = new FormData();
  formData.append('file', file);

  const progressContainer = document.getElementById('uploadProgress');
  progressContainer.classList.add('active');
  document.getElementById('uploadProgressFill').style.width = '0%';
  document.getElementById('uploadProgressPercent').textContent = '0%';
  document.getElementById('uploadProgressStage').textContent = '上传文件中...';

  let eventSource = null;

  try {
    const uploadResponse = await fetch(`/api/${kbId}/documents`, {
      method: 'POST',
      body: formData,
    });

    const result = await uploadResponse.json();

    if (!result.success) throw new Error(result.error || '上传失败');

    const fileId = result.fileId;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        eventSource.close();
        uploadStates.delete(kbId);
        showUploadProgressForKb(currentKbId);
        reject(new Error('处理超时'));
      }, 600000);

      eventSource = new EventSource(`/api/${kbId}/upload-progress/${fileId}`);
      uploadStates.set(kbId, { eventSource, latestProgress: null });

      eventSource.onmessage = (event) => {
        try {
          const progress = JSON.parse(event.data);

          // 始终记录最新进度到 KB 状态
          const state = uploadStates.get(kbId);
          if (state) state.latestProgress = progress;

          // 只在当前 KB 匹配时更新 DOM
          if (kbId === currentKbId) updateProgressUI(progress);

          // 检测完成/失败
          if (progress.status === 'completed') {
            clearTimeout(timeout); eventSource.close();
            uploadStates.delete(kbId);
            showUploadProgressForKb(currentKbId);
            resolve(progress);
          } else if (progress.status === 'failed') {
            clearTimeout(timeout); eventSource.close();
            uploadStates.delete(kbId);
            showUploadProgressForKb(currentKbId);
            reject(new Error(progress.error || '处理失败'));
          }
        } catch (e) { console.error('Progress parse error:', e); }
      };
      eventSource.onerror = () => {
        clearTimeout(timeout); eventSource.close();
        uploadStates.delete(kbId);
        showUploadProgressForKb(currentKbId);
        reject(new Error('SSE 连接中断'));
      };
    });

    showNotification('文件上传成功！', 'success');
    loadDocs();
  } catch (error) {
    showNotification(`上传失败：${error.message}`, 'error');
  } finally {
    if (eventSource) eventSource.close();
    uploadStates.delete(kbId);
    showUploadProgressForKb(currentKbId);
    document.getElementById('fileInput').value = '';
  }
}

/* ===== Send Message ===== */

function stopCurrentStream() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  isLoading = false;
  updateSendButton();
}

function cleanupAssistantMessage(contentDiv, sourcesDiv, fullAnswer, sources, userStopped) {
  const cursor = contentDiv.querySelector('.typing-cursor');
  if (cursor) cursor.remove();
  const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
  if (thinkingIndicator) thinkingIndicator.remove();

  if (fullAnswer) {
    contentDiv.innerHTML = marked.parse(fullAnswer);
    if (sources && sources.length > 0) {
      renderSources(sourcesDiv, sources);
    }
  } else if (userStopped) {
    contentDiv.innerHTML = '<em style="color: var(--text-muted);">已中断</em>';
  } else {
    contentDiv.innerHTML = '<em style="color: var(--text-muted);">连接中断</em>';
  }
}

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const question = input.value.trim();

  if (!question) return;
  if (!currentKbId) { showNotification('请先选择知识库', 'error'); return; }
  if (!modelLoaded) { showNotification('请先启动模型', 'error'); return; }

  // If already loading, abort the current stream
  if (isLoading && currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  const myRequestId = ++chatRequestId;

  appendMessage(question, 'user');
  input.value = '';
  autoResize(input);

  isLoading = true;
  updateSendButton();

  const assistantRow = createAssistantMessage();
  const contentDiv = assistantRow.querySelector('.markdown-content');
  const sourcesDiv = assistantRow.querySelector('.sources');

  let fullAnswer = '';
  let sources = null;

  const abortController = new AbortController();
  currentAbortController = abortController;

  try {
    const response = await fetch(`/api/${currentKbId}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: question, sessionId: currentSessionId || undefined }),
      signal: abortController.signal,
    });

    if (!response.ok) throw new Error('请求失败');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let sseBuffer = '';
    let doneReceived = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));

            if (data.type === 'thinking') {
              const thinkingText = contentDiv.querySelector('.thinking-text');
              if (thinkingText && data.message) thinkingText.textContent = data.message;
            } else if (data.type === 'content') {
              if (data.sources && !sources) sources = data.sources;

              if (data.content && data.content.trim()) {
                const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
                if (thinkingIndicator) thinkingIndicator.remove();

                fullAnswer += data.content;
                contentDiv.innerHTML = marked.parse(fullAnswer) + '<span class="typing-cursor"></span>';
                scrollToBottom();
              }
            } else if (data.type === 'done') {
              doneReceived = true;
              const cursor = contentDiv.querySelector('.typing-cursor');
              if (cursor) cursor.remove();

              if (sources && sources.length > 0) {
                renderSources(sourcesDiv, sources);
              }

              if (data.sessionId && data.sessionId !== currentSessionId) {
                currentSessionId = data.sessionId;
                loadSessions();
              }
            } else if (data.type === 'error') {
              throw new Error(data.error);
            }
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.error('Parse error:', e);
          }
        }
      }
    }

    // Stream ended without 'done' event — connection was lost or interrupted
    if (!doneReceived) {
      const userStopped = (chatRequestId === myRequestId);
      cleanupAssistantMessage(contentDiv, sourcesDiv, fullAnswer, sources, userStopped);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      const userStopped = (chatRequestId === myRequestId);
      cleanupAssistantMessage(contentDiv, sourcesDiv, fullAnswer, sources, userStopped);
    } else {
      const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
      if (thinkingIndicator) thinkingIndicator.remove();
      contentDiv.innerHTML = `请求失败：${escapeHtml(error.message)}`;
      sourcesDiv.style.display = 'none';
    }
  } finally {
    if (chatRequestId === myRequestId) {
      isLoading = false;
      currentAbortController = null;
      updateSendButton();
    }
  }
}

function renderSources(sourcesDiv, sources) {
  const MIN_SCORE = 0.55;
  const MAX_SOURCES = 4;

  const getDisplayName = (s) => {
    if (s.metadata.displayName) return s.metadata.displayName;
    const raw = s.metadata.source.split(/[\\/]/).pop();
    return raw.replace(/^(\d+-\d+-)+/, '');
  };

  const grouped = new Map();
  sources.forEach(s => {
    const score = parseFloat(s.score) || 0;
    if (score < MIN_SCORE) return;
    const name = getDisplayName(s);
    const page = s.metadata.page || s.metadata.chunkIndex;
    const key = `${name}|p${page}`;
    if (!grouped.has(key) || grouped.get(key).score < score) {
      grouped.set(key, { fileName: name, page, score });
    }
  });

  const dedupedSources = Array.from(grouped.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SOURCES);

  if (dedupedSources.length > 0) {
    sourcesDiv.innerHTML = '<strong>📚 参考来源:</strong><br>' +
      dedupedSources.map((s, idx) =>
        `${idx + 1}. ${escapeHtml(s.fileName)} (第${s.page}页, 相似度：${s.score.toFixed(3)})`
      ).join('<br>');
    sourcesDiv.style.display = 'block';
  }
}

/* ===== Input ===== */

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSendOrStop();
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function updateSendButton() {
  const btn = document.getElementById('sendBtn');
  const sendIcon = btn.querySelector('.send-icon');
  const stopIcon = btn.querySelector('.stop-icon');
  if (isLoading) {
    btn.disabled = false;
    btn.classList.add('stop-btn');
    btn.title = '停止生成';
    if (sendIcon) sendIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = 'block';
  } else {
    btn.disabled = false;
    btn.classList.remove('stop-btn');
    btn.title = '发送';
    if (sendIcon) sendIcon.style.display = 'block';
    if (stopIcon) stopIcon.style.display = 'none';
  }
}

function handleSendOrStop() {
  if (isLoading) {
    const input = document.getElementById('messageInput');
    const question = input.value.trim();
    if (question) {
      // Has new question - abort and send new
      sendMessage();
    } else {
      // No new question - just stop
      stopCurrentStream();
    }
  } else {
    sendMessage();
  }
}

/* ===== Model Status ===== */

async function checkModelStatus() {
  const statusDiv = document.getElementById('modelStatus');
  const warmupBtn = document.getElementById('warmupBtn');

  try {
    const response = await fetch('/api/model/status');
    const status = await response.json();

    modelLoaded = status.loaded;

    if (status.loaded) {
      statusDiv.className = 'model-status loaded';
      statusDiv.querySelector('.model-status-text').textContent = `${status.model} 已就绪`;
      warmupBtn.style.display = 'none';
    } else {
      statusDiv.className = 'model-status unloaded';
      statusDiv.querySelector('.model-status-text').textContent = `${status.model} 未加载`;
      warmupBtn.style.display = 'inline-block';
    }
  } catch (error) {
    statusDiv.className = 'model-status error';
    statusDiv.querySelector('.model-status-text').textContent = '无法连接';
    warmupBtn.style.display = 'none';
    modelLoaded = false;
  }
}

async function warmupModel() {
  const statusDiv = document.getElementById('modelStatus');
  const warmupBtn = document.getElementById('warmupBtn');

  statusDiv.className = 'model-status loading';
  statusDiv.querySelector('.model-status-text').textContent = '加载模型中...';
  warmupBtn.disabled = true;
  warmupBtn.textContent = '加载中';

  try {
    const response = await fetch('/api/model/warmup', { method: 'POST' });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || '加载失败');
    }

    const status = await response.json();
    modelLoaded = true;
    statusDiv.className = 'model-status loaded';
    statusDiv.querySelector('.model-status-text').textContent = `${status.model || '模型'} 已就绪`;
    warmupBtn.style.display = 'none';
  } catch (error) {
    statusDiv.className = 'model-status error';
    statusDiv.querySelector('.model-status-text').textContent = `加载失败`;
    warmupBtn.disabled = false;
    warmupBtn.textContent = '重试';
  }
}

/* ===== Utils ===== */

function formatSessionTitle(session) {
  const date = new Date(session.updatedAt);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `对话 ${time}`;
  return `对话 ${date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} ${time}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut 0.25s ease';
    setTimeout(() => notification.remove(), 250);
  }, 3000);
}
