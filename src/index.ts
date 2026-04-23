/**
 * 应用入口文件
 * 启动 Web 服务器
 */

import { config, validateConfig } from './utils/config.js';
import { startServer } from './server.js';
import logger from './utils/logger.js';

async function main(): Promise<void> {
  // 验证配置
  try {
    validateConfig();
  } catch (error) {
    logger.error('Configuration validation failed:', error);
    process.exit(1);
  }

  // 启动服务器
  try {
    await startServer(config.port);
    logger.info(`Server started on http://localhost:${config.port}`);
    console.log(`\n🚀 RAG Assistant 已启动`);
    console.log(`📍 访问地址：http://localhost:${config.port}\n`);
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
