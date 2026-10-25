// Reading the start of a response's body, for the clients that need only so much of it: the GitHub
// client (github-client.ts, #123), which reads a README's first kilobytes, and the Messages request
// (anthropic-messages.ts), which reads a 400's error body to recognize a spend limit (#154).

/** The text read, and whether it is the whole body. */
export interface BoundedText {
  readonly ok: true;
  readonly text: string;
  // False when the body went on past the limit, so `text` is only its start.
  readonly complete: boolean;
}

/**
 * The body as UTF-8 text, up to `limit` bytes. The rest is cancelled, never downloaded, and a
 * character cut at the limit is dropped.
 */
export async function readText(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<BoundedText> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return { ok: true, text: text + decoder.decode(), complete: true };
    }
    const room = limit - bytes;
    if (chunk.value.byteLength >= room) {
      text += decoder.decode(chunk.value.subarray(0, room), { stream: true });
      await reader.cancel().catch(() => {
        // The rest of the body is not wanted.
      });
      return { ok: true, text, complete: false };
    }
    bytes += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
  }
}
