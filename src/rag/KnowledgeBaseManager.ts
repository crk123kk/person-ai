import * as fs from 'fs';
import * as path from 'path';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';

export interface KnowledgeBase {
  id: string;
  name: string;
  createdAt: string;
  systemPrompt?: string;
}

export class KnowledgeBaseManager {
  private baseDir: string;

  constructor() {
    this.baseDir = path.resolve(config.dataDir, 'knowledge-bases');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /** List all knowledge bases */
  list(): KnowledgeBase[] {
    const result: KnowledgeBase[] = [];
    if (!fs.existsSync(this.baseDir)) return result;

    for (const dir of fs.readdirSync(this.baseDir)) {
      const metaPath = path.join(this.baseDir, dir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          let raw = fs.readFileSync(metaPath, 'utf-8');
          // Strip BOM if present
          if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
          const meta = JSON.parse(raw);
          result.push(meta);
        } catch (err) {
          logger.warn(`Skipping corrupted meta.json in ${dir}:`, err);
        }
      }
    }

    return result.sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  /** Get a single KB by id */
  get(id: string): KnowledgeBase | null {
    const metaPath = path.join(this.baseDir, id, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Create a new knowledge base */
  create(name: string): KnowledgeBase {
    // Generate a URL-safe id from name
    let id = name.toLowerCase();
    // Replace non-ASCII characters with nothing, then slugify
    id = id.replace(/[^\x00-\x7F]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id) id = 'kb-' + Date.now().toString(36);
    let finalId = id;
    let counter = 1;
    while (fs.existsSync(path.join(this.baseDir, finalId))) {
      finalId = `${id}-${counter++}`;
    }

    const kb: KnowledgeBase = {
      id: finalId,
      name,
      createdAt: new Date().toISOString(),
    };

    const kbDir = path.join(this.baseDir, finalId);
    fs.mkdirSync(path.join(kbDir, 'vectorstore'), { recursive: true });
    fs.mkdirSync(path.join(kbDir, 'documents'), { recursive: true });
    fs.mkdirSync(path.join(kbDir, 'chat-history'), { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'meta.json'), JSON.stringify(kb, null, 2), 'utf-8');

    logger.info(`Knowledge base created: ${name} (${finalId})`);
    return kb;
  }

  /** Delete a knowledge base and all its data */
  delete(id: string): boolean {
    const kbDir = path.join(this.baseDir, id);
    if (!fs.existsSync(kbDir)) return false;

    fs.rmSync(kbDir, { recursive: true, force: true });
    logger.info(`Knowledge base deleted: ${id}`);
    return true;
  }

  /** Update the system prompt for a KB */
  updateSystemPrompt(id: string, systemPrompt: string): KnowledgeBase | null {
    const kb = this.get(id);
    if (!kb) return null;
    kb.systemPrompt = systemPrompt;
    const metaPath = path.join(this.baseDir, id, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(kb, null, 2), 'utf-8');
    logger.info(`System prompt updated for KB: ${id}`);
    return kb;
  }

  /** Get the documents directory for a KB */
  getDocumentsDir(id: string): string {
    return path.join(this.baseDir, id, 'documents');
  }

  /** Ensure a default KB exists (called on startup) */
  ensureDefault(): KnowledgeBase {
    const existing = this.list();
    if (existing.length > 0) return existing[0];
    return this.create('默认知识库');
  }
}
