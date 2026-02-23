/**
 * StreamingPrompt - Async iterator queue for injecting messages into a running SDK session.
 *
 * Ported from Cyrus's StreamingPrompt pattern. Enables mid-execution steering
 * by allowing new user messages to be pushed into a running `query()` call.
 *
 * Usage:
 *   const prompt = new StreamingPrompt('initial task prompt');
 *   const gen = query({ prompt, options });
 *   // Later, inject a steer message:
 *   prompt.addMessage('Please also fix the tests');
 *   // When done:
 *   prompt.complete();
 */

interface SDKUserMessage {
  role: 'user';
  content: string;
}

interface QueueItem {
  value: SDKUserMessage;
}

export class StreamingPrompt {
  private queue: QueueItem[] = [];
  private resolve: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;
  private sessionId?: string;

  constructor(initialPrompt: string) {
    // Seed the queue with the initial prompt as the first user message
    this.queue.push({
      value: { role: 'user', content: initialPrompt },
    });
  }

  /**
   * Add a new user message to the running session.
   * The SDK will pick this up as the next turn's input.
   */
  addMessage(content: string): void {
    if (this.done) return;

    const message: SDKUserMessage = { role: 'user', content };

    if (this.resolve) {
      // Consumer is waiting — deliver immediately
      const r = this.resolve;
      this.resolve = null;
      r({ value: message, done: false });
    } else {
      // Consumer hasn't asked yet — buffer
      this.queue.push({ value: message });
    }
  }

  /**
   * Signal that no more messages will be sent.
   */
  complete(): void {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  /**
   * Update the session ID (called after first SDK init message).
   */
  updateSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Async iterator protocol — used by the SDK's `query()` to consume messages.
   */
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        // If there's buffered data, return it immediately
        if (this.queue.length > 0) {
          const item = this.queue.shift()!;
          return Promise.resolve({ value: item.value, done: false });
        }

        // If stream is complete, signal done
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }

        // Otherwise, wait for the next message
        return new Promise((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}
