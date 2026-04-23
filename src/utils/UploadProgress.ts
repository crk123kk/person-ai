/**
 * 上传进度跟踪器
 * 用于跟踪文档上传和处理的各个阶段
 */

export interface ProgressStage {
  name: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  message?: string;
  timestamp?: string;
}

export interface UploadProgress {
  fileId: string;
  fileName: string;
  overallProgress: number;
  stages: ProgressStage[];
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  error?: string;
  startTime: number;
  endTime?: number;
}

/**
 * 进度管理器
 * 单例模式，管理所有上传任务的进度
 */
export class ProgressManager {
  private static instance: ProgressManager;
  private progressMap: Map<string, UploadProgress>;
  private subscribers: Map<string, Set<(progress: UploadProgress) => void>>;

  private constructor() {
    this.progressMap = new Map();
    this.subscribers = new Map();
  }

  static getInstance(): ProgressManager {
    if (!ProgressManager.instance) {
      ProgressManager.instance = new ProgressManager();
    }
    return ProgressManager.instance;
  }

  /**
   * 创建新的上传进度跟踪
   */
  createProgress(fileId: string, fileName: string): UploadProgress {
    const progress: UploadProgress = {
      fileId,
      fileName,
      overallProgress: 0,
      status: 'uploading',
      startTime: Date.now(),
      stages: [
        { name: 'upload', status: 'processing', progress: 0, message: '上传文件中...' },
        { name: 'load', status: 'pending', progress: 0, message: '加载文档...' },
        { name: 'clean', status: 'pending', progress: 0, message: '清洗数据...' },
        { name: 'split', status: 'pending', progress: 0, message: '文本分块...' },
        { name: 'embed', status: 'pending', progress: 0, message: '向量化...' },
        { name: 'store', status: 'pending', progress: 0, message: '存储向量...' },
      ],
    };

    this.progressMap.set(fileId, progress);
    this.subscribers.set(fileId, new Set());
    this.notifySubscribers(fileId);
    return progress;
  }

  /**
   * 更新阶段进度
   */
  updateStage(
    fileId: string,
    stageName: string,
    updates: Partial<ProgressStage>
  ): void {
    const progress = this.progressMap.get(fileId);
    if (!progress) return;

    const stage = progress.stages.find(s => s.name === stageName);
    if (stage) {
      Object.assign(stage, updates);
      stage.timestamp = new Date().toISOString();
      this.calculateOverallProgress(progress);
      this.notifySubscribers(fileId);
    }
  }

  /**
   * 更新整体状态
   */
  updateStatus(fileId: string, status: UploadProgress['status'], error?: string): void {
    const progress = this.progressMap.get(fileId);
    if (!progress) return;

    progress.status = status;
    if (status === 'completed') {
      progress.endTime = Date.now();
    }
    if (error) {
      progress.error = error;
    }
    this.notifySubscribers(fileId);
  }

  /**
   * 订阅进度更新
   */
  subscribe(fileId: string, callback: (progress: UploadProgress) => void): () => void {
    if (!this.subscribers.has(fileId)) {
      this.subscribers.set(fileId, new Set());
    }
    this.subscribers.get(fileId)!.add(callback);

    // 立即发送当前进度
    const progress = this.progressMap.get(fileId);
    if (progress) {
      callback(progress);
    }

    // 返回取消订阅函数
    return () => {
      this.subscribers.get(fileId)?.delete(callback);
    };
  }

  /**
   * 获取进度
   */
  getProgress(fileId: string): UploadProgress | undefined {
    return this.progressMap.get(fileId);
  }

  /**
   * 获取所有进度
   */
  getAllProgress(): UploadProgress[] {
    return Array.from(this.progressMap.values());
  }

  /**
   * 删除进度
   */
  removeProgress(fileId: string): void {
    this.progressMap.delete(fileId);
    this.subscribers.delete(fileId);
  }

  /**
   * 通知订阅者
   */
  private notifySubscribers(fileId: string): void {
    const progress = this.progressMap.get(fileId);
    const subscribers = this.subscribers.get(fileId);
    if (progress && subscribers) {
      subscribers.forEach(callback => callback(progress));
    }
  }

  /**
   * 计算整体进度
   */
  private calculateOverallProgress(progress: UploadProgress): void {
    const weights = [
      { stage: 'upload', weight: 10 },
      { stage: 'load', weight: 15 },
      { stage: 'clean', weight: 15 },
      { stage: 'split', weight: 20 },
      { stage: 'embed', weight: 25 },
      { stage: 'store', weight: 15 },
    ];

    let totalProgress = 0;
    for (const { stage, weight } of weights) {
      const stageProgress = progress.stages.find(s => s.name === stage);
      if (stageProgress) {
        if (stageProgress.status === 'completed') {
          totalProgress += weight;
        } else if (stageProgress.status === 'processing') {
          totalProgress += (stageProgress.progress / 100) * weight;
        }
      }
    }
    progress.overallProgress = Math.round(totalProgress);
  }
}

export default ProgressManager;
