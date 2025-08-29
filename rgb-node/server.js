// server.js
const path = require('path');
const Fastify = require('fastify');
const fastifyStatic = require('fastify-static');
const cors = require('fastify-cors');
const { GpioClient } = require('pigpio-client');

const PINS = { r: 17, g: 22, b: 24 }; // your wiring
const PWM_RANGE = 255; // match pigs p <pin> <0..255>

const app = Fastify({ logger: true });
app.register(cors, { origin: true });

app.register(fastifyStatic, {
  root: path.join(__dirname, 'public'), // put your SPA build here
  prefix: '/'
});

// ----- pigpio connection -----
let gpio;
async function connectPigpio() {
  return new Promise((resolve, reject) => {
    const client = GpioClient();
    client.once('connected', () => resolve(client));
    client.once('error', reject);
    client.connect({ host: '127.0.0.1', port: 8888 });
  });
}

// current state
const state = {
  r: 0, g: 0, b: 0,
  brightness: 100,
  effect: 'none'
};

// scale color by brightness
function scaled(v, bright) {
  return Math.round((v * bright) / 100);
}

async function applyColor() {
  const r = scaled(state.r, state.brightness);
  const g = scaled(state.g, state.brightness);
  const b = scaled(state.b, state.brightness);
  await gpio.pwmWrite(PINS.r, r);
  await gpio.pwmWrite(PINS.g, g);
  await gpio.pwmWrite(PINS.b, b);
  broadcast();
}

async function initPins() {
  await gpio.setMode(PINS.r, 'output');
  await gpio.setMode(PINS.g, 'output');
  await gpio.setMode(PINS.b, 'output');
  await gpio.setPWMDutycycleRange(PINS.r, PWM_RANGE);
  await gpio.setPWMDutycycleRange(PINS.g, PWM_RANGE);
  await gpio.setPWMDutycycleRange(PINS.b, PWM_RANGE);
  await applyColor();
}

// ----- SSE (live updates to clients) -----
const clients = new Set();
function sseFormat(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function broadcast() {
  const payload = sseFormat({ type: 'state', state });
  for (const res of clients) res.write(payload);
}

app.get('/api/events', async (req, reply) => {
  reply
    .header('Content-Type', 'text/event-stream')
    .header('Cache-Control', 'no-cache')
    .header('Connection', 'keep-alive')
    .raw.write(sseFormat({ type: 'hello' }));

  clients.add(reply.raw);
  reply.raw.on('close', () => clients.delete(reply.raw));
});

// ----- API -----
app.get('/api/state', async () => ({ ok: true, state }));

app.post('/api/color', async (req, reply) => {
  const { r, g, b } = req.body || {};
  state.r = Math.max(0, Math.min(255, Number(r ?? state.r)));
  state.g = Math.max(0, Math.min(255, Number(g ?? state.g)));
  state.b = Math.max(0, Math.min(255, Number(b ?? state.b)));
  await applyColor();
  reply.send({ ok: true, state });
});

app.post('/api/brightness', async (req, reply) => {
  const { brightness } = req.body || {};
  state.brightness = Math.max(0, Math.min(100, Number(brightness ?? state.brightness)));
  await applyColor();
  reply.send({ ok: true, state });
});

app.post('/api/effect', async (req, reply) => {
  const { effect } = req.body || {};
  state.effect = effect || 'none';
  // simple built-ins (non-blocking)
  if (state.effect === 'strobe') {
    strobe();
  } else if (state.effect === 'pulse') {
    pulse();
  }
  reply.send({ ok: true, state });
});

// simple effect loops (cooperative, cancel by setting effect='none')
async function strobe() {
  const localTag = Symbol(); strobe.tag = localTag;
  while (state.effect === 'strobe' && strobe.tag === localTag) {
    const on = { r: 255, g: 255, b: 255 };
    const off = { r: 0, g: 0, b: 0 };
    Object.assign(state, on); await applyColor();
    await sleep(80);
    Object.assign(state, off); await applyColor();
    await sleep(80);
  }
}
async function pulse() {
  const localTag = Symbol(); pulse.tag = localTag;
  let up = true, v = 0;
  while (state.effect === 'pulse' && pulse.tag === localTag) {
    v += up ? 10 : -10;
    if (v >= 255) { v = 255; up = false; }
    if (v <= 0)   { v = 0;   up = true; }
    state.r = v; state.g = v; state.b = v;
    await applyColor();
    await sleep(40);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ----- start -----
(async () => {
  try {
    const client = await connectPigpio();
    gpio = client.gpio();
    await initPins();

    const port = process.env.PORT || 8080;
    await app.listen(port, '0.0.0.0');
    app.log.info(`RGB Node server listening on :${port}`);
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();
