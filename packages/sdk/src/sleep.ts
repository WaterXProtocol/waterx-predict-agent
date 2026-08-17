/**
 * An abortable sleep that RESOLVES on abort rather than rejecting — every caller
 * here re-checks its own abort condition at the top of its loop, and rejecting
 * from a timer would bypass the cleanup that runs around it.
 *
 * Shared rather than duplicated: the listener is removed again on every exit, so
 * a signal reused across a thousand waits does not accumulate a thousand
 * listeners, and that is exactly the detail a second copy drifts on.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}
