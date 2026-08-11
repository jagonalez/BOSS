import githubDark from 'highlight.js/styles/github-dark.css?inline'
import shadesOfPurple from 'highlight.js/styles/shades-of-purple.css?inline'
import monokaiSublime from 'highlight.js/styles/monokai-sublime.css?inline'
import nord from 'highlight.js/styles/nord.css?inline'
import xcode from 'highlight.js/styles/xcode.css?inline'

export interface ThemeDef {
  id: string
  label: string
  hljs: string
  bg: string
  accent: string
  tokens: Record<`--${string}`, string>
}

export const THEMES: ThemeDef[] = [
  {
    id: 'graphite', label: 'Graphite', hljs: githubDark, bg: '#0d0f12', accent: '#4f8cff',
    tokens: {
      '--bg': '#0d0f12', '--bg-elevated': '#12151a', '--bg-inset': '#0a0c0f', '--bg-hover': '#1a1f28', '--bg-active': '#1e242e',
      '--border': '#242a35', '--border-subtle': '#1a1e26', '--text': '#f8fafc', '--text-muted': '#b9c1cc', '--text-faint': '#8b94a1',
      '--accent': '#4f8cff', '--accent-hover': '#6ba1ff', '--accent-soft': 'rgba(79, 140, 255, 0.14)', '--green': '#3fb950',
      '--green-soft': 'rgba(63, 185, 80, 0.14)', '--red': '#f85149', '--red-soft': 'rgba(248, 81, 73, 0.14)', '--yellow': '#d29922', '--purple': '#8957e5'
    }
  },
  {
    id: 'midnight-purple', label: 'Midnight Purple', hljs: shadesOfPurple, bg: '#0d0a18', accent: '#9d7bff',
    tokens: {
      '--bg': '#0d0a18', '--bg-elevated': '#141026', '--bg-inset': '#0a0815', '--bg-hover': '#1c1636', '--bg-active': '#231c40',
      '--border': '#2e2754', '--border-subtle': '#1d1836', '--text': '#f4f2ff', '--text-muted': '#b5afe0', '--text-faint': '#7c75a7',
      '--accent': '#9d7bff', '--accent-hover': '#b499ff', '--accent-soft': 'rgba(157, 123, 255, 0.16)', '--green': '#4dd97c',
      '--green-soft': 'rgba(77, 217, 124, 0.15)', '--red': '#ff6b7d', '--red-soft': 'rgba(255, 107, 125, 0.15)', '--yellow': '#e3c15c', '--purple': '#b78aff'
    }
  },
  {
    id: 'dracula', label: 'Dracula', hljs: monokaiSublime, bg: '#282a36', accent: '#8be9fd',
    tokens: {
      '--bg': '#282a36', '--bg-elevated': '#303242', '--bg-inset': '#21222c', '--bg-hover': '#3a3d50', '--bg-active': '#44475a',
      '--border': '#44475a', '--border-subtle': '#343746', '--text': '#f8f8f2', '--text-muted': '#bd93f9', '--text-faint': '#6272a4',
      '--accent': '#8be9fd', '--accent-hover': '#6ee7f5', '--accent-soft': 'rgba(139, 233, 253, 0.16)', '--green': '#50fa7b',
      '--green-soft': 'rgba(80, 250, 123, 0.15)', '--red': '#ff5555', '--red-soft': 'rgba(255, 85, 85, 0.15)', '--yellow': '#f1fa8c', '--purple': '#bd93f9'
    }
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', hljs: nord, bg: '#002b36', accent: '#268bd2',
    tokens: {
      '--bg': '#002b36', '--bg-elevated': '#073642', '--bg-inset': '#001e26', '--bg-hover': '#0b3a47', '--bg-active': '#0f4655',
      '--border': '#586e75', '--border-subtle': '#073642', '--text': '#93a1a1', '--text-muted': '#839496', '--text-faint': '#586e75',
      '--accent': '#268bd2', '--accent-hover': '#33a1e8', '--accent-soft': 'rgba(38, 139, 210, 0.18)', '--green': '#859900',
      '--green-soft': 'rgba(133, 153, 0, 0.18)', '--red': '#dc322f', '--red-soft': 'rgba(220, 50, 47, 0.18)', '--yellow': '#b58900', '--purple': '#6c71c4'
    }
  },
  {
    id: 'solarized-light', label: 'Solarized Light', hljs: xcode, bg: '#fdf6e3', accent: '#268bd2',
    tokens: {
      '--bg': '#fdf6e3', '--bg-elevated': '#eee8d5', '--bg-inset': '#f5edd6', '--bg-hover': '#e0d8c0', '--bg-active': '#d8cfb4',
      '--border': '#93a1a1', '--border-subtle': '#d8cfb4', '--text': '#586e75', '--text-muted': '#657b83', '--text-faint': '#93a1a1',
      '--accent': '#268bd2', '--accent-hover': '#1d7fc4', '--accent-soft': 'rgba(38, 139, 210, 0.14)', '--green': '#859900',
      '--green-soft': 'rgba(133, 153, 0, 0.14)', '--red': '#dc322f', '--red-soft': 'rgba(220, 50, 47, 0.12)', '--yellow': '#b58900', '--purple': '#6c71c4'
    }
  }
]

export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = id
  const def = THEMES.find((t) => t.id === id)
  if (def) {
    for (const [name, value] of Object.entries(def.tokens)) document.documentElement.style.setProperty(name, value)
  }
  let style = document.getElementById('hljs-theme') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'hljs-theme'
    document.head.appendChild(style)
  }
  style.textContent = def ? def.hljs : ''
  try {
    localStorage.setItem('ralf.theme', id)
  } catch {
    /* ignore */
  }
}

export function loadTheme(): string {
  try {
    const saved = localStorage.getItem('ralf.theme')
    if (saved && THEMES.some((t) => t.id === saved)) return saved
  } catch {
    /* ignore */
  }
  return 'graphite'
}
