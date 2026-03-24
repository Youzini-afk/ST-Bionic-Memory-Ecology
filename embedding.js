// ST-BME: 外部 Embedding API 封装 + 向量检索
// 支持 OpenAI 兼容的 /v1/embeddings 接口

/**
 * Embedding 服务
 * 调用外部 API 获取文本向量，并提供暴力搜索 cosine 相似度
 */

function normalizeOpenAICompatibleBaseUrl(value) {
    return String(value || '')
        .trim()
        .replace(/\/+(chat\/completions|embeddings)$/i, '')
        .replace(/\/+$/, '');
}

/**
 * 调用外部 Embedding API
 *
 * @param {string} text - 要嵌入的文本
 * @param {object} config - API 配置
 * @param {string} config.apiUrl - API 基地址（如 https://api.openai.com/v1）
 * @param {string} config.apiKey - API Key
 * @param {string} config.model - 模型名（如 text-embedding-3-small）
 * @returns {Promise<Float64Array|null>} 向量或 null
 */
export async function embedText(text, config) {
    const apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
    if (!text || !apiUrl || !config?.model) {
        console.warn('[ST-BME] Embedding 配置不完整，跳过');
        return null;
    }

    try {
        const response = await fetch(`${apiUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: config.model,
                input: text,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ST-BME] Embedding API 错误 (${response.status}):`, errorText);
            return null;
        }

        const data = await response.json();
        const vector = data?.data?.[0]?.embedding;

        if (!vector || !Array.isArray(vector)) {
            console.error('[ST-BME] Embedding API 返回格式异常:', data);
            return null;
        }

        return new Float64Array(vector);
    } catch (e) {
        console.error('[ST-BME] Embedding API 调用失败:', e);
        return null;
    }
}

/**
 * 批量嵌入文本
 *
 * @param {string[]} texts
 * @param {object} config
 * @returns {Promise<(Float64Array|null)[]>}
 */
export async function embedBatch(texts, config) {
    const apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
    if (!texts.length || !apiUrl || !config?.model) {
        return texts.map(() => null);
    }

    try {
        const response = await fetch(`${apiUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: config.model,
                input: texts,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ST-BME] Embedding API 批量错误 (${response.status}):`, errorText);
            return texts.map(() => null);
        }

        const data = await response.json();
        const embeddings = data?.data;

        if (!Array.isArray(embeddings)) {
            return texts.map(() => null);
        }

        // 按 index 排序（API 可能不保证顺序）
        embeddings.sort((a, b) => a.index - b.index);

        return embeddings.map(item => {
            if (item?.embedding && Array.isArray(item.embedding)) {
                return new Float64Array(item.embedding);
            }
            return null;
        });
    } catch (e) {
        console.error('[ST-BME] Embedding API 批量调用失败:', e);
        return texts.map(() => null);
    }
}

/**
 * 计算两个向量的 cosine 相似度
 *
 * @param {Float64Array|number[]} vecA
 * @param {Float64Array|number[]} vecB
 * @returns {number} 相似度 [-1, 1]
 */
export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
}

/**
 * 暴力搜索：找出与查询向量最相似的 Top-K 节点
 * PeroCore 的向量引擎也是暴力搜索（<1000 节点时比 HNSW 更快）
 *
 * @param {Float64Array|number[]} queryVec - 查询向量
 * @param {Array<{nodeId: string, embedding: Float64Array|number[]}>} candidates - 候选节点
 * @param {number} topK - 返回数量
 * @returns {Array<{nodeId: string, score: number}>} 按相似度降序
 */
export function searchSimilar(queryVec, candidates, topK = 20) {
    if (!queryVec || candidates.length === 0) return [];

    const scored = candidates
        .filter(c => c.embedding && c.embedding.length > 0)
        .map(c => ({
            nodeId: c.nodeId,
            score: cosineSimilarity(queryVec, c.embedding),
        }))
        .filter(item => item.score > 0);

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
}

/**
 * 测试 Embedding API 连通性
 *
 * @param {object} config - API 配置
 * @returns {Promise<{success: boolean, dimensions: number, error: string}>}
 */
export async function testConnection(config) {
    try {
        const vec = await embedText('test connection', config);
        if (vec) {
            return { success: true, dimensions: vec.length, error: '' };
        }
        return { success: false, dimensions: 0, error: 'API 返回空结果' };
    } catch (e) {
        return { success: false, dimensions: 0, error: String(e) };
    }
}
