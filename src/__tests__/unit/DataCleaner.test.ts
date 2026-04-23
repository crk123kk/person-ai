import { describe, it, expect } from 'vitest';
import { DataCleaner } from '../../documents/DataCleaner.js';

describe('DataCleaner', () => {
  describe('clean', () => {
    it('应该移除多余空白', () => {
      const input = 'Hello    World';
      const result = DataCleaner.clean(input, { removeExtraWhitespace: true });
      expect(result).toBe('Hello World');
    });

    it('应该统一换行符', () => {
      const input = 'Line1\r\nLine2\rLine3';
      const result = DataCleaner.clean(input, { normalizeLineBreaks: true });
      expect(result).toBe('Line1\nLine2\nLine3');
    });

    it('应该移除连续空行', () => {
      const input = 'Line1\n\n\n\nLine2';
      const result = DataCleaner.clean(input);
      // 实现会移除连续空行保留最多 2 个换行，同时也会移除空行（如果 minLength > 0）
      // 当前实现默认 minLength=1，所以空行会被移除
      expect(result).toBe('Line1\nLine2');
    });
  });

  describe('cleanPDFArtifacts', () => {
    it('应该修复断字', () => {
      const input = 'trans-\nformer';
      const result = DataCleaner.cleanPDFArtifacts(input);
      expect(result).toBe('transformer');
    });

    it('应该移除页码标记', () => {
      const input = 'Content\n1/10\nMore content';
      const result = DataCleaner.cleanPDFArtifacts(input);
      expect(result).toContain('Content');
      expect(result).not.toContain('1/10');
    });
  });

  describe('cleanCode', () => {
    it('应该移除行号', () => {
      const input = '1 | function foo() {}\n2 |   return bar;';
      const result = DataCleaner.cleanCode(input, 'javascript');
      // 行号被移除，行首空白也被清理
      expect(result).toBe('function foo() {}\nreturn bar;');
    });

    it('应该移除行尾空白', () => {
      const input = 'line1   \nline2  \n';
      const result = DataCleaner.cleanCode(input, 'javascript');
      expect(result).toBe('line1\nline2');
    });
  });

  describe('cleanMarkdown', () => {
    it('应该移除 HTML 注释', () => {
      const input = '# Title\n<!-- comment -->\nContent';
      const result = DataCleaner.cleanMarkdown(input);
      expect(result).not.toContain('<!--');
    });

    it('应该移除 YAML front matter', () => {
      const input = '---\ntitle: Test\n---\n# Content';
      const result = DataCleaner.cleanMarkdown(input);
      expect(result).toBe('# Content');
    });
  });

  describe('filterPII', () => {
    it('应该过滤邮箱地址', () => {
      const input = 'Contact me at test@example.com';
      const result = DataCleaner.filterPII(input);
      expect(result).toContain('[email_REDACTED]');
    });

    it('应该过滤手机号', () => {
      const input = 'My phone is 13812345678';
      const result = DataCleaner.filterPII(input);
      expect(result).toContain('[phone_REDACTED]');
    });
  });
});
