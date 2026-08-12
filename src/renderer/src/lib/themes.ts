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
  diffAdditionBg: string
  diffAdditionGutter: string
  diffAdditionText: string
  diffDeletionBg: string
  diffDeletionGutter: string
  diffDeletionText: string
  diffHunkBg: string
  diffHunkText: string
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
  category: 'R.A.L.F.' | 'Community' | 'Accessibility'
  appearance: 'dark' | 'light'
  colors: ThemeColors
  syntax: SyntaxPalette
  terminal: TerminalPalette
}

// Community palettes follow their upstream projects so R.A.L.F., Highlight.js,
// and xterm share one visual source of truth:
// - Tokyo Night Moon: github.com/folke/tokyonight.nvim (Apache-2.0)
// - Catppuccin: github.com/catppuccin/palette (MIT)
// - Rosé Pine: github.com/rose-pine/palette (MIT)
export const THEMES: ThemeDef[] = [
  {
    id: 'ralf-dark',
    label: 'R.A.L.F. Dark',
    description: 'Neutral developer UI',
    category: 'R.A.L.F.',
    appearance: 'dark',
    colors: {
      canvas: '#0d1117', sidebar: '#090d13', surface: '#161b22', surfaceRaised: '#21262d', inset: '#010409', hover: '#1f252d', selected: '#252d38',
      border: '#30363d', borderStrong: '#484f58', text: '#f0f6fc', textMuted: '#b1bac4', textSubtle: '#7d8590', accent: '#58a6ff', accentHover: '#79c0ff',
      accentSoft: 'rgba(56, 139, 253, 0.17)', success: '#3fb950', successSoft: 'rgba(46, 160, 67, 0.16)', warning: '#d29922', warningSoft: 'rgba(187, 128, 9, 0.16)',
      danger: '#f85149', dangerSoft: 'rgba(248, 81, 73, 0.16)', purple: '#bc8cff', cyan: '#39c5cf', shadow: 'rgba(1, 4, 9, 0.7)',
      diffAdditionBg: '#12261b', diffAdditionGutter: '#1b4728', diffAdditionText: '#d8f3df', diffDeletionBg: '#321b1d', diffDeletionGutter: '#64262b', diffDeletionText: '#ffd8d5', diffHunkBg: '#202a44', diffHunkText: '#a5c8ff'
    },
    syntax: {
      foreground: '#e6edf3', comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', title: '#d2a8ff', variable: '#ffa657',
      type: '#7ee787', literal: '#79c0ff', meta: '#d2a8ff', addition: '#3fb950', deletion: '#f85149'
    },
    terminal: {
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    }
  },
  {
    id: 'ralf-light',
    label: 'R.A.L.F. Light',
    description: 'Crisp and understated',
    category: 'R.A.L.F.',
    appearance: 'light',
    colors: {
      canvas: '#f6f8fa', sidebar: '#f0f3f6', surface: '#ffffff', surfaceRaised: '#f3f4f6', inset: '#eef1f4', hover: '#eaeef2', selected: '#dbeafe',
      border: '#d0d7de', borderStrong: '#afb8c1', text: '#1f2328', textMuted: '#59636e', textSubtle: '#818b98', accent: '#0969da', accentHover: '#0550ae',
      accentSoft: 'rgba(9, 105, 218, 0.11)', success: '#1a7f37', successSoft: 'rgba(26, 127, 55, 0.11)', warning: '#9a6700', warningSoft: 'rgba(154, 103, 0, 0.11)',
      danger: '#cf222e', dangerSoft: 'rgba(207, 34, 46, 0.10)', purple: '#8250df', cyan: '#1b7c83', shadow: 'rgba(31, 35, 40, 0.18)',
      diffAdditionBg: '#dafbe1', diffAdditionGutter: '#aceebb', diffAdditionText: '#1f2328', diffDeletionBg: '#ffebe9', diffDeletionGutter: '#ffcecb', diffDeletionText: '#1f2328', diffHunkBg: '#ddf4ff', diffHunkText: '#0550ae'
    },
    syntax: {
      foreground: '#24292f', comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', title: '#8250df', variable: '#953800',
      type: '#116329', literal: '#0550ae', meta: '#8250df', addition: '#1a7f37', deletion: '#cf222e'
    },
    terminal: {
      black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#d0d7de',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00', brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#12666c', brightWhite: '#ffffff'
    }
  },
  {
    id: 'tokyo-night-moon',
    label: 'Tokyo Night Moon',
    description: 'Official Moon palette',
    category: 'Community',
    appearance: 'dark',
    colors: {
      canvas: '#222436', sidebar: '#1e2030', surface: '#282a3f', surfaceRaised: '#2f334d', inset: '#191b29', hover: '#2f334d', selected: '#394b70',
      border: '#3b4261', borderStrong: '#545c7e', text: '#c8d3f5', textMuted: '#a9b8e8', textSubtle: '#737aa2', accent: '#82aaff', accentHover: '#65bcff',
      accentSoft: 'rgba(130, 170, 255, 0.17)', success: '#c3e88d', successSoft: 'rgba(195, 232, 141, 0.13)', warning: '#ffc777', warningSoft: 'rgba(255, 199, 119, 0.13)',
      danger: '#ff757f', dangerSoft: 'rgba(255, 117, 127, 0.14)', purple: '#c099ff', cyan: '#86e1fc', shadow: 'rgba(17, 18, 30, 0.66)',
      diffAdditionBg: '#2a3b39', diffAdditionGutter: '#3b594a', diffAdditionText: '#d8edce', diffDeletionBg: '#49303d', diffDeletionGutter: '#6b3b48', diffDeletionText: '#ffd8df', diffHunkBg: '#303b5d', diffHunkText: '#b7ceff'
    },
    syntax: {
      foreground: '#c8d3f5', comment: '#636da6', keyword: '#c099ff', string: '#c3e88d', number: '#ff966c', title: '#82aaff', variable: '#fca7ea',
      type: '#86e1fc', literal: '#ffc777', meta: '#89ddff', addition: '#b8db87', deletion: '#e26a75'
    },
    terminal: {
      black: '#444a73', red: '#ff757f', green: '#c3e88d', yellow: '#ffc777', blue: '#82aaff', magenta: '#c099ff', cyan: '#86e1fc', white: '#c8d3f5',
      brightBlack: '#737aa2', brightRed: '#ff98a4', brightGreen: '#d5f3a6', brightYellow: '#ffdc97', brightBlue: '#a3bdff', brightMagenta: '#d2b6ff', brightCyan: '#b4f9f8', brightWhite: '#ffffff'
    }
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Soothing pastel dark',
    category: 'Community',
    appearance: 'dark',
    colors: {
      canvas: '#1e1e2e', sidebar: '#181825', surface: '#252536', surfaceRaised: '#313244', inset: '#11111b', hover: '#313244', selected: '#3b3c52',
      border: '#45475a', borderStrong: '#585b70', text: '#cdd6f4', textMuted: '#bac2de', textSubtle: '#7f849c', accent: '#89b4fa', accentHover: '#b4befe',
      accentSoft: 'rgba(137, 180, 250, 0.16)', success: '#a6e3a1', successSoft: 'rgba(166, 227, 161, 0.13)', warning: '#f9e2af', warningSoft: 'rgba(249, 226, 175, 0.13)',
      danger: '#f38ba8', dangerSoft: 'rgba(243, 139, 168, 0.14)', purple: '#cba6f7', cyan: '#94e2d5', shadow: 'rgba(10, 10, 16, 0.66)',
      diffAdditionBg: '#25372d', diffAdditionGutter: '#36513d', diffAdditionText: '#d8f0d5', diffDeletionBg: '#402a35', diffDeletionGutter: '#623748', diffDeletionText: '#ffdce7', diffHunkBg: '#30314c', diffHunkText: '#cdd8ff'
    },
    syntax: {
      foreground: '#cdd6f4', comment: '#6c7086', keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', title: '#89b4fa', variable: '#f5c2e7',
      type: '#94e2d5', literal: '#f9e2af', meta: '#b4befe', addition: '#a6e3a1', deletion: '#f38ba8'
    },
    terminal: {
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8'
    }
  },
  {
    id: 'rose-pine-moon',
    label: 'Rosé Pine Moon',
    description: 'Warm, quiet contrast',
    category: 'Community',
    appearance: 'dark',
    colors: {
      canvas: '#232136', sidebar: '#1f1d2e', surface: '#2a273f', surfaceRaised: '#393552', inset: '#191724', hover: '#312e49', selected: '#393552',
      border: '#44405f', borderStrong: '#56516f', text: '#e0def4', textMuted: '#b5b1cc', textSubtle: '#908caa', accent: '#c4a7e7', accentHover: '#d7c2ee',
      accentSoft: 'rgba(196, 167, 231, 0.16)', success: '#9ccfd8', successSoft: 'rgba(156, 207, 216, 0.13)', warning: '#f6c177', warningSoft: 'rgba(246, 193, 119, 0.13)',
      danger: '#eb6f92', dangerSoft: 'rgba(235, 111, 146, 0.14)', purple: '#c4a7e7', cyan: '#9ccfd8', shadow: 'rgba(15, 13, 25, 0.65)',
      diffAdditionBg: '#283c45', diffAdditionGutter: '#365662', diffAdditionText: '#d9f0f2', diffDeletionBg: '#422938', diffDeletionGutter: '#613548', diffDeletionText: '#ffdce7', diffHunkBg: '#34304e', diffHunkText: '#dbc5f3'
    },
    syntax: {
      foreground: '#e0def4', comment: '#6e6a86', keyword: '#c4a7e7', string: '#f6c177', number: '#ea9a97', title: '#9ccfd8', variable: '#ebbcba',
      type: '#9ccfd8', literal: '#f6c177', meta: '#c4a7e7', addition: '#9ccfd8', deletion: '#eb6f92'
    },
    terminal: {
      black: '#393552', red: '#eb6f92', green: '#3e8fb0', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ea9a97', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#9ccfd8', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#ffffff'
    }
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    description: 'Maximum separation',
    category: 'Accessibility',
    appearance: 'dark',
    colors: {
      canvas: '#050607', sidebar: '#090b0d', surface: '#0e1114', surfaceRaised: '#15191e', inset: '#020304', hover: '#1b2026', selected: '#222a32',
      border: '#333b44', borderStrong: '#66717c', text: '#ffffff', textMuted: '#c7cdd4', textSubtle: '#929ba5', accent: '#66b0ff', accentHover: '#a2d0ff',
      accentSoft: 'rgba(102, 176, 255, 0.2)', success: '#62e69a', successSoft: 'rgba(98, 230, 154, 0.18)', warning: '#ffd166', warningSoft: 'rgba(255, 209, 102, 0.18)',
      danger: '#ff7b86', dangerSoft: 'rgba(255, 123, 134, 0.18)', purple: '#c7a2ff', cyan: '#66e3ea', shadow: 'rgba(0, 0, 0, 0.8)',
      diffAdditionBg: '#123322', diffAdditionGutter: '#17502e', diffAdditionText: '#e0ffe9', diffDeletionBg: '#3a181d', diffDeletionGutter: '#68262d', diffDeletionText: '#ffe5e7', diffHunkBg: '#172d4a', diffHunkText: '#c4ddff'
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
  graphite: 'ralf-dark',
  carbon: 'ralf-dark',
  ink: 'tokyo-night-moon',
  'midnight-purple': 'rose-pine-moon',
  dracula: 'rose-pine-moon',
  orchid: 'rose-pine-moon',
  ember: 'ralf-dark',
  paper: 'ralf-light',
  signal: 'high-contrast',
  'solarized-dark': 'ralf-dark',
  'solarized-light': 'ralf-light'
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
    '--shadow-lg': `0 18px 52px ${color.shadow}`,
    '--diff-add-bg': color.diffAdditionBg,
    '--diff-add-gutter': color.diffAdditionGutter,
    '--diff-add-text': color.diffAdditionText,
    '--diff-del-bg': color.diffDeletionBg,
    '--diff-del-gutter': color.diffDeletionGutter,
    '--diff-del-text': color.diffDeletionText,
    '--diff-hunk-bg': color.diffHunkBg,
    '--diff-hunk-text': color.diffHunkText
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
  return resolveTheme(id ?? document.documentElement.dataset.theme ?? 'ralf-dark')
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
  return 'ralf-dark'
}
