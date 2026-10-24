import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { transformWithEsbuild } from 'vite'

interface Element {
  type: string
  text: string
  props: Record<string, unknown>
  children: Element[]
  parent: Element | null
}

function element(type: string, text = ''): Element {
  return { type, text, props: {}, children: [], parent: null }
}

// Vue's real runtime and the compiled SFC exercise prop changes and clicks without
// introducing a browser/DOM dependency for this small stateful component.
const renderer = createRenderer<Element, Element>({
  createElement: (tag) => element(tag),
  createText: (text) => element('#text', text),
  createComment: (text) => element('#comment', text),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp: (node, key, _previous, value) => { node.props[key] = value },
  insert: (node, parent, anchor) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    node.parent = parent
  },
  remove: (node) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  }
})

function find(node: Element, predicate: (node: Element) => boolean): Element | undefined {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = find(child, predicate)
    if (found) return found
  }
}

test('thinking is visible live, collapses for the answer, and can be reopened', async () => {
  const source = await readFile(new URL('../src/components/ThinkingPanel.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const compiled = compileScript(descriptor, { id: 'thinking-panel-test', inlineTemplate: true })
  const { code } = await transformWithEsbuild(compiled.content, 'ThinkingPanel.ts', { loader: 'ts' })
  const directory = await mkdtemp(join(import.meta.dirname, '.thinking-panel-'))
  try {
    const modulePath = join(directory, 'ThinkingPanel.mjs')
    await writeFile(modulePath, code)
    const { default: ThinkingPanel } = await import(pathToFileURL(modulePath).href)
    const props = reactive({ text: '检查项目结构', streaming: true })
    const root = element('root')
    const app = renderer.createApp(defineComponent({ setup: () => () => h(ThinkingPanel, props) }))
    app.mount(root)
    const button = () => find(root, (node) => node.type === 'button')!
    const content = () => find(root, (node) => node.type === 'div' && node.text === props.text)
    try {
      assert.equal(button().props['aria-expanded'], true)
      assert.ok(content(), 'the first reasoning chunk is visible immediately')
      props.text += '\n继续分析授权逻辑'
      await nextTick()
      assert.ok(content(), 'new reasoning chunks stay visible')
      props.streaming = false // MessageBubble changes this when body text starts.
      await nextTick()
      assert.equal(button().props['aria-expanded'], false)
      assert.equal(content(), undefined)
      ;(button().props.onClick as () => void)()
      await nextTick()
      assert.equal(button().props['aria-expanded'], true)
      assert.ok(content(), 'completed reasoning can be reopened')
      props.streaming = true
      await nextTick()
      ;(button().props.onClick as () => void)()
      props.text += '\n又一段思考'
      await nextTick()
      assert.equal(button().props['aria-expanded'], false, 'text updates respect manual collapse')
    } finally { app.unmount() }

    const history = element('root')
    const historyApp = renderer.createApp(ThinkingPanel, { text: '历史思考', streaming: false })
    historyApp.mount(history)
    assert.equal(find(history, (node) => node.type === 'button')?.props['aria-expanded'], false)
    historyApp.unmount()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
