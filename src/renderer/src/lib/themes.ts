export interface ThemeColors {
  canvas: string
  sidebar: string
  surface: string
  surfaceRaised: string
  inset: string
  hover: string
  selected: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textSubtle: string
  accent: string
  accentHover: string
  accentSoft: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  purple: string
  cyan: string
  shadow: string
}

export interface SyntaxPalette {
  foreground: string
  comment: string
  keyword: string
  string: string
  number: string
  title: string
  variable: string
  type: string
  literal: string
  meta: string
  addition: string
  deletion: string
}

export interface TerminalPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeDef {
  id: string
  label: string
  description: string
  appearance: 'dark' | 'light'
  colors: ThemeColors
  syntax: SyntaxPalette
  terminal: TerminalPalette
}

const carbonColors: ThemeColors = {
  canvas: '#0b0d10', sidebar: '#0f1216', surface: '#13171c', surfaceRaised: '#181d24', inset: '#080a0d', hover: '#1c222b', selected: '#222a35',
  border: '#252c36', borderStrong: '#35404e', text: '#eef2f7', textMuted: '#a8b1bd', textSubtle: '#707b89', accent: '#77a7ff', accentHover: '#9bc0ff',
  accentSoft: 'rgba(119, 167, 255, 0.15)', success: '#63d297', successSoft: 'rgba(99, 210, 151, 0.14)', warning: '#e7b760', warningSoft: 'rgba(231, 183, 96, 0.14)',
  danger: '#f27b85', dangerSoft: 'rgba(242, 123, 133, 0.14)', purple: '#b59aff', cyan: '#62d4dc', shadow: 'rgba(0, 0, 0, 0.58)'
}

export const THEMES: ThemeDef[] = [
  {
    id: 'carbon',
    label: 'Carbon',
    description: 'Neutral and focused',
    appearance: 'dark',
    colors: carbonColors,
    syntax: {
      foreground: '#dbe2ea', comment: '#697482', keyword: '#c9a7ff', string: '#a6d189', number: '#efb785', title: '#82b6ff', variable: '#eaa3ad',
      type: '#74d4cf', literal: '#e7c66f', meta: '#9aa7ff', addition: '#8bd5a8', deletion: '#ef8b96'
    },
    terminal: {
      black: '#161a20', red: '#e5747e', green: '#65c98f', yellow: '#d9ad5b', blue: '#73a7f5', magenta: '#ae8ee6', cyan: '#5bc3ca', white: '#cbd2da',
      brightBlack: '#66717e', brightRed: '#f08a94', brightGreen: '#7bdca4', brightYellow: '#ebc46d', brightBlue: '#91b9ff', brightMagenta: '#c1a5fa', brightCyan: '#74d9df', brightWhite: '#f4f7fa'
    }
  },
  {
    id: 'ink',
    label: 'Ink',
    description: 'Deep navy and electric blue',
    appearance: 'dark',
    colors: {
      canvas: '#080b12', sidebar: '#0b101a', surface: '#101724', surfaceRaised: '#151e2e', inset: '#060910', hover: '#19253a', selected: '#1d2c45',
      border: '#223047', borderStrong: '#344966', text: '#edf4ff', textMuted: '#9eacc2', textSubtle: '#65748c', accent: '#70a5ff', accentHover: '#9bc0ff',
      accentSoft: 'rgba(112, 165, 255, 0.16)', success: '#5ed1a0', successSoft: 'rgba(94, 209, 160, 0.14)', warning: '#e9b75d', warningSoft: 'rgba(233, 183, 93, 0.14)',
      danger: '#f17887', dangerSoft: 'rgba(241, 120, 135, 0.14)', purple: '#a899ff', cyan: '#56d4e5', shadow: 'rgba(0, 3, 10, 0.68)'
    },
    syntax: {
      foreground: '#d8e5f7', comment: '#5f718c', keyword: '#b8a6ff', string: '#8ed8b0', number: '#f0b878', title: '#7eb0ff', variable: '#f096a6',
      type: '#64d5de', literal: '#f1cf74', meta: '#9ab4ff', addition: '#77d5a4', deletion: '#f1808e'
    },
    terminal: {
      black: '#111827', red: '#e66f7f', green: '#5bc997', yellow: '#dda94e', blue: '#6b9ff3', magenta: '#9b87e6', cyan: '#4fc5d3', white: '#cad7e9',
      brightBlack: '#5f6f87', brightRed: '#f38796', brightGreen: '#73d9ab', brightYellow: '#edc16a', brightBlue: '#8bb7ff', brightMagenta: '#b3a0f7', brightCyan: '#6ddbe6', brightWhite: '#f1f6ff'
    }
  },
  {
    id: 'orchid',
    label: 'Orchid',
    description: 'Soft plum with lilac accents',
    appearance: 'dark',
    colors: {
      canvas: '#100d15', sidebar: '#15101c', surface: '#1a1422', surfaceRaised: '#21192b', inset: '#0c0910', hover: '#291f35', selected: '#322640',
      border: '#34283f', borderStrong: '#4b3959', text: '#f5eff8', textMuted: '#b9aabd', textSubtle: '#7d6d84', accent: '#c099ed', accentHover: '#d5b5f6',
      accentSoft: 'rgba(192, 153, 237, 0.16)', success: '#70cf9f', successSoft: 'rgba(112, 207, 159, 0.14)', warning: '#e3b96b', warningSoft: 'rgba(227, 185, 107, 0.14)',
      danger: '#ef8294', dangerSoft: 'rgba(239, 130, 148, 0.14)', purple: '#c099ed', cyan: '#6ecbd0', shadow: 'rgba(5, 2, 8, 0.65)'
    },
    syntax: {
      foreground: '#e7dfea', comment: '#806f86', keyword: '#d6a9f0', string: '#a8cf8a', number: '#e6b77d', title: '#91b8ee', variable: '#ed9ca9',
      type: '#7ed0cb', literal: '#ebca78', meta: '#baa2e5', addition: '#8bd0a5', deletion: '#ef8c9b'
    },
    terminal: {
      black: '#1a1420', red: '#df7488', green: '#68c494', yellow: '#d6ab62', blue: '#84a9de', magenta: '#b58bd6', cyan: '#64bdc1', white: '#d8ccd9',
      brightBlack: '#77697c', brightRed: '#ee8b9c', brightGreen: '#80d4a7', brightYellow: '#e5bf7b', brightBlue: '#9dbfea', brightMagenta: '#ca9fea', brightCyan: '#7bd0d3', brightWhite: '#f5eef6'
    }
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm charcoal and amber',
    appearance: 'dark',
    colors: {
      canvas: '#100e0c', sidebar: '#15120f', surface: '#1a1612', surfaceRaised: '#211b16', inset: '#0c0a08', hover: '#2a221b', selected: '#342920',
      border: '#382d23', borderStrong: '#514031', text: '#f5f0e8', textMuted: '#b9ac9d', textSubtle: '#7f7265', accent: '#e6a75f', accentHover: '#f0bf82',
      accentSoft: 'rgba(230, 167, 95, 0.16)', success: '#82c997', successSoft: 'rgba(130, 201, 151, 0.14)', warning: '#e7b15c', warningSoft: 'rgba(231, 177, 92, 0.14)',
      danger: '#ed7d75', dangerSoft: 'rgba(237, 125, 117, 0.14)', purple: '#be9bd2', cyan: '#72c4c0', shadow: 'rgba(5, 3, 1, 0.66)'
    },
    syntax: {
      foreground: '#e8dfd3', comment: '#7e7165', keyword: '#d7a0c2', string: '#a8c98b', number: '#eab36f', title: '#8eb7d2', variable: '#e49a87',
      type: '#7fc7bb', literal: '#e5c171', meta: '#bd9fc7', addition: '#8bc79a', deletion: '#e8877f'
    },
    terminal: {
      black: '#1a1612', red: '#d97069', green: '#78bd8d', yellow: '#d9a553', blue: '#7fa9c6', magenta: '#ae8cc0', cyan: '#69b7b3', white: '#d8cec1',
      brightBlack: '#776b60', brightRed: '#e88982', brightGreen: '#90ce9f', brightYellow: '#e9bc70', brightBlue: '#97bed5', brightMagenta: '#c3a2d2', brightCyan: '#82cac5', brightWhite: '#f5eee5'
    }
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'Quiet warm light',
    appearance: 'light',
    colors: {
      canvas: '#f6f5f2', sidebar: '#efeee9', surface: '#ffffff', surfaceRaised: '#f1f0ec', inset: '#ebeae5', hover: '#e8e7e1', selected: '#dfe4ec',
      border: '#d8d6cf', borderStrong: '#bdbab1', text: '#25272b', textMuted: '#5e636b', textSubtle: '#898e95', accent: '#3d6fba', accentHover: '#2f5f9f',
      accentSoft: 'rgba(61, 111, 186, 0.12)', success: '#2f855a', successSoft: 'rgba(47, 133, 90, 0.11)', warning: '#a96816', warningSoft: 'rgba(169, 104, 22, 0.11)',
      danger: '#c44550', dangerSoft: 'rgba(196, 69, 80, 0.10)', purple: '#7656a8', cyan: '#237f87', shadow: 'rgba(38, 37, 33, 0.18)'
    },
    syntax: {
      foreground: '#30343a', comment: '#8a8f96', keyword: '#7352a3', string: '#3f7d45', number: '#9d5b2d', title: '#315f9e', variable: '#a84150',
      type: '#1d7478', literal: '#9a6b12', meta: '#5c66a7', addition: '#327a4e', deletion: '#b43c49'
    },
    terminal: {
      black: '#303238', red: '#b94952', green: '#367c50', yellow: '#9a681c', blue: '#3f6da9', magenta: '#74539c', cyan: '#287980', white: '#d8d7d2',
      brightBlack: '#777b82', brightRed: '#c95b64', brightGreen: '#478f61', brightYellow: '#ad7b2c', brightBlue: '#5684bd', brightMagenta: '#896ab0', brightCyan: '#3b8e95', brightWhite: '#faf9f6'
    }
  },
  {
    id: 'signal',
    label: 'Signal',
    description: 'High contrast and crisp',
    appearance: 'dark',
    colors: {
      canvas: '#050607', sidebar: '#090b0d', surface: '#0e1114', surfaceRaised: '#15191e', inset: '#020304', hover: '#1b2026', selected: '#222a32',
      border: '#333b44', borderStrong: '#66717c', text: '#ffffff', textMuted: '#c7cdd4', textSubtle: '#929ba5', accent: '#66b0ff', accentHover: '#a2d0ff',
      accentSoft: 'rgba(102, 176, 255, 0.2)', success: '#62e69a', successSoft: 'rgba(98, 230, 154, 0.18)', warning: '#ffd166', warningSoft: 'rgba(255, 209, 102, 0.18)',
      danger: '#ff7b86', dangerSoft: 'rgba(255, 123, 134, 0.18)', purple: '#c7a2ff', cyan: '#66e3ea', shadow: 'rgba(0, 0, 0, 0.8)'
    },
    syntax: {
      foreground: '#f2f5f8', comment: '#8c98a4', keyword: '#d3b2ff', string: '#a2e58e', number: '#ffc27d', title: '#8fc2ff', variable: '#ff9ca8',
      type: '#7ee9e2', literal: '#ffe07f', meta: '#aeb8ff', addition: '#8ff0b2', deletion: '#ff929d'
    },
    terminal: {
      black: '#0c0f12', red: '#ff747f', green: '#5fe293', yellow: '#f5c958', blue: '#62a9f5', magenta: '#be95f5', cyan: '#5bdae1', white: '#e5e9ed',
      brightBlack: '#87919b', brightRed: '#ff929b', brightGreen: '#80efa9', brightYellow: '#ffdc7f', brightBlue: '#8bc2ff', brightMagenta: '#d1afff', brightCyan: '#7ceaf0', brightWhite: '#ffffff'
    }
  }
]

const LEGACY_THEME_IDS: Record<string, string> = {
  graphite: 'carbon',
  'midnight-purple': 'orchid',
  dracula: 'orchid',
  'solarized-dark': 'ink',
  'solarized-light': 'paper'
}

function resolveTheme(id: string): ThemeDef {
  const resolved = LEGACY_THEME_IDS[id] ?? id
  return THEMES.find((theme) => theme.id === resolved) ?? THEMES[0]
}

function themeTokens(theme: ThemeDef): Record<`--${string}`, string> {
  const color = theme.colors
  return {
    '--bg': color.canvas,
    '--bg-elevated': color.surface,
    '--bg-inset': color.inset,
    '--bg-hover': color.hover,
    '--bg-active': color.selected,
    '--border': color.borderStrong,
    '--border-subtle': color.border,
    '--text': color.text,
    '--text-muted': color.textMuted,
    '--text-faint': color.textSubtle,
    '--accent': color.accent,
    '--accent-hover': color.accentHover,
    '--accent-soft': color.accentSoft,
    '--green': color.success,
    '--green-soft': color.successSoft,
    '--red': color.danger,
    '--red-soft': color.dangerSoft,
    '--yellow': color.warning,
    '--yellow-soft': color.warningSoft,
    '--purple': color.purple,
    '--cyan': color.cyan,
    '--surface-app': color.canvas,
    '--surface-sidebar': color.sidebar,
    '--surface-pane': color.surface,
    '--surface-raised': color.surfaceRaised,
    '--surface-hover': color.hover,
    '--surface-inset': color.inset,
    '--surface-selected': color.selected,
    '--surface-control': color.surfaceRaised,
    '--surface-overlay': color.surface,
    '--line-default': color.borderStrong,
    '--line-subtle': color.border,
    '--line-soft': color.border,
    '--line-strong': color.borderStrong,
    '--focus-ring': color.accent,
    '--shadow-lg': `0 18px 52px ${color.shadow}`
  }
}

function syntaxCss(theme: ThemeDef): string {
  const syntax = theme.syntax
  return `
.hljs { color: ${syntax.foreground}; background: transparent; }
.hljs-comment, .hljs-quote { color: ${syntax.comment}; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-name { color: ${syntax.keyword}; }
.hljs-string, .hljs-regexp, .hljs-attribute { color: ${syntax.string}; }
.hljs-number, .hljs-symbol, .hljs-bullet { color: ${syntax.number}; }
.hljs-title, .hljs-title.function_, .hljs-section { color: ${syntax.title}; }
.hljs-variable, .hljs-template-variable, .hljs-params { color: ${syntax.variable}; }
.hljs-type, .hljs-built_in, .hljs-class .hljs-title { color: ${syntax.type}; }
.hljs-literal, .hljs-selector-class, .hljs-selector-id { color: ${syntax.literal}; }
.hljs-meta, .hljs-meta .hljs-keyword { color: ${syntax.meta}; }
.hljs-addition { color: ${syntax.addition}; background: color-mix(in srgb, ${syntax.addition} 12%, transparent); }
.hljs-deletion { color: ${syntax.deletion}; background: color-mix(in srgb, ${syntax.deletion} 12%, transparent); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 650; }
`
}

export function getTheme(id?: string): ThemeDef {
  return resolveTheme(id ?? document.documentElement.dataset.theme ?? 'carbon')
}

export function getXtermTheme(id?: string): Record<string, string> {
  const theme = getTheme(id)
  return {
    background: theme.colors.canvas,
    foreground: theme.colors.text,
    cursor: theme.colors.accent,
    cursorAccent: theme.colors.canvas,
    selectionBackground: theme.colors.accentSoft,
    ...theme.terminal
  }
}

export function applyTheme(id: string): void {
  const theme = resolveTheme(id)
  document.documentElement.dataset.theme = theme.id
  document.documentElement.style.colorScheme = theme.appearance
  for (const [name, value] of Object.entries(themeTokens(theme))) {
    document.documentElement.style.setProperty(name, value)
  }

  let style = document.getElementById('hljs-theme') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'hljs-theme'
    document.head.appendChild(style)
  }
  style.textContent = syntaxCss(theme)

  try {
    localStorage.setItem('ralf.theme', theme.id)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('ralf:theme-changed', { detail: { id: theme.id } }))
}

export function loadTheme(): string {
  try {
    const saved = localStorage.getItem('ralf.theme')
    if (saved) return resolveTheme(saved).id
  } catch {
    /* ignore */
  }
  return 'carbon'
}
