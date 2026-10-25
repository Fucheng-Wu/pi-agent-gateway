import assert from 'node:assert/strict'
import test from 'node:test'
import { readImage } from '../src/lib/images'
import { imageSource, MAX_IMAGE_BYTES } from '../../shared/images'

test('image reading rejects unsupported, empty and oversized files before reading', async () => {
  await assert.rejects(readImage(new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' })), /PNG/)
  await assert.rejects(readImage(new File([], 'empty.png', { type: 'image/png' })), /5 MB/)
  await assert.rejects(readImage(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' })), /5 MB/)
})

test('image reading prepares base64 previews and reports decoding and read failures', async () => {
  const descriptors = ['FileReader', 'Image'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  let failure: 'read' | 'decode' | undefined
  class Reader {
    result = 'data:image/png;base64,aGVsbG8='
    onload?: () => void
    onerror?: () => void
    readAsDataURL() { queueMicrotask(() => failure === 'read' ? this.onerror?.() : this.onload?.()) }
  }
  class Preview {
    onload?: () => void
    onerror?: () => void
    set src(_value: string) { queueMicrotask(() => failure === 'decode' ? this.onerror?.() : this.onload?.()) }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: Reader })
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: Preview })
  try {
    const file = new File(['hello'], 'example.png', { type: 'image/png' })
    const image = await readImage(file)
    assert.deepEqual(image, { mimeType: 'image/png', data: 'aGVsbG8=', name: 'example.png' })
    assert.equal(imageSource(image), 'data:image/png;base64,aGVsbG8=')
    failure = 'decode'
    await assert.rejects(readImage(file), /无法解码/)
    failure = 'read'
    await assert.rejects(readImage(file), /无法读取/)
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
