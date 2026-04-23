#!/usr/bin/env node
/**
 * CLI 命令行工具
 * 提供 add、ask、list、remove 等命令
 */

import { RAGService } from './rag/RAGService.js';
import { config, validateConfig } from './utils/config.js';
import logger from './utils/logger.js';

/**
 * 打印帮助信息
 */
function printHelp(): void {
  console.log(`
RAG Assistant - 命令行工具

用法：
  npm run cli <command> [options]

命令:
  add <path>       添加文档或目录到知识库
  ask <question>   提问（可选：--session <sessionId>）
  list             列出知识库中的所有文档
  remove <source>  从知识库中删除文档
  stats            显示统计信息
  health           健康检查
  help             显示此帮助信息

示例:
  npm run cli add ./docs/笔记.md
  npm run cli add ./docs/           # 添加整个目录
  npm run cli ask "Transformer 是什么？"
  npm run cli ask "这个问题" --session abc-123
  npm run cli list
  npm run cli remove ./docs/笔记.md
  npm run cli stats
  npm run cli health
`);
}

/**
 * 打印统计信息
 */
async function printStats(rag: RAGService): Promise<void> {
  const stats = await rag.getStats();

  console.log('\n📊 RAG Assistant 统计信息\n');
  console.log('知识库:');
  console.log(`  - 文档数量：${stats.vectorStore.totalFiles}`);
  console.log(`  - 向量块数：${stats.vectorStore.totalChunks}`);
  console.log('\n对话历史:');
  console.log(`  - 会话数量：${stats.chatHistory.totalSessions}`);
  console.log(`  - 消息数量：${stats.chatHistory.totalMessages}`);
  console.log('\n缓存:');
  console.log(`  - 缓存条目：${stats.cache.size}`);
  console.log(`  - 缓存 TTL: ${stats.cache.ttl / 1000}秒`);
  console.log('');
}

/**
 * 健康检查
 */
async function healthCheck(rag: RAGService): Promise<void> {
  console.log('\n🏥 健康检查\n');

  const health = await rag.healthCheck();

  const statusMap: Record<string, string> = {
    true: '✅',
    false: '❌',
  };

  console.log(`Embedding 服务：${statusMap[String(health.embedding)]}`);
  console.log(`向量存储服务：${statusMap[String(health.vectorStore)]}`);
  console.log(`LLM 服务：    ${statusMap[String(health.llm)]}`);
  console.log(`\n整体状态：    ${statusMap[String(health.overall)]}`);

  if (!health.overall) {
    console.log('\n⚠️  部分服务异常，请检查配置和网络连接');
    process.exit(1);
  }

  console.log('');
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  // 验证配置
  try {
    validateConfig();
  } catch (error) {
    console.error('❌ 配置错误:', error);
    process.exit(1);
  }

  // 初始化 RAG 服务
  const rag = new RAGService();

  switch (command) {
    case 'add': {
      const path = args[1];
      if (!path) {
        console.error('❌ 请指定文件路径或目录');
        console.log('用法：npm run cli add <path>');
        process.exit(1);
      }

      console.log(`📥 添加文档：${path}`);

      try {
        // 判断是文件还是目录
        import('fs').then(async ({ default: fs }) => {
          const stats = fs.statSync(path);

          if (stats.isDirectory()) {
            console.log('📁 检测到目录，批量添加中...');
            const results = await rag.addDirectory(path);
            console.log(`✅ 成功添加 ${results.length} 个文件`);
            results.forEach(r => {
              console.log(`   - ${r.documentId}: ${r.totalChunks} chunks`);
            });
          } else {
            const result = await rag.addDocument(path);
            console.log('✅ 添加成功!');
            console.log(`   文档 ID: ${result.documentId}`);
            console.log(`   分块数：${result.totalChunks}`);
            console.log(`   平均块大小：${result.stats.avgChunkSize} 字符`);
          }
        });
      } catch (error) {
        console.error('❌ 添加失败:', error);
        process.exit(1);
      }
      break;
    }

    case 'ask':
    case 'chat': {
      // 提取问题（支持 --session 参数）
      const sessionIndex = args.indexOf('--session');
      const sessionId = sessionIndex !== -1 ? args[sessionIndex + 1] : undefined;
      const questionStart = sessionIndex !== -1 ? 1 : 1;
      const questionEnd = sessionIndex !== -1 ? sessionIndex : undefined;
      const question = args.slice(questionStart, questionEnd).join(' ');

      if (!question) {
        console.error('❌ 请输入问题');
        console.log('用法：npm run cli ask "你的问题"');
        process.exit(1);
      }

      console.log(`🤔 提问：${question}`);
      if (sessionId) {
        console.log(`📋 会话 ID: ${sessionId}`);
      }

      try {
        const response = await rag.chat(question, sessionId);
        console.log('\n💡 回答:\n');
        console.log(response.answer);

        if (response.sources.length > 0) {
          console.log('\n📚 参考来源:');
          response.sources.forEach((source, idx) => {
            console.log(`   ${idx + 1}. ${source.metadata.source} (相似度：${source.score?.toFixed(3) || 'N/A'})`);
          });
        }

        console.log(`\n📋 会话 ID: ${response.sessionId} (用于继续对话)`);
      } catch (error) {
        console.error('❌ 回答失败:', error);
        process.exit(1);
      }
      break;
    }

    case 'query': {
      // 无会话的简单查询
      const question = args.slice(1).join(' ');

      if (!question) {
        console.error('❌ 请输入问题');
        process.exit(1);
      }

      console.log(`🔍 查询：${question}`);

      try {
        const response = await rag.query(question);
        console.log('\n💡 回答:\n');
        console.log(response.answer);

        if (response.sources.length > 0) {
          console.log('\n📚 参考来源:');
          response.sources.forEach((source, idx) => {
            console.log(`   ${idx + 1}. ${source.metadata.source}`);
          });
        }
      } catch (error) {
        console.error('❌ 查询失败:', error);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      console.log('📚 知识库文档列表:\n');

      try {
        const sources = await rag.listDocuments();

        if (sources.length === 0) {
          console.log('   (空)');
        } else {
          sources.forEach((source, idx) => {
            console.log(`   ${idx + 1}. ${source}`);
          });
          console.log(`\n共 ${sources.length} 个文档`);
        }
      } catch (error) {
        console.error('❌ 获取列表失败:', error);
        process.exit(1);
      }
      break;
    }

    case 'remove':
    case 'delete': {
      const source = args[1];

      if (!source) {
        console.error('❌ 请指定要删除的文档源');
        console.log('用法：npm run cli remove <source>');
        process.exit(1);
      }

      console.log(`🗑️  删除文档：${source}`);

      try {
        await rag.removeDocument(source);
        console.log('✅ 删除成功');
      } catch (error) {
        console.error('❌ 删除失败:', error);
        process.exit(1);
      }
      break;
    }

    case 'stats': {
      await printStats(rag);
      break;
    }

    case 'health': {
      await healthCheck(rag);
      break;
    }

    default:
      console.error(`❌ 未知命令：${command}`);
      printHelp();
      process.exit(1);
  }
}

// 运行 CLI
main().catch(error => {
  console.error('❌ 未处理的错误:', error);
  process.exit(1);
});
