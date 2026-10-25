import MarkdownIt from 'markdown-it'

// Shared parser; raw HTML is disabled for model-generated text.
export const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
