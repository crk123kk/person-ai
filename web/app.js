/**
 * RAG Assistant 前端应用
 */

let currentSessionId = '';
let isLoading = false;

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initDragAndDrop();
  loadDocuments();
  loadSessions();
  updateStats();
});

/**
 * 初始化拖拽上传
 */
function initDragAndDrop() {
  const uploadArea = document.getElementById('uploadArea');

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadFile(files[0]);
    }
  });
}

/**
 * 处理文件选择
 */
function handleFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) {
    uploadFile(files[0]);
  }
}

/**
 * 上传文件
 */
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = '上传中...';

  try {
    const response = await fetch('/api/documents', {
      method: 'POST',
      body: formData,
    });

    const result = await response.json();

    if (result.success) {
      alert(`✅ 文件上传成功！\n分块数：${result.document.chunks}`);
      loadDocuments();
      updateStats();
    } else {
      alert(`❌ 上传失败：${result.error}`);
    }
  } catch (error) {
    alert(`❌ 上传失败：${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '发送';
    document.getElementById('fileInput').value = '';
  }
}

/**
 * 加载文档列表
 */
async function loadDocuments() {
  try {
    const response = await fetch('/api/documents');
    const data = await response.json();

    const list = document.getElementById('documentList');

    if (data.documents.length === 0) {
      list.innerHTML = '<li class="empty-state"><p>暂无文档</p></li>';
    } else {
      list.innerHTML = data.documents.map(doc => `
        <li class="document-item">
          <span>${escapeHtml(doc)}</span>
          <button onclick="deleteDocument('${escapeHtml(doc)}')">删除</button>
        </li>
      `).join('');
    }
  } catch (error) {
    console.error('Failed to load documents:', error);
  }
}

/**
 * 删除文档
 */
async function deleteDocument(source) {
  if (!confirm(`确定要删除这个文档吗？\n${source}`)) {
    return;
  }

  try {
    await fetch(`/api/documents/${encodeURIComponent(source)}`, {
      method: 'DELETE',
    });

    loadDocuments();
    updateStats();
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

/**
 * 加载会话列表
 */
async function loadSessions() {
  try {
    const response = await fetch('/api/sessions');
    const data = await response.json();

    const select = document.getElementById('sessionSelect');
    const options = ['<option value="">开始新对话</option>'];

    data.sessions.forEach(session => {
      const date = new Date(session.updatedAt).toLocaleString('zh-CN');
      options.push(`<option value="${session.id}">${date} (${session.messageCount} 条消息)</option>`);
    });

    select.innerHTML = options.join('');
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

/**
 * 切换会话
 */
function switchSession() {
  const select = document.getElementById('sessionSelect');
  currentSessionId = select.value;

  const sessionIdSpan = document.getElementById('sessionId');
  sessionIdSpan.textContent = currentSessionId ? `会话：${currentSessionId.slice(0, 8)}...` : '';

  // 清空聊天区域
  const messages = document.getElementById('chatMessages');
  messages.innerHTML = `
    <div class="empty-state">
      <p>💬 开始新的对话</p>
    </div>
  `;
}

/**
 * 发送消息
 */
async function sendMessage() {
  const input = document.getElementById('questionInput');
  const question = input.value.trim();

  if (!question || isLoading) return;

  // 添加到聊天
  addMessage(question, 'user');
  input.value = '';

  isLoading = true;
  updateSendButton();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: question,
        sessionId: currentSessionId || undefined,
      }),
    });

    const data = await response.json();

    if (data.sessionId && data.sessionId !== currentSessionId) {
      currentSessionId = data.sessionId;
      document.getElementById('sessionId').textContent = `会话：${currentSessionId.slice(0, 8)}...`;
      loadSessions();
    }

    // 显示回答
    let answerHtml = escapeHtml(data.answer);

    if (data.sources && data.sources.length > 0) {
      answerHtml += '<div class="sources"><strong>📚 参考来源:</strong><br>';
      data.sources.forEach((source, idx) => {
        const fileName = source.metadata.source.split('/').pop();
        const score = source.score ? source.score.toFixed(3) : 'N/A';
        answerHtml += `${idx + 1}. ${escapeHtml(fileName)} (相似度：${score})<br>`;
      });
      answerHtml += '</div>';
    }

    addMessage(answerHtml, 'assistant', true);

  } catch (error) {
    addMessage(`❌ 请求失败：${error.message}`, 'assistant');
  } finally {
    isLoading = false;
    updateSendButton();
  }
}

/**
 * 添加消息到聊天
 */
function addMessage(content, type, isHtml = false) {
  const messages = document.getElementById('chatMessages');

  // 移除空状态
  const emptyState = messages.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;

  if (isHtml) {
    messageDiv.innerHTML = content;
  } else {
    messageDiv.textContent = content;
  }

  messages.appendChild(messageDiv);
  messages.scrollTop = messages.scrollHeight;
}

/**
 * 处理回车发送
 */
function handleKeyPress(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

/**
 * 更新发送按钮状态
 */
function updateSendButton() {
  const btn = document.getElementById('sendBtn');
  btn.disabled = isLoading;
  btn.textContent = isLoading ? '思考中...' : '发送';
}

/**
 * 刷新文档列表
 */
function refreshDocuments() {
  loadDocuments();
  updateStats();
}

/**
 * 更新统计信息
 */
async function updateStats() {
  try {
    const response = await fetch('/api/stats');
    const stats = await response.json();

    const statsDiv = document.getElementById('stats');
    statsDiv.innerHTML = `
      <strong>📊 统计信息</strong><br>
      文档：${stats.vectorStore.totalFiles} |
      向量：${stats.vectorStore.totalChunks} |
      会话：${stats.chatHistory.totalSessions}
    `;
  } catch (error) {
    console.error('Failed to update stats:', error);
  }
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
