/**
 * @fileoverview 豆包 (Doubao) 文本生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    uploadFilesViaChooser
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck,
    tryGotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://www.doubao.com/chat/';

/**
 * 执行文本生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{text?: string, reasoning?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;

    // 是否使用深度思考模式
    const useThinking = modelId === 'seed-thinking' || modelId === 'seed-pro';

    // 模型 ID 到菜单项的正则映射
    // 新版豆包模型菜单仅 快速/专家 两项 (旧版 快速/思考/专家, 英文 Fast/Think/Pro)
    const MODEL_MENU_MAP = {
        'seed': /快速|Fast/,
        'seed-thinking': /专家|思考|Pro|Think/,
        'seed-pro': /专家|Pro/
    };

    try {
        logger.info('适配器', '开启新会话...', meta);
        // 豆包 SPA 的 load 事件可能因长连接不在超时内触发:
        // 仅"页面加载超时"视为可继续 (页面实际已渲染), 其他导航错误仍抛出。
        // 这里把 load 等待从默认 20s 缩短到 8s: SPA 几乎不会在 8s 内触发 load,
        // 但 DOM 已开始渲染, 交给下方 60s 的输入框等待兜底, 可显著减少空等。
        const navResult = await tryGotoWithCheck(page, TARGET_URL, { timeout: 8000 });
        if (navResult.error) {
            if (/页面加载超时/.test(navResult.error)) {
                logger.warn('适配器', '页面加载超时，继续执行 (SPA 长连接属正常现象)', meta);
            } else {
                throw new Error(navResult.error);
            }
        }

        // 1. 等待输入框加载 (改版后为 TipTap 富文本编辑器, 不再是 textarea)
        // 豆包 SPA 首屏渲染较慢, 且 goto 的 load 事件常因长连接而超时(已被容错),
        // 此时输入框可能尚未渲染完成 → 放宽等待预算到 60s, 避免"未找到输入框"
        const inputLocator = page.locator('div[contenteditable="true"]').first();
        await waitForInput(page, inputLocator, { click: false, timeout: 60000 });

        // 2. 选择模型 (改版后菜单项为 快速/专家, 兼容旧版 思考)
        const modelMenuName = MODEL_MENU_MAP[modelId] || MODEL_MENU_MAP['seed'];
        logger.debug('适配器', `选择模型: ${modelId} -> ${String(modelMenuName)}`, meta);
        await sleep(300, 500);

        // 给予 1 秒的缓冲时间等待 React 渲染按钮
        await sleep(1000); // 确保有一定的渲染时间
        const modelSelectorBtn = page.locator('#input-engine-container button[aria-haspopup="menu"]')
            .filter({ hasText: /Fast|Think|Pro|快速|思考|专家|專家/ })
            .first();
        let selectorExists = false;
        try {
            await modelSelectorBtn.waitFor({ state: 'attached', timeout: 5000 });
            selectorExists = true;
        } catch (e) {
            selectorExists = false;
        }

        if (selectorExists) {
            const menuItem = page.getByRole('menuitem', { name: modelMenuName });
            // 点击模型选择按钮，最多重试 3 次（菜单偶尔不弹出）
            for (let attempt = 1; attempt <= 3; attempt++) {
                await sleep(500, 1000);
                await safeClick(page, modelSelectorBtn, { bias: 'button' });
                try {
                    await menuItem.waitFor({ state: 'visible', timeout: 3000 });
                    break; // 菜单弹出，退出重试
                } catch {
                    logger.warn('适配器', `模型菜单未弹出，重试 ${attempt}/3`, meta);
                    if (attempt === 3) throw new Error('模型选择菜单未弹出');
                }
            }
            await safeClick(page, menuItem, { bias: 'button' });
            await sleep(600, 1000); // 留出充足时间等待模型选择浮窗自动关闭，防止遮挡上传图标
        }

        // 3. 上传图片 (如果有)
        if (imgPaths && imgPaths.length > 0) {
            logger.info('适配器', `开始上传 ${imgPaths.length} 张图片...`, meta);

            // 预先拦截 ApplyImageUpload 响应，动态收集实际上传路径
            const expectedUploadPaths = new Set();
            const applyUploadHandler = async (response) => {
                try {
                    const url = response.url();
                    if (!url.includes('Action=ApplyImageUpload') || response.status() !== 200) return;
                    const json = await response.json();
                    const storeUri = json.Result?.UploadAddress?.StoreInfos?.[0]?.StoreUri;
                    if (storeUri) {
                        expectedUploadPaths.add(storeUri);
                        logger.debug('适配器', `已获取上传路径: ${storeUri}`, meta);
                    }
                } catch { /* 忽略解析错误 */ }
            };
            page.on('response', applyUploadHandler);

            try {
                // 点击上传菜单按钮（排除模型选择/项目/对话等按钮, 附件按钮无文字）
                const uploadMenuBtn = page.locator('#input-engine-container button[aria-haspopup="menu"]')
                    .filter({ hasNot: page.locator('text=/Fast|Think|Pro|Quick|快速|思考|专家|專家|更多|项目|对话|技能/') })
                    .first();
                await safeClick(page, uploadMenuBtn, { bias: 'button' });
                await sleep(300, 500);

                // 点击上传文件选项 (新版菜单项文案仍为 上传文件或图片)
                const uploadItem = page.getByText(/上传文件或图片|上傳檔案或圖片|Upload File or Image/).first();
                await uploadFilesViaChooser(page, uploadItem, imgPaths, {
                    uploadValidator: (response) => {
                        if (response.status() !== 200 || response.request().method() !== 'POST') return false;
                        const url = response.url();
                        for (const path of expectedUploadPaths) {
                            if (url.includes(path)) return true;
                        }
                        return false;
                    }
                }, meta);
            } catch (uploadErr) {
                logger.error('适配器', `图片上传失败: ${uploadErr.message}`, meta);
                // 不抛出异常，继续尝试发送纯文本
            } finally {
                page.off('response', applyUploadHandler);
            }

            logger.info('适配器', '图片上传完成', meta);
        }

        // 4. 填写提示词
        await safeClick(page, inputLocator, { bias: 'input' });
        await humanType(page, inputLocator, prompt);

        // 5. 设置 SSE 监听
        logger.debug('适配器', '启动 SSE 监听...', meta);

        let resultText = '';
        let reasoningText = '';
        let isResolved = false;
        let sseTimeoutId;

        const resultPromise = new Promise((resolve, reject) => {
            sseTimeoutId = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`API_TIMEOUT: 响应超时 (${Math.round(waitTimeout / 1000)}秒)`));
                }
            }, waitTimeout);

            const handleResponse = async (response) => {
                try {
                    const url = response.url();
                    // 只处理 chat/completion 接口的 SSE 响应
                    if (!url.includes('chat/completion')) return;

                    const contentType = response.headers()['content-type'] || '';
                    if (!contentType.includes('text/event-stream')) return;

                    // 读取响应体并解析 SSE
                    const body = await response.text();
                    const result = parseSSEResponse(body, useThinking);

                    if (result.text) {
                        resultText = result.text;
                        reasoningText = result.reasoning || '';

                        if (!isResolved) {
                            isResolved = true;
                            clearTimeout(sseTimeoutId);
                            page.off('response', handleResponse);
                            resolve();
                        }
                    }
                } catch (e) {
                    // 忽略解析错误，继续等待
                }
            };

            page.on('response', handleResponse);
        });

        // 安全网：若后续流程(点击/发送)提前失败，resultPromise 会成为无人 await 的孤儿
        // promise，120s 后 timer 触发 reject 会造成 unhandled rejection 并直接崩掉进程。
        // 挂一个吞掉异常的 catch 保证它永远被"已处理"，避免进程崩溃。
        resultPromise.catch(() => { });

        // 6. 点击发送 (改版后为 button[aria-label="发送"], 保留旧 id 兜底)
        //    专家模式下, 发送按钮区域持续重渲染 (思考动画/浮层), Playwright 层级的
        //    拟人化点击与 force 点击都容易在稳定性/后校验上超时。
        //    策略: 用 JS 直接在按钮上派发 .click() (确定性、最快), 失败再用 Playwright 强点兜底。
        const sendBtn = page.locator('button[aria-label="发送"], button#flow-end-msg-send').first();
        await sendBtn.waitFor({ state: 'visible', timeout: 10000 });
        // 关掉可能残留的模型选择菜单 (避免浮层遮挡发送按钮)
        try { await page.keyboard.press('Escape'); } catch { /* 忽略 */ }
        await sleep(300, 500);
        logger.info('适配器', '点击发送...', meta);
        const jsClick = await page.evaluate(() => {
            const btn = document.querySelector('button[aria-label="发送"], button#flow-end-msg-send');
            if (!btn) return { ok: false, reason: '未找到发送按钮' };
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, reason: '按钮处于禁用态' };
            btn.click();
            return { ok: true };
        }).catch((e) => ({ ok: false, reason: e.message }));
        if (!jsClick.ok) {
            logger.warn('适配器', `JS 点击发送失败(${jsClick.reason})，回退 Playwright 强点`, meta);
            await sendBtn.click({ force: true, timeout: 15000 }).catch(() => { });
        }

        // 7. 等待响应
        logger.info('适配器', '等待生成结果...', meta);
        await resultPromise;

        if (resultText) {
            logger.info('适配器', `生成完成，文本长度: ${resultText.length}`, meta);
            const result = { text: resultText };
            if (reasoningText) {
                result.reasoning = reasoningText;
            }
            return result;
        } else {
            return { error: '未能从响应中提取文本' };
        }

    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    } finally { }
}

/**
 * 解析 SSE 响应体，提取最终文本
 * @param {string} body - SSE 响应体
 * @param {boolean} useThinking - 是否使用深度思考模式
 * @returns {{text: string, reasoning?: string}}
 */
function parseSSEResponse(body, useThinking) {
    const lines = body.split('\n');
    let resultText = '';
    let reasoningText = '';
    let inThinkingBlock = false;
    let thinkingBlockId = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 解析事件类型
        if (line.startsWith('event:')) {
            const eventType = line.substring(6).trim();

            // 找到对应的 data 行
            if (i + 1 < lines.length && lines[i + 1].startsWith('data:')) {
                const dataLine = lines[i + 1].substring(5).trim();
                if (!dataLine || dataLine === '{}') continue;

                try {
                    const data = JSON.parse(dataLine);

                    // SSE_REPLY_END with end_type: 1 的 brief 仅作兜底
                    if (eventType === 'SSE_REPLY_END' && data.end_type === 1) {
                        const brief = data.msg_finish_attr?.brief || '';
                        if (!resultText && brief) {
                            resultText = brief;
                        }
                    }

                    // STREAM_MSG_NOTIFY 检测深度思考块
                    if (eventType === 'STREAM_MSG_NOTIFY') {
                        const blocks = data.content?.content_block || [];
                        for (const block of blocks) {
                            if (block.block_type === 10040 && block.content?.thinking_block) {
                                inThinkingBlock = true;
                                thinkingBlockId = block.block_id;
                            }
                        }
                    }

                    // STREAM_CHUNK 处理内容块
                    if (eventType === 'STREAM_CHUNK' && data.patch_op) {
                        for (const op of data.patch_op) {
                            if (op.patch_object === 1 && op.patch_value?.content_block) {
                                for (const block of op.patch_value.content_block) {
                                    // 思考块结束标记
                                    if (block.block_type === 10040 && block.is_finish) {
                                        inThinkingBlock = false;
                                    }
                                    // 思考内容 (parent_id 指向 thinking_block)
                                    if (useThinking && block.parent_id === thinkingBlockId) {
                                        const text = block.content?.text_block?.text || '';
                                        if (text) reasoningText += text;
                                    }
                                    // 正文内容 (block_type 10000，非思考子块)
                                    else if (block.block_type === 10000 && block.parent_id !== thinkingBlockId) {
                                        const text = block.content?.text_block?.text || '';
                                        if (text) resultText += text;
                                    }
                                }
                            }
                        }
                    }

                    // CHUNK_DELTA 增量文本
                    if (eventType === 'CHUNK_DELTA') {
                        const text = data.text || '';
                        if (text) {
                            if (useThinking && inThinkingBlock) {
                                reasoningText += text;
                            } else {
                                resultText += text;
                            }
                        }
                    }

                } catch (e) {
                    // JSON 解析失败，跳过
                }
            }
        }
    }

    return { text: resultText, reasoning: reasoningText };
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'doubao_text',
    displayName: '豆包 (文本生成)',
    description: '使用字节跳动豆包生成文本，支持深度思考模式和图片上传。需要已登录的豆包账户。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        { id: 'seed', imagePolicy: 'optional', type: 'text' },
        { id: 'seed-thinking', imagePolicy: 'optional', type: 'text' },
        { id: 'seed-pro', imagePolicy: 'optional', type: 'text' }
    ],

    navigationHandlers: [],

    generate
};
