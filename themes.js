// ST-BME: 主题配色系统
// 多套 CSS 变量主题，通过 data-bme-theme 属性切换

export const THEMES = {
    crimson: {
        name: 'Crimson Synth',
        primary: '#e94560',
        primaryDim: 'rgba(233, 69, 96, 0.15)',
        primaryGlow: 'rgba(233, 69, 96, 0.35)',
        primaryText: '#ffb2b7',
        secondary: '#fc536d',
        accent2: '#4edea3',       // tertiary / success
        accent3: '#ffc107',       // warning / P1
        surface: '#131316',
        surfaceContainer: '#1f1f22',
        surfaceHigh: '#2a2a2d',
        surfaceHighest: '#353438',
        surfaceLow: '#1b1b1e',
        surfaceLowest: '#0e0e11',
        onSurface: '#e4e1e6',
        onSurfaceDim: 'rgba(228, 225, 230, 0.6)',
        border: 'rgba(255, 255, 255, 0.08)',
        borderActive: 'rgba(233, 69, 96, 0.4)',
        // 节点颜色
        nodeCharacter: '#e94560',
        nodeEvent: '#4fc3f7',
        nodeLocation: '#66bb6a',
        nodeThread: '#ffd54f',
        nodeRule: '#ab47bc',
        nodeSynopsis: '#b388ff',
        nodeReflection: '#80deea',
    },
    cyan: {
        name: 'Neon Cyan',
        primary: '#00e5ff',
        primaryDim: 'rgba(0, 229, 255, 0.15)',
        primaryGlow: 'rgba(0, 229, 255, 0.35)',
        primaryText: '#80f0ff',
        secondary: '#2979ff',
        accent2: '#00e676',
        accent3: '#ffab40',
        surface: '#131316',
        surfaceContainer: '#1a1f22',
        surfaceHigh: '#222a2d',
        surfaceHighest: '#2d3538',
        surfaceLow: '#171d1e',
        surfaceLowest: '#0e1111',
        onSurface: '#e0f7fa',
        onSurfaceDim: 'rgba(224, 247, 250, 0.6)',
        border: 'rgba(0, 229, 255, 0.1)',
        borderActive: 'rgba(0, 229, 255, 0.4)',
        nodeCharacter: '#00e5ff',
        nodeEvent: '#2979ff',
        nodeLocation: '#00bfa5',
        nodeThread: '#ffab40',
        nodeRule: '#7c4dff',
        nodeSynopsis: '#18ffff',
        nodeReflection: '#84ffff',
    },
    amber: {
        name: 'Amber Console',
        primary: '#ffb300',
        primaryDim: 'rgba(255, 179, 0, 0.15)',
        primaryGlow: 'rgba(255, 179, 0, 0.35)',
        primaryText: '#ffd79b',
        secondary: '#e65100',
        accent2: '#00d2fe',
        accent3: '#ff6e40',
        surface: '#131316',
        surfaceContainer: '#1f1d1a',
        surfaceHigh: '#2a2822',
        surfaceHighest: '#35322a',
        surfaceLow: '#1b1a17',
        surfaceLowest: '#0e0d0b',
        onSurface: '#e4e1d6',
        onSurfaceDim: 'rgba(228, 225, 214, 0.6)',
        border: 'rgba(255, 179, 0, 0.1)',
        borderActive: 'rgba(255, 179, 0, 0.4)',
        nodeCharacter: '#ffb300',
        nodeEvent: '#e65100',
        nodeLocation: '#00d2fe',
        nodeThread: '#ff6e40',
        nodeRule: '#9e9d24',
        nodeSynopsis: '#ffd740',
        nodeReflection: '#ffab40',
    },
    violet: {
        name: 'Violet Haze',
        primary: '#b388ff',
        primaryDim: 'rgba(179, 136, 255, 0.15)',
        primaryGlow: 'rgba(179, 136, 255, 0.35)',
        primaryText: '#d1b3ff',
        secondary: '#7c4dff',
        accent2: '#ea80fc',
        accent3: '#ff80ab',
        surface: '#131316',
        surfaceContainer: '#1e1a22',
        surfaceHigh: '#28222d',
        surfaceHighest: '#332b38',
        surfaceLow: '#1a171e',
        surfaceLowest: '#0e0c11',
        onSurface: '#e8e0f0',
        onSurfaceDim: 'rgba(232, 224, 240, 0.6)',
        border: 'rgba(179, 136, 255, 0.1)',
        borderActive: 'rgba(179, 136, 255, 0.4)',
        nodeCharacter: '#ea80fc',
        nodeEvent: '#7c4dff',
        nodeLocation: '#80cbc4',
        nodeThread: '#ff80ab',
        nodeRule: '#b388ff',
        nodeSynopsis: '#ce93d8',
        nodeReflection: '#80deea',
    },
    /** 亮色 · 晨光纸感（暖纸面 + 青绿主色 + 琥珀强调） */
    paperDawn: {
        name: '晨光纸感',
        primary: '#0d9488',
        primaryDim: 'rgba(13, 148, 136, 0.14)',
        primaryGlow: 'rgba(13, 148, 136, 0.32)',
        primaryText: '#0f766e',
        secondary: '#d97706',
        accent2: '#0284c7',
        accent3: '#ea580c',
        surface: '#f7f4ef',
        surfaceContainer: '#fffcf7',
        surfaceHigh: '#efeae2',
        surfaceHighest: '#e2ddd4',
        surfaceLow: '#faf8f5',
        surfaceLowest: '#f0ebe4',
        onSurface: '#1c1917',
        onSurfaceDim: 'rgba(28, 25, 23, 0.78)',
        border: 'rgba(28, 25, 23, 0.09)',
        borderActive: 'rgba(13, 148, 136, 0.42)',
        nodeCharacter: '#ea580c',
        nodeEvent: '#0284c7',
        nodeLocation: '#16a34a',
        nodeThread: '#d97706',
        nodeRule: '#7c3aed',
        nodeSynopsis: '#0d9488',
        nodeReflection: '#64748b',
    },
    /** 亮色 · 冰川晴空（冷灰底 + 蓝主色 + 青/紫辅色） */
    glacierSky: {
        name: '冰川晴空',
        primary: '#2563eb',
        primaryDim: 'rgba(37, 99, 235, 0.12)',
        primaryGlow: 'rgba(37, 99, 235, 0.28)',
        primaryText: '#1d4ed8',
        secondary: '#0891b2',
        accent2: '#7c3aed',
        accent3: '#f59e0b',
        surface: '#f8fafc',
        surfaceContainer: '#ffffff',
        surfaceHigh: '#e2e8f0',
        surfaceHighest: '#cbd5e1',
        surfaceLow: '#f1f5f9',
        surfaceLowest: '#e2e8f0',
        onSurface: '#0f172a',
        onSurfaceDim: 'rgba(15, 23, 42, 0.76)',
        border: 'rgba(15, 23, 42, 0.08)',
        borderActive: 'rgba(37, 99, 235, 0.42)',
        nodeCharacter: '#c026d3',
        nodeEvent: '#0369a1',
        nodeLocation: '#059669',
        nodeThread: '#f59e0b',
        nodeRule: '#7c3aed',
        nodeSynopsis: '#2563eb',
        nodeReflection: '#0891b2',
    },
};

/** 使用亮色 color-scheme 的面板主题（原生 number/select 等控件配色） */
export const LIGHT_PANEL_THEMES = new Set(['paperDawn', 'glacierSky']);

/**
 * 将主题配色应用为 CSS 变量
 * @param {string} themeName - crimson | cyan | amber | violet | paperDawn | glacierSky
 * @param {HTMLElement} [root] - 目标元素，默认 document.documentElement
 */
export function applyTheme(themeName, root = null) {
    const theme = THEMES[themeName] || THEMES.crimson;
    const el = root || document.documentElement;

    const vars = {
        '--bme-primary': theme.primary,
        '--bme-primary-dim': theme.primaryDim,
        '--bme-primary-glow': theme.primaryGlow,
        '--bme-primary-text': theme.primaryText,
        '--bme-secondary': theme.secondary,
        '--bme-accent2': theme.accent2,
        '--bme-accent3': theme.accent3,
        '--bme-surface': theme.surface,
        '--bme-surface-container': theme.surfaceContainer,
        '--bme-surface-high': theme.surfaceHigh,
        '--bme-surface-highest': theme.surfaceHighest,
        '--bme-surface-low': theme.surfaceLow,
        '--bme-surface-lowest': theme.surfaceLowest,
        '--bme-on-surface': theme.onSurface,
        '--bme-on-surface-dim': theme.onSurfaceDim,
        '--bme-border': theme.border,
        '--bme-border-active': theme.borderActive,
        '--bme-node-character': theme.nodeCharacter,
        '--bme-node-event': theme.nodeEvent,
        '--bme-node-location': theme.nodeLocation,
        '--bme-node-thread': theme.nodeThread,
        '--bme-node-rule': theme.nodeRule,
        '--bme-node-synopsis': theme.nodeSynopsis,
        '--bme-node-reflection': theme.nodeReflection,
    };

    for (const [key, value] of Object.entries(vars)) {
        el.style.setProperty(key, value);
    }
    el.setAttribute('data-bme-theme', themeName);
    el.setAttribute(
        'data-bme-color-scheme',
        LIGHT_PANEL_THEMES.has(themeName) ? 'light' : 'dark',
    );
}

/**
 * 获取当前主题的节点颜色映射
 * @param {string} themeName
 * @returns {Object<string, string>}
 */
export function getNodeColors(themeName) {
    const theme = THEMES[themeName] || THEMES.crimson;
    return {
        character: theme.nodeCharacter,
        event:     theme.nodeEvent,
        location:  theme.nodeLocation,
        thread:    theme.nodeThread,
        rule:      theme.nodeRule,
        synopsis:  theme.nodeSynopsis,
        reflection: theme.nodeReflection,
    };
}
