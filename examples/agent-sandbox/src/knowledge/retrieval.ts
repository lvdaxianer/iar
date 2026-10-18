/**
 * 提供 agent sandbox 的本地知识库加载与确定性检索。
 *
 * 每个 Function 对应一个本地知识库（bases/<functionId>.json，中文企业内容）。
 * 加载在首次使用时惰性进行并按 functionId 缓存；session 构造时通过
 * assertSandboxKnowledgeBases 预加载全部知识库，任何文件缺失、JSON
 * 非法或结构不合规都会在构造期抛出带 functionId 的清晰错误。
 * 检索采用确定性评分：查询按字二元组与拉丁词切词，对条目标题、关键词、
 * 答案做加权重叠计分（权重 3/2/1），按得分降序、同分按条目顺序排序，
 * 返回 topK 的 { id, title, answer, score }。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 知识库单条目的形状。 */
export type KnowledgeEntry = {
  /** 条目唯一标识。 */
  id: string;
  /** 条目标题。 */
  title: string;
  /** 检索关键词。 */
  keywords: string[];
  /** 条目答案正文。 */
  answer: string;
  /** 最近更新时间。 */
  updatedAt: string;
};

/** 单个 Function 的本地知识库。 */
export type KnowledgeBase = {
  /** 知识库契约版本。 */
  schemaVersion: string;
  /** 归属 Function。 */
  functionId: string;
  /** 知识库中文名。 */
  name: string;
  /** 知识条目列表。 */
  entries: KnowledgeEntry[];
};

/** 检索返回的单条结果。 */
export type RetrievedKnowledge = {
  /** 条目唯一标识。 */
  id: string;
  /** 条目标题。 */
  title: string;
  /** 条目答案正文。 */
  answer: string;
  /** 归一化相关度得分（0 到 1，保留两位小数）。 */
  score: number;
};

/** 知识库 JSON 文件所在目录（相对仓库根目录，与 config 读取约定一致）。 */
const KNOWLEDGE_BASE_DIR = join(process.cwd(), 'examples', 'agent-sandbox', 'src', 'knowledge', 'bases');

/** 单条 query 允许的最大切词数，避免无界输入放大计算。 */
const MAX_QUERY_TOKENS = 80;

/** 已加载知识库的 functionId 级缓存（主线程与 worker 线程各自持有一份）。 */
const baseCache = new Map<string, KnowledgeBase>();

/**
 * 加载并校验指定 Function 的本地知识库，结果按 functionId 缓存。
 *
 * @param functionId - 目标 Function
 * @returns 校验后的知识库
 * @throws Error 当文件缺失、JSON 非法或条目结构不合规
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function loadKnowledgeBase(functionId: string): KnowledgeBase {
  const cached = baseCache.get(functionId);
  if (cached) return cached;
  const path = join(KNOWLEDGE_BASE_DIR, `${functionId}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`知识库加载失败（${functionId}）：文件不存在或不可读（${path}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`知识库加载失败（${functionId}）：JSON 解析错误（${detail}）`);
  }
  const base = validateKnowledgeBase(functionId, parsed);
  baseCache.set(functionId, base);
  return base;
}

/**
 * 从指定 Function 的知识库中检索与 query 最相关的条目。
 *
 * @param functionId - 目标 Function
 * @param query - 用户查询文本
 * @param topK - 返回条数上限，默认 3
 * @returns 按相关度排序的 topK 条目，无命中时返回空数组
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function retrieveKnowledge(functionId: string, query: string, topK = 3): RetrievedKnowledge[] {
  const base = loadKnowledgeBase(functionId);
  const queryTokens = uniqueTokens(tokenize(query)).slice(0, MAX_QUERY_TOKENS);
  if (queryTokens.length === 0) return [];
  const scored = base.entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, topK));
  return scored.map(({ entry, score }) => ({
    id: entry.id,
    title: entry.title,
    answer: entry.answer,
    score: Math.round(score * 100) / 100
  }));
}

/**
 * 预加载并校验全部给定 Function 的知识库，供 session 构造期调用。
 *
 * @param functionIds - 需要加载的 Function 标识列表
 * @returns 无返回值
 * @throws Error 任一知识库加载或校验失败时抛出带 functionId 的错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function assertSandboxKnowledgeBases(functionIds: readonly string[]): void {
  for (const functionId of functionIds) loadKnowledgeBase(functionId);
}

/**
 * 校验知识库顶层结构与每条目字段，错误信息带 functionId 与条目序号。
 *
 * @param functionId - 目标 Function
 * @param value - 待校验的解析后 JSON
 * @returns 校验通过的 KnowledgeBase
 * @throws Error 结构不合规时
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function validateKnowledgeBase(functionId: string, value: unknown): KnowledgeBase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`知识库校验失败（${functionId}）：顶层必须是 JSON 对象`);
  }
  const base = value as Record<string, unknown>;
  if (base.functionId !== functionId) {
    throw new Error(`知识库校验失败（${functionId}）：functionId 字段与实际不符（${String(base.functionId)}）`);
  }
  if (typeof base.name !== 'string' || base.name.trim().length === 0) {
    throw new Error(`知识库校验失败（${functionId}）：缺少 name 字段`);
  }
  if (!Array.isArray(base.entries) || base.entries.length === 0) {
    throw new Error(`知识库校验失败（${functionId}）：entries 必须是非空数组`);
  }
  const seen = new Set<string>();
  const entries = base.entries.map((item, index) => {
    const where = `条目 #${String(index + 1)}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`知识库校验失败（${functionId}）：${where} 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const id = entry.id;
    const title = entry.title;
    const answer = entry.answer;
    const updatedAt = entry.updatedAt;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`知识库校验失败（${functionId}）：${where} 缺少非空字段 id`);
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error(`知识库校验失败（${functionId}）：${where} 缺少非空字段 title`);
    }
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw new Error(`知识库校验失败（${functionId}）：${where} 缺少非空字段 answer`);
    }
    if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) {
      throw new Error(`知识库校验失败（${functionId}）：${where} 缺少非空字段 updatedAt`);
    }
    if (!Array.isArray(entry.keywords) || entry.keywords.length === 0 || entry.keywords.some((keyword) => typeof keyword !== 'string' || keyword.trim().length === 0)) {
      throw new Error(`知识库校验失败（${functionId}）：${where} 的 keywords 必须是非空字符串数组`);
    }
    if (seen.has(id)) {
      throw new Error(`知识库校验失败（${functionId}）：${where} 的 id 重复（${id}）`);
    }
    seen.add(id);
    return {
      id,
      title,
      keywords: entry.keywords.map((keyword) => String(keyword).trim()),
      answer,
      updatedAt
    };
  });
  return {
    schemaVersion: typeof base.schemaVersion === 'string' ? base.schemaVersion : 'iar.sandbox-knowledge/v1',
    functionId,
    name: base.name,
    entries
  };
}

/**
 * 对单条知识条目做加权重叠评分。
 *
 * 标题、关键词、答案的命中权重分别为 3、2、1；得分按 3+2+1 乘以查询词数
 * 归一化到 0~1（理论最大值恰好为 1）。
 *
 * @param entry - 知识条目
 * @param queryTokens - 去重后的查询词集合
 * @returns 归一化得分
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function scoreEntry(entry: KnowledgeEntry, queryTokens: readonly string[]): number {
  const hits =
    3 * countHits(entry.title, queryTokens) +
    2 * countHits(entry.keywords.join(' '), queryTokens) +
    1 * countHits(entry.answer, queryTokens);
  return hits / (6 * queryTokens.length);
}

/**
 * 统计查询词在文本切词集合中出现的不同词个数。
 *
 * @param text - 被匹配的文本
 * @param queryTokens - 去重后的查询词集合
 * @returns 命中词数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function countHits(text: string, queryTokens: readonly string[]): number {
  const textTokens = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) hits += 1;
  }
  return hits;
}

/**
 * 把文本切成字二元组与拉丁/数字词，作为确定性检索的基本单位。
 *
 * @param text - 原始文本
 * @returns 小写切词列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  const chars = Array.from(normalized.replace(/[\s\p{P}\p{S}]/gu, ''));
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(`${chars[index] ?? ''}${chars[index + 1] ?? ''}`);
  }
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  tokens.push(...words);
  return tokens;
}

/**
 * 切词去重并保持首次出现顺序。
 *
 * @param tokens - 原始切词列表
 * @returns 去重后的切词列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function uniqueTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}
