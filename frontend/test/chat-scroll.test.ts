import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, nextTick } from 'vue'
import { useChatScroll } from '../src/composables/useChatScroll'

test('upward input cancels pending following even within 150px of the bottom; only returning to the bottom resumes', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
    patchProp() {}, insert() {}, remove() {},
  })
  let chat!: ReturnType<typeof useChatScroll>
  const app = renderer.createApp(defineComponent({ setup() { chat = useChatScroll(); return () => null } }))
  async function flush() {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(0))
    await nextTick()
  }
  try {
    app.mount({})
    let top = 500
    const area = { clientHeight: 500, scrollHeight: 1000, get scrollTop() { return top }, set scrollTop(value: number) { top = Math.min(value, this.scrollHeight - this.clientHeight) } }
    chat.scrollArea.value = area as HTMLDivElement
    chat.resume()
    await flush()
    chat.scrollToBottom()
    chat.onWheel({ deltaY: -20 } as WheelEvent)
    assert.equal(frames.size, 0, 'upward intent cancels the queued animation frame immediately')
    top = 480
    chat.onScroll()
    area.scrollHeight += 30
    chat.scrollToBottom()
    await flush()
    assert.equal(top, 480, 'streaming must preserve the reading position even near the bottom')
    top = 510
    chat.onScroll()
    assert.equal(chat.following.value, false, 'scrolling near the bottom does not restore following')
    top = 530
    chat.onScroll()
    assert.equal(chat.following.value, true)
    area.scrollHeight += 40
    chat.scrollToBottom()
    await flush()
    assert.equal(top, 570)

    top = 550 // scrollbar drag / keyboard scroll, with no wheel event
    chat.onScroll()
    assert.equal(chat.following.value, false)
    chat.resume()
    await flush()
    assert.equal(top, 570, 'the latest button explicitly resumes following')

    chat.onTouchStart({ touches: [{ clientY: 100 }] } as unknown as TouchEvent)
    chat.onTouchMove({ touches: [{ clientY: 120 }] } as unknown as TouchEvent)
    assert.equal(chat.following.value, false)
    chat.resume()
    chat.onScrollKey({ key: 'PageUp' } as KeyboardEvent)
    assert.equal(chat.following.value, false)
    app.unmount()
    assert.equal(frames.size, 0)
  } finally {
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
  }
})
