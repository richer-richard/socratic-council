export function createSseParser(onData: (data: string) => void) {
  let buffer = "";

  const normalize = () => {
    buffer = buffer.replace(/\r\n/g, "\n");
  };

  const processEvent = (event: string) => {
    const lines = event.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    onData(dataLines.join("\n"));
  };

  const push = (text: string) => {
    buffer += text;
    normalize();

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      if (!event.trim()) continue;
      processEvent(event);
    }
  };

  const flush = () => {
    normalize();
    if (!buffer.trim()) {
      buffer = "";
      return;
    }
    processEvent(buffer);
    buffer = "";
  };

  return { push, flush };
}

