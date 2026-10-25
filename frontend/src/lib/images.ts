import type { ImageAttachment } from '@/types'
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES } from '../../../shared/images'

export function readImage(file: File): Promise<ImageAttachment> {
  if (!IMAGE_MIME_TYPES.includes(file.type as ImageAttachment['mimeType'])) {
    return Promise.reject(new Error('支持 PNG、JPEG、GIF 和 WebP 图片'))
  }
  if (!file.size || file.size > MAX_IMAGE_BYTES) {
    return Promise.reject(new Error('每张图片须大于 0 且不超过 5 MB'))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`))
    reader.onabort = () => reject(new Error('图片读取已取消'))
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result.split(',')[1] : undefined
      if (!data) { reject(new Error('图片内容为空')); return }
      const preview = new Image()
      preview.onload = () => resolve({ data, mimeType: file.type as ImageAttachment['mimeType'], name: file.name.slice(0, 256) })
      preview.onerror = () => reject(new Error(`图片已损坏或无法解码：${file.name}`))
      preview.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}
