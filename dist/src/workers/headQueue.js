const COMPACT_THRESHOLD = 64;
export const createHeadQueue = () => ({
    items: [],
    head: 0
});
export const getHeadQueueLength = (queue) => queue.items.length - queue.head;
export const enqueueHeadQueue = (queue, item) => {
    queue.items.push(item);
};
export const dequeueHeadQueue = (queue) => {
    if (queue.head >= queue.items.length) {
        if (queue.head !== 0) {
            queue.items.length = 0;
            queue.head = 0;
        }
        return undefined;
    }
    const head = queue.head;
    const item = queue.items[head];
    queue.items[head] = undefined;
    queue.head = head + 1;
    if (queue.head === queue.items.length) {
        queue.items.length = 0;
        queue.head = 0;
    }
    else if (queue.head >= COMPACT_THRESHOLD &&
        queue.head * 2 >= queue.items.length) {
        queue.items = queue.items.slice(queue.head);
        queue.head = 0;
    }
    return item;
};
