/**
 * @fileoverview DeepSeek 文本生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    pasteImages
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck,
    tryGotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://chat.deepseek.com/';
// 精确匹配消息输入框（避免命中页面其他 textarea）
const INPUT_SELECTOR = 'textarea[name="search"]';

// DeepSeek 开关按钮 (div.ds-toggle-button, 非 <button>)，按中文标签匹配
const TOGGLE_LABELS = {
    thinking: '深度思考',   // DeepThink
    search: '智能搜索'      // Search
};

/**
 * 切换功能开关 (DeepThink / Search)
 * 现状：开关是 div.ds-toggle-button，文字为中文 "深度思考"/"智能搜索"，
 *       选中态 class 仍为 ds-toggle-button--selected
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {'thinking'|'search'} toggleKey - 开关标识
 * @param {boolean} targetState - 目标状态 (true=开启, false=关闭)
 * @param {object} meta - 日志元数据
 * @returns {Promise<boolean>} 是否成功切换
 */
async function toggleButton(page, toggleKey, targetState, meta = {}) {
    const label = TOGGLE_LABELS[toggleKey];
    try {
        const btn = page.locator('div.ds-toggle-button').filter({ hasText: label });
        const btnCount = await btn.count();
        if (btnCount === 0) {
            logger.debug('适配器', `未找到开关 "${label}"`, meta);
            return false;
        }

        // 获取当前状态 (检查 class 是否包含 ds-toggle-button--selected)
        const isSelected = await btn.first().evaluate(el => el.classList.contains('ds-toggle-button--selected'));

        if (isSelected !== targetState) {
            logger.info('适配器', `切换 ${label}: ${isSelected} -> ${targetState}`, meta);
            await safeClick(page, btn.first(), { bias: 'button' });
            await sleep(300, 500);
            return true;
        } else {
            logger.debug('适配器', `${label} 已是目标状态: ${targetState}`, meta);
            return true;
        }
    } catch (e) {
        logger.warn('适配器', `切换 ${label} 失败: ${e.message}`, meta);
        return false;
    }
}

/**
 * 配置模型功能 (thinking / search)
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {object} modelConfig - 模型配置
 * @param {object} meta - 日志元数据
 */
async function configureModel(page, modelConfig, meta = {}) {
    const thinking = modelConfig?.thinking || false;
    const search = modelConfig?.search || false;

    // 切换 深度思考 状态
    await toggleButton(page, 'thinking', thinking, meta);
    await sleep(200, 400);

    // 切换 智能搜索 状态
    await toggleButton(page, 'search', search, meta);
    await sleep(200, 400);
}

/**
 * 执行文本生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组 (此适配器不支持)
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{text?: string, reasoning?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;

    try {
        logger.info('适配器', '开启新会话...', meta);
        // DeepSeek SPA 的 load 事件可能因长连接不在超时内触发:
        // 仅"页面加载超时"视为可继续 (页面实际已渲染), 其他导航错误仍抛出
        const navResult = await tryGotoWithCheck(page, TARGET_URL);
        if (navResult.error) {
            if (/页面加载超时/.test(navResult.error)) {
                logger.warn('适配器', '页面加载超时，继续执行 (SPA 长连接属正常现象)', meta);
            } else {
                throw new Error(navResult.error);
            }
        }

        // 1. 等待输入框加载
        await waitForInput(page, INPUT_SELECTOR, { click: false });

        // 1.5 切换基础/专业模式 (Instant / Expert)
        try {
            const isExpert = modelId ? modelId.endsWith('-expert') : false;
            const targetType = isExpert ? 'expert' : 'default';
            const modeBtn = page.locator(`div[data-model-type="${targetType}"]`).first();
            
            if (await modeBtn.count() > 0) {
                logger.info('适配器', `切换 ${isExpert ? 'Expert' : 'Instant'} 模式...`, meta);
                await safeClick(page, modeBtn, { bias: 'button' });
                await sleep(300, 500);
            }
        } catch (e) {
            logger.debug('适配器', `模式切换异常 (部分账号可能无此入口): ${e.message}`, meta);
        }

        // 2. 配置模型功能 (thinking / search)
        const modelConfig = manifest.models.find(m => m.id === modelId);
        if (modelConfig) {
            await configureModel(page, modelConfig, meta);
        }

        // 2.5 上传文件/图片 (DeepSeek 支持文档与图片附件, 页面侧限制最多 20 个, 单个 100MB)
        if (imgPaths && imgPaths.length > 0) {
            logger.info('适配器', `开始上传 ${imgPaths.length} 个文件...`, meta);
            await pasteImages(page, INPUT_SELECTOR, imgPaths, {}, meta);
            logger.info('适配器', '文件上传完成', meta);
        }

        // 3. 输入提示词
        logger.info('适配器', '输入提示词...', meta);
        // 新版 DeepSeek 输入框区域会频繁重渲染, 拟人化点击的"元素稳定等待"易 25s 超时
        // (CLICK_TIMEOUT)。发送用 Enter 键 (见下方), 无需依赖按钮点击, 故改用 JS 直接
        // focus (确定性), 再由 humanType 内部再次 focus 兜底。
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.focus();
        }, INPUT_SELECTOR).catch(() => { });
        await humanType(page, INPUT_SELECTOR, prompt);
        await sleep(300, 500);

        // 4. 先启动 API 监听
        logger.debug('适配器', '启动 API 监听...', meta);

        let textContent = '';
        let thinkingContent = '';  // thinking 内容
        let isComplete = false;
        let currentFragmentType = null;  // 当前最后片段类型: 'RESPONSE' | 'THINK' | 其他
        let lastResponseText = '';  // 诊断: 最近一次响应原文

        /**
         * 将增量内容路由到当前片段 (RESPONSE -> textContent, THINK -> thinkingContent)
         */
        const routeDelta = (v) => {
            if (v == null) return;
            if (currentFragmentType === 'RESPONSE') textContent += v;
            else if (currentFragmentType === 'THINK') thinkingContent += v;
        };

        /**
         * 用片段数组同步当前片段状态
         * @param {Array} frags - 片段数组
         * @param {boolean} appendContent - 是否累加片段已有内容 (全量快照=否, APPEND 新增片段=是)
         */
        const syncFromFragments = (frags, appendContent) => {
            if (!Array.isArray(frags) || frags.length === 0) return;
            const last = frags[frags.length - 1];
            currentFragmentType = last?.type || null;
            if (appendContent) {
                // APPEND / 初始响应: 新片段内容尚未被增量路由, 追加
                if (last?.content) {
                    if (currentFragmentType === 'RESPONSE') textContent += last.content;
                    else if (currentFragmentType === 'THINK') thinkingContent += last.content;
                }
            } else {
                // 无 o 的全量快照: 权威完整状态。按片段类型重建内容。
                // 关键点: 短回答(如"收到")往往只出现在全量快照里, 不会逐字增量流出,
                // 因此这里必须从快照里取出 RESPONSE/THINK 内容, 否则 textContent 会为空。
                // 仅当重建结果比已有累积更长时才采用 (防早期快照回退 / 防与增量重复)。
                let resp = '', think = '';
                for (const f of frags) {
                    if (f.type === 'RESPONSE' && f.content) resp += f.content;
                    else if (f.type === 'THINK' && f.content) think += f.content;
                }
                if (resp.length > textContent.length) textContent = resp;
                if (think.length > thinkingContent.length) thinkingContent = think;
            }
        };

        const responsePromise = page.waitForResponse(async (response) => {
            const url = response.url();
            if (!url.includes('chat/completion')) return false;
            if (response.request().method() !== 'POST') return false;
            if (response.status() !== 200) return false;

            try {
                const body = await response.text();
                lastResponseText = body;
                const lines = body.split('\n');

                for (const line of lines) {
                    // 跳过事件行和空行
                    if (line.startsWith('event:') || !line.startsWith('data:')) continue;

                    const dataStr = line.slice(5).trim();
                    if (!dataStr || dataStr === '{}') continue;

                    try {
                        const data = JSON.parse(dataStr);

                        // --- 1. 初始响应: 携带完整 fragments 快照 ---
                        if (data.v?.response?.fragments && Array.isArray(data.v.response.fragments)) {
                            syncFromFragments(data.v.response.fragments, true);
                        }

                        // --- 2. fragments 路径: APPEND 新增片段 / 无 o 的全量快照 SET ---
                        if (data.p === 'response/fragments' && Array.isArray(data.v)) {
                            if (data.o === 'APPEND') {
                                syncFromFragments(data.v, true);
                            } else {
                                // 无 o 字段 = SET 全量快照: 只同步片段顺序, 不累加内容 (防重复)
                                syncFromFragments(data.v, false);
                            }
                        }

                        // --- 3. BATCH 操作 ---
                        if (data.o === 'BATCH' && data.p === 'response' && Array.isArray(data.v)) {
                            for (const item of data.v) {
                                if (item.p === 'fragments' && Array.isArray(item.v)) {
                                    syncFromFragments(item.v, item.o === 'APPEND');
                                } else if (item.p === 'status' || item.p === 'quasi_status') {
                                    if (item.v === 'FINISHED') isComplete = true;
                                }
                            }
                        }

                        // --- 4. 带路径的增量内容 (fragments/N/content) ---
                        if (data.p && typeof data.v === 'string') {
                            if (/^response\/fragments\/(-?\d+)\/content$/.test(data.p)) {
                                routeDelta(data.v);
                            }
                            // 独立的 status SET 完成信号
                            if (data.p === 'response/status' && data.v === 'FINISHED') {
                                isComplete = true;
                            }
                        }

                        // --- 5. 纯文本增量 (只有 v 字符串, 无 p 和 o, 追加到当前片段) ---
                        if (data.v && typeof data.v === 'string' && !data.p && !data.o) {
                            routeDelta(data.v);
                        }
                    } catch {
                        // 忽略解析错误
                    }
                }

                return isComplete;
            } catch {
                return false;
            }
        }, { timeout: waitTimeout });

        // 5. 发送提示词
        logger.debug('适配器', '发送提示词...', meta);
        await page.keyboard.press('Enter');

        logger.info('适配器', '等待生成结果...', meta);

        // 6. 等待 API 响应
        try {
            await responsePromise;
        } catch (e) {
            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        if (!textContent || textContent.trim() === '') {
            logger.warn('适配器', '回复内容为空', {
                ...meta,
                thinkingLen: thinkingContent.length,
                responseTail: lastResponseText.slice(-1500)
            });
            return { error: '回复内容为空' };
        }

        logger.info('适配器', `已获取文本内容 (${textContent.length} 字符)`, meta);
        logger.info('适配器', '文本生成完成，任务完成', meta);

        const trimmedThinking = thinkingContent.trim();
        const result = { text: textContent.trim() };

        // 返回结果（如果有 thinking 则包含 reasoning）
        if (trimmedThinking) {
            logger.info('适配器', `已获取思考过程 (${trimmedThinking.length} 字符)`, meta);
            result.reasoning = trimmedThinking;
        }
        return result;

    } catch (err) {
        // 顶层错误处理
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        let pageDiag = null;
        try {
            pageDiag = {
                pageUrl: page.url(),
                pageTitle: await page.title(),
                pageText: await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '')
            };
        } catch (e) { /* 页面可能已关闭 */ }

        logger.error('适配器', '生成任务失败', { ...meta, ...pageDiag, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    } finally { }
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'deepseek_text',
    displayName: 'DeepSeek (文本生成)',
    description: '使用 DeepSeek 官网生成文本，支持 DeepThink 深度思考和 Search 搜索模式，支持文档与图片附件 (最多 20 个, 单个 100MB)。需要已登录的 DeepSeek 账户。',

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    // 模型列表
    models: [
        { id: 'deepseek', imagePolicy: 'optional' },
        { id: 'deepseek-thinking', imagePolicy: 'optional', thinking: true },
        { id: 'deepseek-search', imagePolicy: 'optional', search: true },
        { id: 'deepseek-thinking-search', imagePolicy: 'optional', thinking: true, search: true },
        { id: 'deepseek-expert', imagePolicy: 'optional' },
        { id: 'deepseek-thinking-expert', imagePolicy: 'optional', thinking: true },
        { id: 'deepseek-search-expert', imagePolicy: 'optional', search: true },
        { id: 'deepseek-thinking-search-expert', imagePolicy: 'optional', thinking: true, search: true },
    ],

    // 无需导航处理器
    navigationHandlers: [],

    // 核心文本生成方法
    generate
};
