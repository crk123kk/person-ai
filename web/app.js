/**
 * RAG Assistant 前端应用
 */

let currentSessionId = '';
let isLoading = false;
let modelLoaded = false;

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initDragAndDrop();
  loadDocuments();
  loadSessions();
  updateStats();
  checkModelStatus();
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
  if (!modelLoaded) {
    showNotification('请先启动模型再上传文件', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  const btn = document.getElementById('sendBtn');
  const uploadArea = document.getElementById('uploadArea');
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');
  const progressStage = document.getElementById('progressStage');

  // 显示进度条
  progressContainer.classList.add('active');
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';
  progressStage.textContent = '上传文件中...';
  progressStage.className = 'progress-stage processing';

  btn.disabled = true;
  btn.textContent = '上传中...';
  uploadArea.classList.add('uploading');

  let currentFileId = null;
  let eventSource = null;

  try {
    // 上传文件
    const uploadResponse = await fetch('/api/documents', {
      method: 'POST',
      body: formData,
    });

    const result = await uploadResponse.json();

    if (!result.success) {
      throw new Error(result.error || '上传失败');
    }

    currentFileId = result.fileId;

    // 订阅 SSE 进度更新
    eventSource = subscribeToProgress(currentFileId, (progress) => {
      progressFill.style.width = `${progress.overallProgress}%`;
      progressPercent.textContent = `${progress.overallProgress}%`;

      // 更新当前阶段
      const currentStage = progress.stages.find(s => s.status === 'processing') ||
                          progress.stages.find(s => s.status === 'pending');
      if (currentStage) {
        progressStage.textContent = currentStage.message || currentStage.name;
      }

      // 更新阶段状态显示
      updateStageIndicators(progress.stages);
    });

    // 等待处理完成（通过状态判断）
    await waitForProcessingComplete(currentFileId, eventSource);

    if (result.document) {
      showNotification(`✅ 文件上传成功！\n分块数：${result.document.chunks}`, 'success');
      loadDocuments();
      updateStats();
    }

  } catch (error) {
    showNotification(`❌ 上传失败：${error.message}`, 'error');
  } finally {
    // 关闭 SSE 连接
    if (eventSource) {
      eventSource.close();
    }

    btn.disabled = false;
    btn.textContent = '发送';
    document.getElementById('fileInput').value = '';
    uploadArea.classList.remove('uploading');

    // 3 秒后隐藏进度条
    setTimeout(() => {
      progressContainer.classList.remove('active');
    }, 3000);
  }
}

/**
 * 订阅进度更新（使用 EventSource）
 */
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
    console.log('Progress SSE connection closed');
    eventSource.close();
  };

  return eventSource;
}

/**
 * 等待处理完成
 */
function waitForProcessingComplete(fileId, eventSource) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventSource.close();
      reject(new Error('处理超时'));
    }, 300000); // 5 分钟超时

    const messageHandler = (event) => {
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

    eventSource.onmessage = messageHandler;
  });
}

/**
 * 更新阶段指示器
 */
function updateStageIndicators(stages) {
  const stageNames = {
    'upload': '上传',
    'load': '加载',
    'clean': '清洗',
    'split': '分块',
    'embed': '向量化',
    'store': '存储',
  };

  const stageElement = document.getElementById('progressStage');
  if (!stageElement) return;

  // 移除旧的指示器
  const oldIndicators = stageElement.querySelectorAll('.stage-indicator');
  oldIndicators.forEach(el => el.remove());

  // 创建阶段指示器
  let indicatorHtml = '';
  stages.forEach(stage => {
    const statusClass = stage.status === 'completed' ? 'completed' :
                       stage.status === 'processing' ? 'processing' : '';
    if (statusClass) {
      indicatorHtml += `<span class="stage-indicator ${statusClass}" title="${stageNames[stage.name] || stage.name}"></span>`;
    }
  });

  // 添加到进度阶段前面
  const indicatorsSpan = document.createElement('span');
  indicatorsSpan.innerHTML = indicatorHtml;
  stageElement.insertBefore(indicatorsSpan, stageElement.firstChild);
}

/**
 * 显示通知
 */
function showNotification(message, type = 'info') {
  // 创建通知元素
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 15px 25px;
    border-radius: 8px;
    background: ${type === 'success' ? '#22c55e' : type === 'error' ? '#ff4757' : '#667eea'};
    color: white;
    z-index: 10000;
    animation: slideIn 0.3s ease;
  `;

  document.body.appendChild(notification);

  // 3 秒后移除
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// 添加动画样式
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(style);

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
      // 存储文档列表供删除时使用
      window.currentDocuments = data.documents;

      list.innerHTML = data.documents.map((doc, index) => {
        // 提取文件名，处理路径
        const fileName = doc.split(/[\\/]/).pop() || doc;
        // 去掉 Multer 自动生成的唯一前缀 (timestamp-randomNumber-)
        const displayName = fileName.replace(/^\d+-\d+-/, '');
        // 使用 decodeURIComponent 尝试解码 URL 编码的字符
        let decodedFileName = displayName;
        try {
          decodedFileName = decodeURIComponent(displayName);
        } catch (e) {
          // 如果解码失败，使用原文件名
          decodedFileName = displayName;
        }

        return `
        <li class="document-item">
          <span title="${escapeHtml(decodedFileName)}">${escapeHtml(decodedFileName)}</span>
          <button onclick="deleteDocument(${index})">删除</button>
        </li>
        `;
      }).join('');
    }
  } catch (error) {
    console.error('Failed to load documents:', error);
  }
}

/**
 * 删除文档
 */
async function deleteDocument(index) {
  const documents = window.currentDocuments || [];
  const source = documents[index];

  if (!source) {
    alert('文档列表为空，请刷新页面');
    return;
  }

  if (!confirm(`确定要删除这个文档吗？\n${source.split(/[\\/]/).pop()}`)) {
    return;
  }

  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(source)}`, {
      method: 'DELETE',
    });

    const result = await response.json();

    if (result.success) {
      showNotification('删除成功', 'success');
      loadDocuments();
      updateStats();
    } else {
      alert(`删除失败：${result.error}`);
    }
  } catch (error) {
    console.error('Delete failed:', error);
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
 * 发送消息（流式输出）
 */
async function sendMessage() {
  const input = document.getElementById('questionInput');
  const question = input.value.trim();

  if (!question || isLoading) return;

  if (!modelLoaded) {
    showNotification('请先启动模型再提问', 'error');
    return;
  }

  // 添加到聊天
  addMessage(question, 'user');
  input.value = '';

  isLoading = true;
  updateSendButton();

  // 创建助手消息容器（带思考动画）
  const assistantMessageDiv = createAssistantMessage();
  const contentDiv = assistantMessageDiv.querySelector('.markdown-content');
  const sourcesDiv = assistantMessageDiv.querySelector('.sources');

  let fullAnswer = '';
  let sources = null;
  let sessionId = null;

  try {
    // 使用 fetch + ReadableStream 实现真正的流式读取
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
      // 保留最后一个可能不完整的行
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));

            if (data.type === 'thinking') {
              // 更新思考状态文字（thinking 动画始终可见直到真正有内容）
              const thinkingText = contentDiv.querySelector('.thinking-text');
              if (thinkingText && data.message) {
                thinkingText.textContent = data.message;
              }
            } else if (data.type === 'content') {
              // 记录来源数据，但不立即显示（等回答完成后再显示）
              if (data.sources && !sources) {
                sources = data.sources;
                sessionId = data.sessionId;
              }

              // 只在有实际文字内容时移除思考动画并渲染
              if (data.content && data.content.trim()) {
                const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
                if (thinkingIndicator) {
                  thinkingIndicator.remove();
                }

                fullAnswer += data.content;
                contentDiv.innerHTML = marked.parse(fullAnswer) + '<span class="typing-cursor"></span>';
                // 自动滚动聊天区域
                const chatMessages = document.getElementById('chatMessages');
                chatMessages.scrollTop = chatMessages.scrollHeight;
              }
            } else if (data.type === 'done') {
              // 移除光标
              const cursor = contentDiv.querySelector('.typing-cursor');
              if (cursor) cursor.remove();

              // 回答完成后显示参考来源
              if (sources && sources.length > 0) {
                const MIN_SCORE = 0.55;
                const MAX_SOURCES = 4;

                const getDisplayName = (s) => {
                  if (s.metadata.displayName) return s.metadata.displayName;
                  const raw = s.metadata.source.split(/[\\/]/).pop();
                  return raw.replace(/^(\d+-\d+-)+/, '');
                };

                // 按文件名+页码去重，保留最高分
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
                document.getElementById('sessionId').textContent = `会话：${currentSessionId.slice(0, 8)}...`;
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
    // 确保思考动画被移除
    const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
    if (thinkingIndicator) thinkingIndicator.remove();
    contentDiv.innerHTML = `❌ 请求失败：${error.message}`;
    sourcesDiv.style.display = 'none';
  } finally {
    isLoading = false;
    updateSendButton();
  }
}

/**
 * 创建助手消息容器
 */
function createAssistantMessage() {
  const messages = document.getElementById('chatMessages');

  // 移除空状态
  const emptyState = messages.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant';
  messageDiv.style.maxHeight = 'none';
  messageDiv.style.overflowY = 'visible';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'markdown-content';
  messageDiv.appendChild(contentDiv);

  // 添加思考动画
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'thinking-indicator';
  thinkingDiv.innerHTML = `
    <span class="thinking-text">正在思考</span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
  `;
  contentDiv.appendChild(thinkingDiv);

  const sourcesDiv = document.createElement('div');
  sourcesDiv.className = 'sources';
  sourcesDiv.style.display = 'none';
  messageDiv.appendChild(sourcesDiv);

  messages.appendChild(messageDiv);
  messages.scrollTop = messages.scrollHeight;

  return messageDiv;
}

/**
 * 添加消息到聊天
 */
function addMessage(text, role) {
  const messages = document.getElementById('chatMessages');

  // 移除空状态
  const emptyState = messages.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  if (role === 'user') {
    messageDiv.textContent = text;
  } else {
    const contentDiv = document.createElement('div');
    contentDiv.className = 'markdown-content';
    contentDiv.innerHTML = marked.parse(text);
    messageDiv.appendChild(contentDiv);
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
 * HTML 转义
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
 * 检查模型状态
 */
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

    updateUploadState();
  } catch (error) {
    statusDiv.className = 'model-status error';
    statusDiv.querySelector('.model-status-text').textContent = '无法连接模型服务';
    warmupBtn.style.display = 'none';
    modelLoaded = false;
    updateUploadState();
  }
}

/**
 * 预热/加载模型
 */
async function warmupModel() {
  const statusDiv = document.getElementById('modelStatus');
  const warmupBtn = document.getElementById('warmupBtn');

  statusDiv.className = 'model-status loading';
  statusDiv.querySelector('.model-status-text').textContent = '正在加载模型（首次可能需要 1-2 分钟）...';
  warmupBtn.disabled = true;
  warmupBtn.textContent = '加载中...';

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
    statusDiv.querySelector('.model-status-text').textContent = `加载失败：${error.message}`;
    warmupBtn.disabled = false;
    warmupBtn.textContent = '重试';
  }

  updateUploadState();
}

/**
 * 根据模型状态更新上传区域
 */
function updateUploadState() {
  const uploadArea = document.getElementById('uploadArea');
  const sendBtn = document.getElementById('sendBtn');

  if (!modelLoaded) {
    uploadArea.style.opacity = '0.5';
    uploadArea.style.pointerEvents = 'none';
    uploadArea.title = '请先启动模型';
    sendBtn.title = '请先启动模型';
  } else {
    uploadArea.style.opacity = '1';
    uploadArea.style.pointerEvents = 'auto';
    uploadArea.title = '';
    sendBtn.title = '';
  }
}
