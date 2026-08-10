import { Children, cloneElement, isValidElement, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { useNavigate } from 'react-router-dom'

function fadeWords(children: ReactNode, path = 'w'): ReactNode {
  return Children.map(children, (child, index) => {
    const key = `${path}-${index}`
    if (typeof child === 'string') {
      return child.split(/(\s+)/).map((part, partIndex) =>
        /\s+/.test(part) || !part ? (
          part
        ) : (
          <span key={`${key}-${partIndex}`} className="animate-word-fade-in motion-reduce:animate-none">
            {part}
          </span>
        ),
      )
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) return child
    return cloneElement(child, { children: fadeWords(child.props.children, key) })
  })
}

function textContent(children: ReactNode): string {
  let value = ''
  Children.forEach(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') value += child
    else if (isValidElement<{ children?: ReactNode }>(child)) value += textContent(child.props.children)
  })
  return value
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const source = textContent(children).replace(/\n$/, '')
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-foreground/[0.035]">
      <div className="flex h-8 items-center justify-between border-b border-border px-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Code</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(source)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="scrollbar-app overflow-x-auto whitespace-pre p-3 font-mono text-xs leading-5 text-foreground">
        {children}
      </pre>
    </div>
  )
}

export function MarkdownMessage({
  content,
  streaming = false,
  inline = false,
}: {
  content: string
  streaming?: boolean
  inline?: boolean
}) {
  const navigate = useNavigate()
  const words = (children: ReactNode) => (streaming ? fadeWords(children) : children)
  const components = useMemo<Components>(
    () => ({
      h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold tracking-tight">{words(children)}</h1>,
      h2: ({ children }) => <h2 className="mb-2 mt-4 text-[15px] font-semibold tracking-tight">{words(children)}</h2>,
      h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold">{words(children)}</h3>,
      h4: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-medium">{words(children)}</h4>,
      h5: ({ children }) => <h5 className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide">{words(children)}</h5>,
      h6: ({ children }) => <h6 className="mb-1 mt-2 text-xs font-medium text-muted-foreground">{words(children)}</h6>,
      p: ({ children }) =>
        inline ? (
          <span className="leading-6">{words(children)}</span>
        ) : (
          <p className="my-2 leading-6 first:mt-0 last:mb-0">{words(children)}</p>
        ),
      strong: ({ children }) => <strong className="font-semibold text-foreground">{words(children)}</strong>,
      em: ({ children }) => <em>{words(children)}</em>,
      ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
      ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
      li: ({ children }) => <li className="pl-0.5 leading-6">{words(children)}</li>,
      blockquote: ({ children }) => (
        <blockquote className="my-3 border-l-2 border-primary/35 pl-3 text-muted-foreground">
          {words(children)}
        </blockquote>
      ),
      a: ({ href = '', children }) => {
        const external = /^(https?:)?\/\//.test(href) || href.startsWith('mailto:')
        return (
          <a
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noreferrer' : undefined}
            onClick={(event) => {
              if (!external && href.startsWith('/')) {
                event.preventDefault()
                navigate(href)
              }
            }}
            className="font-medium text-primary underline decoration-primary/35 underline-offset-2 hover:decoration-primary"
          >
            {words(children)}
          </a>
        )
      },
      table: ({ children }) => (
        <div className="scrollbar-app my-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[360px] border-collapse text-xs">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="bg-muted/60 text-left">{children}</thead>,
      th: ({ children }) => <th className="border-b border-border px-3 py-2 font-semibold">{words(children)}</th>,
      td: ({ children }) => <td className="border-b border-border px-3 py-2 align-top">{words(children)}</td>,
      code: ({ className, children }) =>
        className ? (
          <code className={`${className} whitespace-pre font-mono text-xs`}>{children}</code>
        ) : (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>
        ),
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      hr: () => <hr className="my-4 border-border" />,
    }),
    [inline, navigate, streaming],
  )

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, defaultSchema]]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  )
}

