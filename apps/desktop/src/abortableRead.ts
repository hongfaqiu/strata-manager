/** Stop waiting for read-only IPC metadata promptly; late results cannot resume a send. */
export async function abortableRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach handlers even when already canceled, so a rejected IPC read is consumed.
  return new Promise<T>((resolve, reject) => {
    const canceled = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', canceled);
    read.then(value => { cleanup(); if (signal.aborted) canceled(); else resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) canceled(); else signal.addEventListener('abort', canceled, { once: true });
  });
}
