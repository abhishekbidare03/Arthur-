import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './CodeBlock'

interface MarkdownProps {
  content: string
  /** True while tokens are still arriving. */
  streaming?: boolean
}

/**
 * Renders assistant messages as real markdown.
 *
 * Replaces the Phase 1 stand-in, which split on blank lines and understood only
 * bold and inline code — so a fenced code block arrived as one unbroken line of
 * prose. `remark-gfm` adds tables, task lists, strikethrough and autolinks.
 *
 * `react-markdown` builds React elements rather than injecting HTML, so model
 * output cannot inject markup. The one place raw HTML is set is the syntax
 * highlighter's output, and highlight.js escapes its input.
 */

/** Pulls the raw text out of a `<pre>`'s nested `<code>` child. */
function extractCode(node: ReactNode): { code: string; language?: string } {
  // react-markdown hands `pre` a single `code` element child.
  const child = Array.isArray(node) ? node[0] : node
  const props = (child as { props?: { className?: string; children?: ReactNode } })?.props

  if (!props) return { code: typeof node === 'string' ? node : '' }

  const className = props.className ?? ''
  const match = /language-([\w+#-]+)/.exec(className)

  const flatten = (n: ReactNode): string => {
    if (n === null || n === undefined || typeof n === 'boolean') return ''
    if (typeof n === 'string' || typeof n === 'number') return String(n)
    if (Array.isArray(n)) return n.map(flatten).join('')
    const inner = (n as { props?: { children?: ReactNode } })?.props?.children
    return inner === undefined ? '' : flatten(inner)
  }

  return { code: flatten(props.children), language: match?.[1] }
}

function MarkdownImpl({ content, streaming = false }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Fenced blocks arrive as `pre > code`. Intercepting at `pre` keeps the
        // language tag and avoids the inline-vs-block ambiguity of `code`.
        pre({ children }) {
          const { code, language } = extractCode(children)
          return <CodeBlock code={code} language={language} streaming={streaming} />
        },

        code({ children, className }) {
          // Anything reaching here is inline — blocks were handled by `pre`.
          return <code className={className}>{children}</code>
        },

        // Tables can easily exceed the column width; let them scroll on their
        // own rather than pushing the whole message sideways.
        table({ children }) {
          return (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          )
        },

        a({ children, href }) {
          return (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          )
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

/**
 * Memoised on content: streaming re-renders the pane every animation frame, and
 * re-parsing every *settled* message each time would grow quadratically with
 * conversation length.
 */
export default memo(MarkdownImpl)
