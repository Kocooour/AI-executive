/** Parse a bounded JSON command without decoding across arbitrary stdin chunk boundaries. */
export async function readTitleCommand(input) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of input) {
    byteLength += chunk.length;
    if (byteLength > 32 * 1024) throw new Error("Too large");
    chunks.push(chunk);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, byteLength));
  return JSON.parse(text);
}
