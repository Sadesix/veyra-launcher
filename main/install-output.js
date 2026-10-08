const { StringDecoder } = require('node:string_decoder');

// Preserve UTF-8 and line boundaries when Java splits output into chunks.
function observeOutput(stream, source, write) {
  if (!stream) return;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = (text, final = false) => {
    pending += text;
    const lines = pending.split(/\r\n|[\r\n]/);
    pending = final ? '' : lines.pop();
    for (const line of lines) if (line.trim()) write(line, source);
    if (pending.length > 8192) { write(pending.slice(0, 8192), source); pending = ''; }
  };
  stream.on('data', chunk => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  stream.once('end', () => consume(decoder.end(), true));
}
function cleanOutput(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 8192);
}
module.exports = { observeOutput, cleanOutput };
