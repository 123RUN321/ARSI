/** Process death follows signal delivery; poll so a transient zombie is not a leak. */
export async function waitForProcessExit(
  pid: number,
  timeoutMs = 2000,
): Promise<void> {
  // setImmediate stays real under node:test mocked timers.
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        return;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`Process ${pid} is still running`);
    await yieldTurn();
  }
}
