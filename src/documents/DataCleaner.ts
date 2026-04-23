import logger from '../utils/logger.js';

export interface CleanOptions {
  removeExtraWhitespace?: boolean;
  removeSpecialChars?: boolean;
  normalizeLineBreaks?: boolean;
  removeHeadersFooters?: boolean;
  minLength?: number;
}

/**
 * 数据清洗器
 * 用于清理文档中的噪声和不必要的字符
 */
export class DataCleaner {
  /**
   * 通用文本清洗
   */
  static clean(text: string, options: CleanOptions = {}): string {
    const {
      removeExtraWhitespace = true,
      removeSpecialChars = false,
      normalizeLineBreaks = true,
      minLength = 1,
    } = options;

    let cleaned = text;

    // 1. 统一换行符 (CRLF -> LF)
    if (normalizeLineBreaks) {
      cleaned = cleaned.replace(/\r\n/g, '\n');
      cleaned = cleaned.replace(/\r/g, '\n');
    }

    // 2. 移除多余空白（保留单个空格）
    if (removeExtraWhitespace) {
      // 移除制表符，替换为空格
      cleaned = cleaned.replace(/\t+/g, ' ');
      // 移除行首行尾空白
      cleaned = cleaned.replace(/^[ \t]+|[ \t]+$/gm, '');
      // 移除行中多余空格（保留单个）
      cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
    }

    // 3. 移除控制字符和不可见字符（保留正常标点）
    if (removeSpecialChars) {
      // 移除 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F 控制字符
      cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }

    // 4. 移除连续的多个空行（保留最多 2 个换行）
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // 5. 移除空行或只包含空白的行（可选，根据最小长度）
    if (minLength > 0) {
      cleaned = cleaned
        .split('\n')
        .filter(line => line.trim().length >= minLength)
        .join('\n');
    }

    // 6. 移除首尾空白
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * PDF 特殊清洗
   * 处理 PDF 解析产生的伪影
   */
  static cleanPDFArtifacts(text: string): string {
    let cleaned = text;

    logger.debug('Cleaning PDF artifacts');

    // 1. 修复断字（行末的连字符 + 换行）
    // 例如："trans-\nformer" -> "transformer"
    cleaned = cleaned.replace(/[-‐]\n/g, '');

    // 2. 修复行中断（非段落结束的换行）
    // 小写字母后的换行通常是句子中间的断行
    cleaned = cleaned.replace(/\n([a-z])/g, ' $1');

    // 3. 移除页眉页脚标记
    cleaned = cleaned.replace(/^(\d+\/\d+|Page \d+|\[\d+\])$/gm, '');

    // 4. 移除常见的 PDF 页码标记
    cleaned = cleaned.replace(/^\s*-\s*\d+\s*-\s*$/gm, '');

    // 5. 移除 URL 被断行的情况
    cleaned = cleaned.replace(/(https?:\/\/)\n/g, '$1');

    return cleaned;
  }

  /**
   * 代码文件清洗
   */
  static cleanCode(content: string, language: string): string {
    let cleaned = content;

    logger.debug(`Cleaning code content (${language})`);

    // 1. 移除行号（常见于复制的代码）
    // 例如："1 | function foo() {}" 或 "10  console.log()"
    cleaned = cleaned.replace(/^\s*\d+\s+\|?\s*/gm, '');

    // 2. 移除空行过多的部分（保留最多 2 个空行）
    cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');

    // 3. 移除行尾空白
    cleaned = cleaned.replace(/[ \t]+$/gm, '');

    // 4. 统一缩进（可选，将 Tab 转为 2 空格）
    // cleaned = cleaned.replace(/\t/g, '  ');

    return cleaned.trim();
  }

  /**
   * Markdown 清洗（保留结构）
   */
  static cleanMarkdown(content: string): string {
    let cleaned = content;

    // 1. 移除 HTML 注释
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

    // 2. 移除 YAML front matter（如果有）
    cleaned = cleaned.replace(/^---\n[\s\S]*?\n---\n/, '');

    // 3. 移除连续的空行（保留最多 2 个）
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // 4. 移除行尾空白
    cleaned = cleaned.replace(/[ \t]+$/gm, '');

    return cleaned.trim();
  }

  /**
   * 检测并移除 PII（个人敏感信息）
   */
  static filterPII(text: string, options: { redact?: boolean } = {}): string {
    const { redact = true } = options;

    const patterns: Record<string, RegExp> = {
      email: /\b[\w.-]+@[\w.-]+\.\w+\b/g,
      phone: /\b1[3-9]\d{9}\b/g,
      idCard: /\b\d{17}[\dXx]\b/g,
      url: /\bhttps?:\/\/[\w./?=&%-]+\b/g,
      apiKey: /\b(sk-[a-zA-Z0-9]{20,})\b/g,
      ipAddress: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    };

    let filtered = text;

    for (const [type, pattern] of Object.entries(patterns)) {
      if (redact) {
        filtered = filtered.replace(pattern, `[${type}_REDACTED]`);
      } else {
        filtered = filtered.replace(pattern, '');
      }
    }

    return filtered;
  }
}

export default DataCleaner;
