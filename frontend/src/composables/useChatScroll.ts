import { nextTick, onUnmounted, ref, watch } from 'vue'

/** Following is user intent: growing content must never turn it back on. */
export function useChatScroll() {
  const scrollArea = ref<HTMLDivElement | null>(null)
  const content = ref<HTMLDivElement | null>(null)
  const following = ref(true)
  let frame: number | undefined
  let previousTop = 0
  let touchY: number | undefined
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scrollToBottom)

  function scrollToBottom() {
    if (!following.value || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      void nextTick(() => {
        if (!following.value || !scrollArea.value) return
        scrollArea.value.scrollTop = scrollArea.value.scrollHeight
        previousTop = scrollArea.value.scrollTop
      })
    })
  }
  function pause() {
    following.value = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  function resume() {
    following.value = true
    previousTop = scrollArea.value?.scrollTop ?? 0
    scrollToBottom()
  }
  function onScroll() {
    const area = scrollArea.value
    if (!area) return
    if (area.scrollTop < previousTop - 1) pause()
    else if (area.scrollTop > previousTop && area.scrollHeight - area.scrollTop - area.clientHeight <= 4) following.value = true
    previousTop = area.scrollTop
  }
  function onWheel(event: WheelEvent) { if (event.deltaY < 0) pause() }
  function onTouchStart(event: TouchEvent) { touchY = event.touches[0]?.clientY }
  function onTouchMove(event: TouchEvent) {
    const y = event.touches[0]?.clientY
    if (y !== undefined && touchY !== undefined && y > touchY) pause()
    touchY = y
  }
  function onScrollKey(event: KeyboardEvent) {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause()
  }
  watch(content, (node) => {
    observer?.disconnect()
    if (node) observer?.observe(node)
    scrollToBottom()
  }, { flush: 'post' })
  onUnmounted(() => {
    observer?.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  return { scrollArea, content, following, scrollToBottom, pause, resume, onScroll, onWheel, onTouchStart, onTouchMove, onScrollKey }
}
