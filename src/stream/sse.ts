/**
 * Server-sent events, both ends of the wire.
 *
 * A stream of parts crosses HTTP as SSE in every product that shows an answer
 * while it is written, and the two halves are always hand-written — one in the
 * server, one in the browser — by different people on different days. The
 * format is small enough that each half gets something slightly wrong: a
 * carriage return, an event split across two network chunks, a comment line.
 * Both halves live here, next to the parts they carry, and neither touches a
 * socket or a response object: the host writes the string wherever it writes.
 */

/** One event: its name, and its payload already parsed from JSON. */
export interface SseMessage<T = unknown> {
  /** `message` when the event carried no name. */
  event: string;
  data: T;
}

/**
 * One event, ready to be written to the response.
 *
 * The payload goes out as JSON on a single `data:` line. JSON never contains a
 * raw line break, so no payload can end the event early.
 *
 * @param event Name for anything that is not part of the answer itself.
 */
export function encodeSse(data: unknown, event?: string): string {
  const name = event?.replace(/[\r\n]/g, '');
  return `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Reassembles events from text as it arrives.
 *
 * Network chunks do not respect event boundaries, so whatever follows the last
 * complete event is held until the rest of it comes. An event whose data is
 * not JSON is skipped rather than thrown: one malformed line from a proxy must
 * not end an answer that is otherwise arriving fine.
 */
export class SseDecoder {
  private buffer = '';

  /** Feed decoded text. Returns the events it completed, in order. */
  public push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    // The spec allows CRLF and bare CR as well as LF; normalised once so the
    // boundary search below only has one separator to look for. A CR at the
    // very end may be the first half of a CRLF and waits for the next chunk.
    const pendingCr = this.buffer.endsWith('\r');
    const text = (pendingCr ? this.buffer.slice(0, -1) : this.buffer)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    const messages: SseMessage[] = [];
    let rest = text;
    let boundary = rest.indexOf('\n\n');
    while (boundary !== -1) {
      const message = parseEvent(rest.slice(0, boundary));
      if (message) messages.push(message);
      rest = rest.slice(boundary + 2);
      boundary = rest.indexOf('\n\n');
    }

    this.buffer = pendingCr ? `${rest}\r` : rest;
    return messages;
  }

  /** The event left in the buffer when the stream ended without a blank line. */
  public flush(): SseMessage[] {
    const text = this.buffer.replace(/\r\n?/g, '\n');
    this.buffer = '';
    const message = parseEvent(text);
    return message ? [message] : [];
  }
}

function parseEvent(raw: string): SseMessage | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon belongs to the syntax, not the value.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as unknown };
  } catch {
    return null;
  }
}
