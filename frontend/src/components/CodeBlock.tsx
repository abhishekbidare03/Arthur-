import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { CheckIcon, CopyIcon } from './icons'

interface CodeBlockProps {
  code: string
  /** Language tag from the fence (```python), if the model supplied one. */
  language?: string
  /** True while tokens are still arriving — suppresses the copy button. */
  streaming?: boolean
}

/**
 * Friendly names for the language tags models actually emit.
 *
 * `highlight.js/lib/common` registers ~40 languages; anything outside that set
 * still renders as a plain, correctly-formatted block rather than failing.
 */
const LABELS: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python',
  rb: 'Ruby', ruby: 'Ruby',
  sh: 'Shell', bash: 'Bash', zsh: 'Shell', shell: 'Shell', console: 'Shell',
  ps1: 'PowerShell', powershell: 'PowerShell',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  html: 'HTML', css: 'CSS', scss: 'SCSS',
  sql: 'SQL', md: 'Markdown', markdown: 'Markdown',
  c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#',
  java: 'Java', kotlin: 'Kotlin', swift: 'Swift', go: 'Go', golang: 'Go',
  rs: 'Rust', rust: 'Rust', php: 'PHP', r: 'R', lua: 'Lua',
  diff: 'Diff', dockerfile: 'Dockerfile', ini: 'INI', txt: 'Text', text: 'Text',
}

/** highlight.js registers some languages only under their canonical name. */
const ALIASES: Record<string, string> = {
  'c++': 'cpp', golang: 'go', zsh: 'bash', sh: 'bash', console: 'bash',
  yml: 'yaml', md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust',
  ps1: 'powershell', csharp: 'cs',
}

export default function CodeBlock({ code, language, streaming = false }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const tag = language?.toLowerCase().trim()
  const hljsLang = tag ? (ALIASES[tag] ?? tag) : undefined

  const html = useMemo(() => {
    // Highlighting a half-written line every frame is wasted work — during
    // streaming the block renders as plain text and lights up when it lands.
    if (streaming) return null
    try {
      if (hljsLang && hljs.getLanguage(hljsLang)) {
        return hljs.highlight(code, { language: hljsLang, ignoreIllegals: true }).value
      }
      // No tag, or an unregistered one: let highlight.js guess. Better than
      // nothing for the many models that omit the language.
      if (code.trim().length > 0) return hljs.highlightAuto(code).value
    } catch {
      // Fall through to plain text — never let highlighting break the message.
    }
    return null
  }, [code, hljsLang, streaming])

  const label = (tag && (LABELS[tag] ?? tag)) || 'Code'

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      // Clipboard can be blocked; fall back to a selection-based copy.
      const ta = document.createElement('textarea')
      ta.value = code
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* give up silently */ }
      document.body.removeChild(ta)
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{label}</span>
        {!streaming && (
          <button
            className="codeblock-copy"
            onClick={() => void copy()}
            aria-label={copied ? 'Copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>

      <pre>
        <code
          className={hljsLang ? `language-${hljsLang}` : undefined}
          {...(html ? { dangerouslySetInnerHTML: { __html: html } } : { children: code })}
        />
      </pre>
    </div>
  )
}
