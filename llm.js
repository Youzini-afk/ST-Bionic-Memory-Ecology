// ST-BME: LLM 调用封装
// 包装 ST 的 sendOpenAIRequest，提供结构化 JSON 输出和重试机制

import { extension_settings } from "../../../extensions.js";
import { chat_completion_sources, sendOpenAIRequest } from "../../../openai.js";
import { getRequestHeaders } from "../../../../script.js";

const MODULE_NAME = "st_bme";

function getMemoryLLMConfig() {
    const settings = extension_settings[MODULE_NAME] || {};
    return {
        apiUrl: normalizeOpenAICompatibleBaseUrl(settings.llmApiUrl),
        apiKey: String(settings.llmApiKey || '').trim(),
        model: String(settings.llmModel || '').trim(),
    };
}

function normalizeOpenAICompatibleBaseUrl(value) {
    return String(value || '')
        .trim()
        .replace(/\/+(chat\/completions|embeddings)$/i, '')
        .replace(/\/+$/, '');
}

function hasDedicatedLLMConfig(config = getMemoryLLMConfig()) {
    return Boolean(config.apiUrl && config.model);
}

async function callDedicatedOpenAICompatible(messages, { signal } = {}) {
    const config = getMemoryLLMConfig();
    if (!hasDedicatedLLMConfig(config)) {
        return await sendOpenAIRequest('quiet', messages, signal);
    }

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: chat_completion_sources.OPENAI,
            reverse_proxy: config.apiUrl,
            proxy_password: config.apiKey || '',
            model: config.model,
            messages,
            temperature: 0.2,
            max_tokens: 1200,
            max_completion_tokens: 1200,
            stream: false,
        }),
        signal,
    });

    const responseText = await response.text().catch(() => '');
    let data;

    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        data = { error: { message: responseText || response.statusText } };
    }

    if (!response.ok) {
        const message = data?.error?.message || response.statusText;
        throw new Error(`Memory LLM proxy error ${response.status}: ${message}`);
    }

    if (data?.error?.message) {
        throw new Error(`Memory LLM proxy error: ${data.error.message}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => item?.text || item?.content || '')
            .join('')
            .trim();
    }

    throw new Error('Memory LLM API returned an unexpected response format');
}

/**
 * 调用 LLM 并期望返回结构化 JSON
 *
 * @param {object} params
 * @param {string} params.systemPrompt - 系统提示词
 * @param {string} params.userPrompt - 用户提示词
 * @param {number} [params.maxRetries=2] - JSON 解析失败时的重试次数
 * @param {string} [params.model] - 指定模型（留空使用当前配置）
 * @returns {Promise<object|null>} 解析后的 JSON 对象，或 null
 */
export async function callLLMForJSON({ systemPrompt, userPrompt, maxRetries = 2 }) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await callDedicatedOpenAICompatible(messages);

            if (!response || typeof response !== 'string') {
                console.warn(`[ST-BME] LLM 返回空响应 (尝试 ${attempt + 1})`);
                continue;
            }

            // 尝试解析 JSON
            const parsed = extractJSON(response);
            if (parsed !== null) {
                return parsed;
            }

            console.warn(`[ST-BME] LLM 响应无法解析为 JSON (尝试 ${attempt + 1}):`, response.slice(0, 200));

            // 重试时在 user prompt 中追加提示
            if (attempt < maxRetries) {
                messages.push({ role: 'assistant', content: response });
                messages.push({ role: 'user', content: '你的上一次输出无法被解析为有效 JSON。请严格按照要求的 JSON 格式重新输出，不要包含 markdown 代码块标记或其他非 JSON 文本。' });
            }
        } catch (e) {
            console.error(`[ST-BME] LLM 调用失败 (尝试 ${attempt + 1}):`, e);
        }
    }

    return null;
}

/**
 * 调用 LLM（不要求 JSON 输出）
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string|null>}
 */
export async function callLLM(systemPrompt, userPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    try {
        const response = await callDedicatedOpenAICompatible(messages);
        return response || null;
    } catch (e) {
        console.error('[ST-BME] LLM 调用失败:', e);
        return null;
    }
}

/**
 * 测试记忆 LLM 连通性
 * 若未配置独立记忆 LLM，则测试当前 SillyTavern 聊天模型。
 *
 * @returns {Promise<{success: boolean, mode: string, error: string}>}
 */
export async function testLLMConnection() {
    const config = getMemoryLLMConfig();
    const mode = hasDedicatedLLMConfig(config)
        ? `dedicated:${config.model}`
        : 'sillytavern-current-model';

    try {
        const response = await callLLM(
            '你是一个连接测试助手。请只回答 OK。',
            '请只回复 OK',
        );
        if (typeof response === 'string' && response.trim().length > 0) {
            return { success: true, mode, error: '' };
        }
        return { success: false, mode, error: 'API 返回空结果' };
    } catch (e) {
        return { success: false, mode, error: String(e) };
    }
}

/**
 * 从 LLM 响应文本中提取 JSON 对象
 * 处理各种常见格式：纯 JSON、markdown 代码块、混合文本等
 *
 * @param {string} text
 * @returns {object|null}
 */
function extractJSON(text) {
    if (!text || typeof text !== 'string') return null;

    const trimmed = text.trim();

    // 1. 直接尝试解析
    try {
        return JSON.parse(trimmed);
    } catch { /* continue */ }

    // 2. 尝试提取 markdown 代码块中的 JSON
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
        try {
            return JSON.parse(codeBlockMatch[1].trim());
        } catch { /* continue */ }
    }

    // 3. 尝试找到第一个 { 或 [ 开始的 JSON
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');

    let startIdx = -1;
    let endChar = '';

    if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
        startIdx = firstBrace;
        endChar = '}';
    } else if (firstBracket >= 0) {
        startIdx = firstBracket;
        endChar = ']';
    }

    if (startIdx >= 0) {
        // 从后往前找匹配的结束字符
        const lastEnd = trimmed.lastIndexOf(endChar);
        if (lastEnd > startIdx) {
            try {
                return JSON.parse(trimmed.slice(startIdx, lastEnd + 1));
            } catch { /* continue */ }
        }
    }

    return null;
}
