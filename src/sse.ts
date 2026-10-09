// Server-sent events from a fetch body, as OpenAI and Anthropic stream them.

export interface SseEvent {
  event?: string;
  data: string;
}

function parse(block: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { ...(event ? { event } : {}), data: data.join("\n") } : undefined;
}

/** Yield each event. A read error (a dropped connection, an abort) is thrown to the caller. */
export async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.search(/\r?\n\r?\n/); end >= 0; end = buffer.search(/\r?\n\r?\n/)) {
        const event = parse(buffer.slice(0, end));
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        if (event) yield event;
      }
    }
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
