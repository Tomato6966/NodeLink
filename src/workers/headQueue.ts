export interface HeadQueue<T> {
  items: T[]
  head: number
}

const COMPACT_THRESHOLD = 64

export const createHeadQueue = <T>(): HeadQueue<T> => ({
  items: [],
  head: 0
})

export const getHeadQueueLength = <T>(queue: HeadQueue<T>): number =>
  queue.items.length - queue.head

export const enqueueHeadQueue = <T>(queue: HeadQueue<T>, item: T): void => {
  queue.items.push(item)
}

export const dequeueHeadQueue = <T>(queue: HeadQueue<T>): T | undefined => {
  if (queue.head >= queue.items.length) {
    if (queue.head !== 0) {
      queue.items.length = 0
      queue.head = 0
    }
    return undefined
  }

  const item = queue.items[queue.head]
  queue.head++

  if (queue.head === queue.items.length) {
    queue.items.length = 0
    queue.head = 0
  } else if (
    queue.head >= COMPACT_THRESHOLD &&
    queue.head * 2 >= queue.items.length
  ) {
    queue.items = queue.items.slice(queue.head)
    queue.head = 0
  }

  return item
}
