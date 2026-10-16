"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Markdown written by the user is untrusted content: raw HTML is dropped, images are never loaded
// (their alt text is shown), and only http, https and mailto links are links.
const allowedLink = /^(https?:|mailto:)/i;

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdownText" data-user-content>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (allowedLink.test(url.trim()) ? url : "")}
        components={{
          img: ({ alt }) => <span>[{alt || ""}]</span>,
          a: ({ href, children }) => href && allowedLink.test(href.trim())
            ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            : <span>{children}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
