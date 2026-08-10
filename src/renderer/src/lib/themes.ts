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
}

export const THEMES: ThemeDef[] = [
  { id: 'graphite', label: 'Graphite', hljs: githubDark, bg: '#0d0f12', accent: '#4f8cff' },
  { id: 'midnight-purple', label: 'Midnight Purple', hljs: shadesOfPurple, bg: '#0d0a18', accent: '#9d7bff' },
  { id: 'dracula', label: 'Dracula', hljs: monokaiSublime, bg: '#282a36', accent: '#8be9fd' },
  { id: 'solarized-dark', label: 'Solarized Dark', hljs: nord, bg: '#002b36', accent: '#268bd2' },
  { id: 'solarized-light', label: 'Solarized Light', hljs: xcode, bg: '#fdf6e3', accent: '#268bd2' }
]

export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = id
  const def = THEMES.find((t) => t.id === id)
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
