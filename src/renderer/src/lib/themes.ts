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
  /** Text drawn on top of the accent, which is not white on a light accent. */
  accentInk: string
  /** Text drawn on top of the danger and warning fills, for the same reason. */
  dangerInk: string
  warningInk: string
  /** One hue per agent, so a backend reads the same in a badge and on a tab. */
  backendClaude: string
  backendCodex: string
  backendPi: string
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
  category: 'BOSS' | 'Community' | 'Accessibility'
  appearance: 'dark' | 'light'
  colors: ThemeColors
  syntax: SyntaxPalette
  terminal: TerminalPalette
}

export type ThemeAppearance = 'system' | 'light' | 'dark'
export type ResolvedThemeAppearance = Exclude<ThemeAppearance, 'system'>

export interface ThemePreference {
  family: string
  appearance: ThemeAppearance
}

export interface ThemeFamily {
  id: string
  label: string
  description: string
  category: ThemeDef['category']
  light: string
  dark: string
}

export interface ThemeChangedDetail extends ThemePreference {
  id: string
  resolvedAppearance: ResolvedThemeAppearance
}

// Community palettes follow their upstream projects so BOSS, Highlight.js,
// and xterm share one visual source of truth:
// - Tokyo Night Moon: github.com/folke/tokyonight.nvim (Apache-2.0)
// - Catppuccin: github.com/catppuccin/palette (MIT)
// - Rosé Pine: github.com/rose-pine/palette (MIT)
// - Solarized: github.com/altercation/solarized (MIT)
export const THEMES: ThemeDef[] = [
  {
    id: 'boss-dark',
    label: 'BOSS Dark',
    description: 'Neutral developer UI',
    category: 'BOSS',
    appearance: 'dark',
    colors: {
      canvas: '#0d1117', sidebar: '#090d13', surface: '#161b22', surfaceRaised: '#21262d', inset: '#010409', hover: '#1f252d', selected: '#252d38',
      border: '#30363d', borderStrong: '#484f58', text: '#f0f6fc', textMuted: '#b1bac4', textSubtle: '#7d8590', accent: '#58a6ff', accentInk: '#08131f', backendClaude: '#d8916f', backendCodex: '#77c7a4', backendPi: '#d4a75e', accentHover: '#79c0ff',
      accentSoft: 'rgba(56, 139, 253, 0.17)', success: '#3fb950', successSoft: 'rgba(46, 160, 67, 0.16)', warning: '#d29922', warningInk: '#1a1400', warningSoft: 'rgba(187, 128, 9, 0.16)',
      danger: '#f85149', dangerInk: '#1f0705', dangerSoft: 'rgba(248, 81, 73, 0.16)', purple: '#bc8cff', cyan: '#39c5cf', shadow: 'rgba(1, 4, 9, 0.7)',
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
    id: 'boss-light',
    label: 'BOSS Light',
    description: 'Crisp and understated',
    category: 'BOSS',
    appearance: 'light',
    colors: {
      canvas: '#f6f8fa', sidebar: '#f0f3f6', surface: '#ffffff', surfaceRaised: '#f3f4f6', inset: '#eef1f4', hover: '#eaeef2', selected: '#dbeafe',
      border: '#d0d7de', borderStrong: '#afb8c1', text: '#1f2328', textMuted: '#59636e', textSubtle: '#818b98', accent: '#0969da', accentInk: '#ffffff', backendClaude: '#d8916f', backendCodex: '#77c7a4', backendPi: '#d4a75e', accentHover: '#0550ae',
      accentSoft: 'rgba(9, 105, 218, 0.11)', success: '#1a7f37', successSoft: 'rgba(26, 127, 55, 0.11)', warning: '#9a6700', warningInk: '#ffffff', warningSoft: 'rgba(154, 103, 0, 0.11)',
      danger: '#cf222e', dangerInk: '#ffffff', dangerSoft: 'rgba(207, 34, 46, 0.10)', purple: '#8250df', cyan: '#1b7c83', shadow: 'rgba(31, 35, 40, 0.18)',
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
    id: 'tokyo-night-day',
    label: 'Tokyo Night Day',
    description: 'Clear, cool daylight',
    category: 'Community',
    appearance: 'light',
    colors: {
      canvas: '#e1e2e7', sidebar: '#d8dbe5', surface: '#f2f3f5', surfaceRaised: '#d0d5e3', inset: '#c9cddd', hover: '#d5d9e5', selected: '#c4c8da',
      border: '#b4b8ca', borderStrong: '#9699a8', text: '#3760bf', textMuted: '#4c5c88', textSubtle: '#737aa2', accent: '#2868c7', accentInk: '#ffffff', backendClaude: '#9d5b42', backendCodex: '#26785b', backendPi: '#86610b', accentHover: '#1f55aa',
      accentSoft: 'rgba(46, 125, 233, 0.13)', success: '#587539', successSoft: 'rgba(88, 117, 57, 0.13)', warning: '#8c6c3e', warningInk: '#ffffff', warningSoft: 'rgba(140, 108, 62, 0.13)',
      danger: '#c21f52', dangerInk: '#ffffff', dangerSoft: 'rgba(194, 31, 82, 0.12)', purple: '#7847bd', cyan: '#007197', shadow: 'rgba(76, 92, 136, 0.22)',
      diffAdditionBg: '#d8e5d1', diffAdditionGutter: '#bfd2b5', diffAdditionText: '#29421b', diffDeletionBg: '#f1d4dc', diffDeletionGutter: '#e5b6c4', diffDeletionText: '#65112c', diffHunkBg: '#ccd9ed', diffHunkText: '#244d8f'
    },
    syntax: {
      foreground: '#3760bf', comment: '#737aa2', keyword: '#7847bd', string: '#587539', number: '#b15c00', title: '#2e7de9', variable: '#9854a8',
      type: '#007197', literal: '#8c6c3e', meta: '#166775', addition: '#587539', deletion: '#c21f52'
    },
    terminal: {
      black: '#0f0f14', red: '#c21f52', green: '#587539', yellow: '#8c6c3e', blue: '#2e7de9', magenta: '#7847bd', cyan: '#007197', white: '#9699a8',
      brightBlack: '#6172b0', brightRed: '#f52a65', brightGreen: '#658c3d', brightYellow: '#b15c00', brightBlue: '#2e7de9', brightMagenta: '#9854f1', brightCyan: '#007197', brightWhite: '#3760bf'
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
      border: '#3b4261', borderStrong: '#545c7e', text: '#c8d3f5', textMuted: '#a9b8e8', textSubtle: '#737aa2', accent: '#82aaff', accentInk: '#0d1526', backendClaude: '#d8916f', backendCodex: '#77c7a4', backendPi: '#d4a75e', accentHover: '#65bcff',
      accentSoft: 'rgba(130, 170, 255, 0.17)', success: '#c3e88d', successSoft: 'rgba(195, 232, 141, 0.13)', warning: '#ffc777', warningInk: '#241800', warningSoft: 'rgba(255, 199, 119, 0.13)',
      danger: '#ff757f', dangerInk: '#280a0e', dangerSoft: 'rgba(255, 117, 127, 0.14)', purple: '#c099ff', cyan: '#86e1fc', shadow: 'rgba(17, 18, 30, 0.66)',
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
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    description: 'Soft pastel daylight',
    category: 'Community',
    appearance: 'light',
    colors: {
      canvas: '#eff1f5', sidebar: '#e6e9ef', surface: '#ffffff', surfaceRaised: '#dce0e8', inset: '#e6e9ef', hover: '#dce0e8', selected: '#ccd0da',
      border: '#ccd0da', borderStrong: '#9ca0b0', text: '#4c4f69', textMuted: '#6c6f85', textSubtle: '#8c8fa1', accent: '#1e66f5', accentInk: '#ffffff', backendClaude: '#9d5b42', backendCodex: '#26785b', backendPi: '#86610b', accentHover: '#1a56cf',
      accentSoft: 'rgba(30, 102, 245, 0.12)', success: '#317521', successSoft: 'rgba(64, 160, 43, 0.12)', warning: '#985f00', warningInk: '#ffffff', warningSoft: 'rgba(223, 142, 29, 0.14)',
      danger: '#d20f39', dangerInk: '#ffffff', dangerSoft: 'rgba(210, 15, 57, 0.11)', purple: '#8839ef', cyan: '#0d7374', shadow: 'rgba(76, 79, 105, 0.2)',
      diffAdditionBg: '#dcebd7', diffAdditionGutter: '#bdd9b5', diffAdditionText: '#254a1e', diffDeletionBg: '#f5d8df', diffDeletionGutter: '#edb8c4', diffDeletionText: '#6d0b21', diffHunkBg: '#d8e3fa', diffHunkText: '#174ba9'
    },
    syntax: {
      foreground: '#4c4f69', comment: '#8c8fa1', keyword: '#8839ef', string: '#317521', number: '#c55400', title: '#1e66f5', variable: '#a53689',
      type: '#0d7374', literal: '#985f00', meta: '#5367bd', addition: '#317521', deletion: '#d20f39'
    },
    terminal: {
      black: '#5c5f77', red: '#d20f39', green: '#317521', yellow: '#985f00', blue: '#1e66f5', magenta: '#8839ef', cyan: '#0d7374', white: '#bcc0cc',
      brightBlack: '#7c7f93', brightRed: '#d20f39', brightGreen: '#317521', brightYellow: '#b36b00', brightBlue: '#1e66f5', brightMagenta: '#8839ef', brightCyan: '#179299', brightWhite: '#ffffff'
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
      border: '#45475a', borderStrong: '#585b70', text: '#cdd6f4', textMuted: '#bac2de', textSubtle: '#7f849c', accent: '#89b4fa', accentInk: '#11131f', backendClaude: '#d8916f', backendCodex: '#77c7a4', backendPi: '#d4a75e', accentHover: '#b4befe',
      accentSoft: 'rgba(137, 180, 250, 0.16)', success: '#a6e3a1', successSoft: 'rgba(166, 227, 161, 0.13)', warning: '#f9e2af', warningInk: '#241f00', warningSoft: 'rgba(249, 226, 175, 0.13)',
      danger: '#f38ba8', dangerInk: '#2a0d16', dangerSoft: 'rgba(243, 139, 168, 0.14)', purple: '#cba6f7', cyan: '#94e2d5', shadow: 'rgba(10, 10, 16, 0.66)',
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
    id: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    description: 'Warm, quiet daylight',
    category: 'Community',
    appearance: 'light',
    colors: {
      canvas: '#faf4ed', sidebar: '#f2e9e1', surface: '#fffaf3', surfaceRaised: '#f4ede8', inset: '#f2e9e1', hover: '#eee5df', selected: '#dfdad9',
      border: '#dfdad9', borderStrong: '#b8b3bd', text: '#575279', textMuted: '#797593', textSubtle: '#9893a5', accent: '#286983', accentInk: '#ffffff', backendClaude: '#9d5b42', backendCodex: '#26785b', backendPi: '#86610b', accentHover: '#1f5368',
      accentSoft: 'rgba(40, 105, 131, 0.12)', success: '#3d7680', successSoft: 'rgba(86, 148, 159, 0.13)', warning: '#a5650f', warningInk: '#ffffff', warningSoft: 'rgba(234, 157, 52, 0.14)',
      danger: '#a94f69', dangerInk: '#ffffff', dangerSoft: 'rgba(180, 99, 122, 0.12)', purple: '#785f91', cyan: '#3d7680', shadow: 'rgba(87, 82, 121, 0.18)',
      diffAdditionBg: '#deebe7', diffAdditionGutter: '#bed8d2', diffAdditionText: '#285159', diffDeletionBg: '#f1dce1', diffDeletionGutter: '#dfbdc7', diffDeletionText: '#6c2c3e', diffHunkBg: '#e1ddea', diffHunkText: '#58466d'
    },
    syntax: {
      foreground: '#575279', comment: '#9893a5', keyword: '#785f91', string: '#8a5a11', number: '#a95755', title: '#286983', variable: '#a95570',
      type: '#3d7680', literal: '#a5650f', meta: '#785f91', addition: '#3d7680', deletion: '#a94f69'
    },
    terminal: {
      black: '#575279', red: '#a94f69', green: '#3d7680', yellow: '#a5650f', blue: '#286983', magenta: '#785f91', cyan: '#a95755', white: '#dfdad9',
      brightBlack: '#797593', brightRed: '#b4637a', brightGreen: '#56949f', brightYellow: '#d38928', brightBlue: '#3e7c95', brightMagenta: '#907aa9', brightCyan: '#d7827e', brightWhite: '#fffaf3'
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
      border: '#44405f', borderStrong: '#56516f', text: '#e0def4', textMuted: '#b5b1cc', textSubtle: '#908caa', accent: '#c4a7e7', accentInk: '#1a1424', backendClaude: '#d8916f', backendCodex: '#77c7a4', backendPi: '#d4a75e', accentHover: '#d7c2ee',
      accentSoft: 'rgba(196, 167, 231, 0.16)', success: '#9ccfd8', successSoft: 'rgba(156, 207, 216, 0.13)', warning: '#f6c177', warningInk: '#231700', warningSoft: 'rgba(246, 193, 119, 0.13)',
      danger: '#eb6f92', dangerInk: '#25080f', dangerSoft: 'rgba(235, 111, 146, 0.14)', purple: '#c4a7e7', cyan: '#9ccfd8', shadow: 'rgba(15, 13, 25, 0.65)',
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
    id: 'solarized-light',
    label: 'Solarized Light',
    description: 'Precision warm daylight',
    category: 'Community',
    appearance: 'light',
    colors: {
      canvas: '#fdf6e3', sidebar: '#eee8d5', surface: '#fffaf0', surfaceRaised: '#e8e2cf', inset: '#eee8d5', hover: '#e5deca', selected: '#d9e4df',
      border: '#d5cfbd', borderStrong: '#a9a99d', text: '#586e75', textMuted: '#657b83', textSubtle: '#839496', accent: '#1476a8', accentInk: '#ffffff', backendClaude: '#9d5b42', backendCodex: '#26785b', backendPi: '#86610b', accentHover: '#0d5e88',
      accentSoft: 'rgba(38, 139, 210, 0.12)', success: '#697a00', successSoft: 'rgba(133, 153, 0, 0.13)', warning: '#966f00', warningInk: '#ffffff', warningSoft: 'rgba(181, 137, 0, 0.13)',
      danger: '#c32927', dangerInk: '#ffffff', dangerSoft: 'rgba(220, 50, 47, 0.11)', purple: '#6c71c4', cyan: '#167c75', shadow: 'rgba(88, 110, 117, 0.2)',
      diffAdditionBg: '#e4e9c8', diffAdditionGutter: '#d1d9a6', diffAdditionText: '#3d4900', diffDeletionBg: '#f5d6cc', diffDeletionGutter: '#edb9aa', diffDeletionText: '#671916', diffHunkBg: '#d8e7eb', diffHunkText: '#185b78'
    },
    syntax: {
      foreground: '#586e75', comment: '#839496', keyword: '#6c71c4', string: '#697a00', number: '#a33b11', title: '#1476a8', variable: '#b82c70',
      type: '#167c75', literal: '#966f00', meta: '#6c71c4', addition: '#697a00', deletion: '#c32927'
    },
    terminal: {
      black: '#073642', red: '#c32927', green: '#697a00', yellow: '#966f00', blue: '#1476a8', magenta: '#b82c70', cyan: '#167c75', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#dc322f', brightGreen: '#859900', brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#d33682', brightCyan: '#2aa198', brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    description: 'Precision low-light palette',
    category: 'Community',
    appearance: 'dark',
    colors: {
      canvas: '#002b36', sidebar: '#00242d', surface: '#073642', surfaceRaised: '#124552', inset: '#001f27', hover: '#0d3e49', selected: '#164c58',
      border: '#164753', borderStrong: '#3e6269', text: '#d3dedc', textMuted: '#a7b8b7', textSubtle: '#839496', accent: '#4aa3d8', accentInk: '#001820', backendClaude: '#d8916f', backendCodex: '#77c7a4', backendPi: '#d4a75e', accentHover: '#70b9e2',
      accentSoft: 'rgba(38, 139, 210, 0.18)', success: '#9aae24', successSoft: 'rgba(133, 153, 0, 0.17)', warning: '#d5a719', warningInk: '#181100', warningSoft: 'rgba(181, 137, 0, 0.17)',
      danger: '#ee5b58', dangerInk: '#210504', dangerSoft: 'rgba(220, 50, 47, 0.17)', purple: '#8c91dc', cyan: '#4bbab0', shadow: 'rgba(0, 20, 25, 0.74)',
      diffAdditionBg: '#233f31', diffAdditionGutter: '#385842', diffAdditionText: '#e2edbf', diffDeletionBg: '#4a2929', diffDeletionGutter: '#673536', diffDeletionText: '#ffd9d5', diffHunkBg: '#193f50', diffHunkText: '#b7ddeb'
    },
    syntax: {
      foreground: '#d3dedc', comment: '#839496', keyword: '#b0a7e8', string: '#b4c94b', number: '#ef8354', title: '#69b7e5', variable: '#ed70ad',
      type: '#65c8be', literal: '#e3bd4b', meta: '#a5a9e8', addition: '#b4c94b', deletion: '#ee7774'
    },
    terminal: {
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#ee5b58', brightGreen: '#9aae24', brightYellow: '#d5a719', brightBlue: '#4aa3d8', brightMagenta: '#df5a9a', brightCyan: '#4bbab0', brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'high-contrast-light',
    label: 'High Contrast Light',
    description: 'Maximum daylight separation',
    category: 'Accessibility',
    appearance: 'light',
    colors: {
      canvas: '#ffffff', sidebar: '#f3f4f5', surface: '#ffffff', surfaceRaised: '#e7e9ec', inset: '#f0f1f3', hover: '#e2e5e8', selected: '#d3e5fa',
      border: '#b6bbc1', borderStrong: '#59616a', text: '#000000', textMuted: '#343a40', textSubtle: '#606870', accent: '#005fc5', accentInk: '#ffffff', backendClaude: '#864127', backendCodex: '#176143', backendPi: '#735000', accentHover: '#004a9c',
      accentSoft: 'rgba(0, 95, 197, 0.14)', success: '#126a2d', successSoft: 'rgba(18, 106, 45, 0.12)', warning: '#8a5b00', warningInk: '#ffffff', warningSoft: 'rgba(138, 91, 0, 0.13)',
      danger: '#b10e1b', dangerInk: '#ffffff', dangerSoft: 'rgba(177, 14, 27, 0.11)', purple: '#6632a8', cyan: '#006b72', shadow: 'rgba(31, 35, 40, 0.24)',
      diffAdditionBg: '#d6f2dc', diffAdditionGutter: '#a8dfb4', diffAdditionText: '#0b4319', diffDeletionBg: '#f9d9dc', diffDeletionGutter: '#efabb1', diffDeletionText: '#650710', diffHunkBg: '#d8eaff', diffHunkText: '#003f85'
    },
    syntax: {
      foreground: '#111418', comment: '#606870', keyword: '#6632a8', string: '#126a2d', number: '#8a4700', title: '#005fc5', variable: '#961145',
      type: '#006b72', literal: '#795000', meta: '#4c409f', addition: '#126a2d', deletion: '#b10e1b'
    },
    terminal: {
      black: '#111418', red: '#b10e1b', green: '#126a2d', yellow: '#795000', blue: '#005fc5', magenta: '#6632a8', cyan: '#006b72', white: '#d7dade',
      brightBlack: '#59616a', brightRed: '#d91b29', brightGreen: '#18893a', brightYellow: '#986600', brightBlue: '#0878ef', brightMagenta: '#8647cf', brightCyan: '#008b94', brightWhite: '#ffffff'
    }
  },
  {
    id: 'high-contrast',
    label: 'High Contrast Dark',
    description: 'Maximum low-light separation',
    category: 'Accessibility',
    appearance: 'dark',
    colors: {
      canvas: '#050607', sidebar: '#090b0d', surface: '#0e1114', surfaceRaised: '#15191e', inset: '#020304', hover: '#1b2026', selected: '#222a32',
      border: '#333b44', borderStrong: '#66717c', text: '#ffffff', textMuted: '#c7cdd4', textSubtle: '#929ba5', accent: '#66b0ff', accentInk: '#001022', backendClaude: '#d8916f', backendCodex: '#77c7a4', backendPi: '#d4a75e', accentHover: '#a2d0ff',
      accentSoft: 'rgba(102, 176, 255, 0.2)', success: '#62e69a', successSoft: 'rgba(98, 230, 154, 0.18)', warning: '#ffd166', warningInk: '#000000', warningSoft: 'rgba(255, 209, 102, 0.18)',
      danger: '#ff7b86', dangerInk: '#000000', dangerSoft: 'rgba(255, 123, 134, 0.18)', purple: '#c7a2ff', cyan: '#66e3ea', shadow: 'rgba(0, 0, 0, 0.8)',
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

export const THEME_FAMILIES: ThemeFamily[] = [
  { id: 'boss', label: 'BOSS', description: 'Neutral and understated', category: 'BOSS', light: 'boss-light', dark: 'boss-dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', description: 'Cool city blues', category: 'Community', light: 'tokyo-night-day', dark: 'tokyo-night-moon' },
  { id: 'catppuccin', label: 'Catppuccin', description: 'Soothing pastels', category: 'Community', light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
  { id: 'rose-pine', label: 'Rosé Pine', description: 'Warm, quiet contrast', category: 'Community', light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
  { id: 'solarized', label: 'Solarized', description: 'Precision colors for long sessions', category: 'Community', light: 'solarized-light', dark: 'solarized-dark' },
  { id: 'high-contrast', label: 'High Contrast', description: 'Maximum separation', category: 'Accessibility', light: 'high-contrast-light', dark: 'high-contrast' }
]

const DEFAULT_PREFERENCE: ThemePreference = { family: 'boss', appearance: 'system' }
const THEME_FAMILY_KEY = 'boss.themeFamily'
const THEME_APPEARANCE_KEY = 'boss.themeAppearance'
const LEGACY_THEME_KEY = 'boss.theme'

function resolveTheme(id: string): ThemeDef {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

function resolveFamily(id: string): ThemeFamily {
  return THEME_FAMILIES.find((family) => family.id === id) ?? THEME_FAMILIES[0]
}

function isAppearance(value: string | null): value is ThemeAppearance {
  return value === 'system' || value === 'light' || value === 'dark'
}

function currentSystemAppearance(): ResolvedThemeAppearance {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}

export function themeForPreference(
  preference: ThemePreference,
  systemAppearance: ResolvedThemeAppearance = currentSystemAppearance()
): ThemeDef {
  const family = resolveFamily(preference.family)
  const appearance = preference.appearance === 'system' ? systemAppearance : preference.appearance
  return resolveTheme(family[appearance])
}

export function themeForFamily(familyId: string, appearance: ResolvedThemeAppearance): ThemeDef {
  return resolveTheme(resolveFamily(familyId)[appearance])
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
    // One shadow colour, four heights. Every raised surface drew its own black before this, which
    // a light theme has no use for: boss-light's shadow is a soft slate, not black at all.
    '--shadow-sm': `0 2px 12px ${color.shadow}`,
    '--shadow-md': `0 10px 30px ${color.shadow}`,
    '--shadow-menu': `0 12px 40px ${color.shadow}`,
    '--shadow-lg': `0 18px 52px ${color.shadow}`,
    '--shadow-xl': `0 20px 60px ${color.shadow}`,
    '--ink-on-accent': color.accentInk,
    '--ink-on-danger': color.dangerInk,
    '--ink-on-warning': color.warningInk,
    '--backend-claude': color.backendClaude,
    '--backend-codex': color.backendCodex,
    '--backend-pi': color.backendPi,
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
  const applied = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme
  return resolveTheme(id ?? applied ?? 'boss-dark')
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

export function applyTheme(preference: ThemePreference): ThemeChangedDetail {
  const normalized: ThemePreference = {
    family: resolveFamily(preference.family).id,
    appearance: isAppearance(preference.appearance) ? preference.appearance : DEFAULT_PREFERENCE.appearance
  }
  const theme = themeForPreference(normalized)
  document.documentElement.dataset.theme = theme.id
  document.documentElement.dataset.themeFamily = normalized.family
  document.documentElement.dataset.themeAppearance = normalized.appearance
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
    localStorage.setItem(THEME_FAMILY_KEY, normalized.family)
    localStorage.setItem(THEME_APPEARANCE_KEY, normalized.appearance)
    // Keep the resolved id for builds from before family/appearance were separate.
    localStorage.setItem(LEGACY_THEME_KEY, theme.id)
  } catch {
    /* ignore */
  }
  const detail: ThemeChangedDetail = {
    ...normalized,
    id: theme.id,
    resolvedAppearance: theme.appearance
  }
  window.dispatchEvent(new CustomEvent('boss:theme-changed', { detail }))
  return detail
}

export function loadTheme(): ThemePreference {
  try {
    const family = localStorage.getItem(THEME_FAMILY_KEY)
    const appearance = localStorage.getItem(THEME_APPEARANCE_KEY)
    if (family && isAppearance(appearance)) {
      return { family: resolveFamily(family).id, appearance }
    }

    // Preserve the exact mode selected by versions that stored a variant id.
    const legacyId = localStorage.getItem(LEGACY_THEME_KEY)
    const legacyTheme = THEMES.find((theme) => theme.id === legacyId)
    const legacyFamily = legacyTheme && THEME_FAMILIES.find(
      (candidate) => candidate.light === legacyTheme.id || candidate.dark === legacyTheme.id
    )
    if (legacyTheme && legacyFamily) {
      return { family: legacyFamily.id, appearance: legacyTheme.appearance }
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PREFERENCE }
}

/** Reapply a system-following preference whenever the operating system changes. */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = (): void => {
    const preference = loadTheme()
    if (preference.appearance === 'system') applyTheme(preference)
  }
  media.addEventListener('change', sync)
  return () => media.removeEventListener('change', sync)
}
