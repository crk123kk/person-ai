/**
 * RAG Assistant - ChatGPT-style frontend
 */

let currentSessionId = '';
let isLoading = false;
let modelLoaded = false;
let sessionsData = [];

// Init
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadSessions();
  checkModelStatus();
});

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

/* ===== Sidebar ===== */

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
}

async function loadSessions() {
  try {
    const response = await fetch('/api/sessions');
    const data = await response.json();
    sessionsData = data.sessions || [];

    const titles = await Promise.all(
      sessionsData.map(async (session) => {
        try {
          const res = await fetch(`/api/sessions/${session.id}`);
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

  let html = '';
  for (const [label, sessions] of Object.entries(groups)) {
    if (sessions.length === 0) continue;
    html += `<div class="conversation-group-label">${label}</div>`;
    for (const session of sessions) {
      const isActive = session.id === currentSessionId;
      const title = escapeHtml(session.firstMessage || formatSessionTitle(session));
      html += `
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
  }

  if (!html) {
    html = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">暂无对话</div>';
  }

  list.innerHTML = html;
}

function groupSessionsByTime(sessions) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups = {
    '今天': [],
    '昨天': [],
    '最近 7 天': [],
    '更早': [],
  };

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    if (date >= today) {
      groups['今天'].push(session);
    } else if (date >= yesterday) {
      groups['昨天'].push(session);
    } else if (date >= weekAgo) {
      groups['最近 7 天'].push(session);
    } else {
      groups['更早'].push(session);
    }
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
    const response = await fetch(`/api/sessions/${sessionId}`);
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
    const response = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    const result = await response.json();

    if (result.success) {
      if (currentSessionId === sessionId) {
        startNewChat();
      }
      loadSessions();
    }
  } catch (error) {
    console.error('Failed to delete session:', error);
  }
}

/* ===== Chat Display ===== */

function showWelcomeScreen() {
  const chatArea = document.getElementById('chatArea');
  chatArea.innerHTML = `
    <div class="welcome" id="welcomeScreen">
      <h1 class="welcome-title">有什么可以帮你的？</h1>
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
    const chatArea = document.getElementById('chatArea');
    chatArea.innerHTML = '<div class="messages-container" id="messagesContainer"></div>';
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
    const chatArea = document.getElementById('chatArea');
    chatArea.innerHTML = '<div class="messages-container" id="messagesContainer"></div>';
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

/* ===== File Upload ===== */

function handleFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) {
    uploadFile(files[0]);
  }
}

async function uploadFile(file) {
  if (!modelLoaded) {
    showNotification('请先启动模型再上传文件', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  const progressContainer = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const progressStage = document.getElementById('uploadProgressStage');

  progressContainer.classList.add('active');
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';
  progressStage.textContent = '上传文件中...';

  let eventSource = null;

  try {
    const uploadResponse = await fetch('/api/documents', {
      method: 'POST',
      body: formData,
    });

    const result = await uploadResponse.json();

    if (!result.success) {
      throw new Error(result.error || '上传失败');
    }

    const fileId = result.fileId;

    eventSource = subscribeToProgress(fileId, (progress) => {
      progressFill.style.width = `${progress.overallProgress}%`;
      progressPercent.textContent = `${progress.overallProgress}%`;

      const currentStage = progress.stages.find(s => s.status === 'processing') ||
                          progress.stages.find(s => s.status === 'pending');
      if (currentStage) {
        progressStage.textContent = currentStage.message || currentStage.name;
      }
    });

    await waitForProcessingComplete(fileId, eventSource);

    showNotification(`文件上传成功！分块数：${result.document.chunks}`, 'success');
  } catch (error) {
    showNotification(`上传失败：${error.message}`, 'error');
  } finally {
    if (eventSource) eventSource.close();
    document.getElementById('fileInput').value = '';
    setTimeout(() => {
      progressContainer.classList.remove('active');
    }, 3000);
  }
}

function subscribeToProgress(fileId, callback) {
  const eventSource = new EventSource(`/api/upload-progress/${fileId}`);
  eventSource.onmessage = (event) => {
    try {
      const progress = JSON.parse(event.data);
      callback(progress);
    } catch (e) {
      console.error('Failed to parse progress:', e);
    }
  };
  eventSource.onerror = () => {
    eventSource.close();
  };
  return eventSource;
}

function waitForProcessingComplete(fileId, eventSource) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventSource.close();
      reject(new Error('处理超时'));
    }, 300000);

    eventSource.onmessage = (event) => {
      try {
        const progress = JSON.parse(event.data);
        if (progress.status === 'completed') {
          clearTimeout(timeout);
          eventSource.close();
          resolve(progress);
        } else if (progress.status === 'failed') {
          clearTimeout(timeout);
          eventSource.close();
          reject(new Error(progress.error || '处理失败'));
        }
      } catch (e) {
        console.error('Failed to parse progress:', e);
      }
    };
  });
}

/* ===== Send Message ===== */

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const question = input.value.trim();

  if (!question || isLoading) return;

  if (!modelLoaded) {
    showNotification('请先启动模型', 'error');
    return;
  }

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

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: question,
        sessionId: currentSessionId || undefined,
      }),
    });

    if (!response.ok) {
      throw new Error('请求失败');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

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
              if (thinkingText && data.message) {
                thinkingText.textContent = data.message;
              }
            } else if (data.type === 'content') {
              if (data.sources && !sources) {
                sources = data.sources;
              }

              if (data.content && data.content.trim()) {
                const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
                if (thinkingIndicator) thinkingIndicator.remove();

                fullAnswer += data.content;
                contentDiv.innerHTML = marked.parse(fullAnswer) + '<span class="typing-cursor"></span>';
                scrollToBottom();
              }
            } else if (data.type === 'done') {
              const cursor = contentDiv.querySelector('.typing-cursor');
              if (cursor) cursor.remove();

              if (sources && sources.length > 0) {
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

              if (data.sessionId && data.sessionId !== currentSessionId) {
                currentSessionId = data.sessionId;
                loadSessions();
              }
            } else if (data.type === 'error') {
              throw new Error(data.error);
            }
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }
    }
  } catch (error) {
    const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
    if (thinkingIndicator) thinkingIndicator.remove();
    contentDiv.innerHTML = `请求失败：${escapeHtml(error.message)}`;
    sourcesDiv.style.display = 'none';
  } finally {
    isLoading = false;
    updateSendButton();
  }
}

/* ===== Input ===== */

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function updateSendButton() {
  const btn = document.getElementById('sendBtn');
  btn.disabled = isLoading;
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
