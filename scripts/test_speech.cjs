const { strict: assert } = require('node:assert');
const { stripTypeScriptTypes } = require('node:module');
const fs = require('node:fs');
const vm = require('node:vm');
function load(file, dependencies, globals) {
  const module = { exports: {} };
  const js = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'))
    .replace(/import \{([^}]+)\} from '([^']+)';/g, 'const {$1} = require("$2");')
    .replace(/export /g, '') + '\nObject.assign(exports, { ' + (file.includes('asrClient') ? 'transcribeAudio' : 'InterpretationEngine') + ' });';
  vm.runInNewContext(js, { module, exports: module.exports, require: name => dependencies[name], Blob, console, setTimeout, clearTimeout, ...globals });
  return module.exports;
}
(async () => {
  let envelope;
  const client = load('src/asrClient.ts', {}, {
    Request, Response, FormData, Headers, AbortSignal, Uint8Array, btoa,
    fetch: async (_, init) => { envelope = JSON.parse(init.body); return Response.json({ text: 'hello' }); }
  });
  const config = { providerId: 'openai-whisper', baseUrl: 'https://example.test/v1', apiKey: 'test', modelId: 'whisper', language: 'en' };
  assert.equal(await client.transcribeAudio(new Blob(['recorded-audio'], { type: 'audio/mp4' }), config), 'hello');
  const form = await new Response(Buffer.from(envelope.bodyBase64, 'base64'), { headers: envelope.headers }).formData();
  assert.equal(form.get('file').name, 'audio.m4a');
  assert.equal(await form.get('file').text(), 'recorded-audio');
  assert.equal(form.get('model'), 'whisper');
  console.log('PASS multipart audio, MIME extension, model and payload survive local proxy envelope');

  const turns = [];
  let saved = false;
  let ended = false;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      setTimeout(() => { this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.({}); }, 1);
    }
  }
  const { InterpretationEngine } = load('src/interpretation.ts', {
    './asrClient': { isAsrReady: () => true, transcribeAudio: async () => { await new Promise(r => setTimeout(r, 25)); return 'last segment'; } },
    './localDb': { createSession: async () => 7, addTurn: async (...args) => turns.push(args), saveRecording: async () => { saved = true; }, endSession: async () => { ended = true; } },
    './activityLog': { recordActivity() {} }, './modelClient': {}, './translateServices': {}
  }, {
    window: { setInterval, clearInterval, setTimeout },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    MediaRecorder: Recorder, cancelAnimationFrame() {}
  });
  const engine = new InterpretationEngine({ ...config, preset: { chunkIntervalMs: 5000 } }, null, 'zh');
  const lines = [];
  engine.onLine = line => lines.push(line);
  await engine.start('en', () => {});
  await engine.stop();
  assert(saved && ended);
  assert.equal(turns.length, 2);
  assert.equal(turns[0][0], 7);
  assert.equal(turns[0][2], 'last segment');
  assert.equal(turns[0][3], turns[1][3]);
  assert(turns[0][3] < 25, 'timestamp is captured before delayed recognition');
  assert.equal(lines.at(-1).pending, false);
  console.log('PASS final segment saved, matching source/target offsets, recording persisted before session finishes');
})().catch(error => { console.error(error); process.exitCode = 1; });
