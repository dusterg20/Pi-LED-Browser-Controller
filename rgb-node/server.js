// server.js - Node 10 compatible RGB LED controller
// Requires: npm install express pigpio

var express = require('express');
var bodyParser = require('body-parser');
var path = require('path');
var Gpio = require('pigpio').Gpio;

// ---------------- Config ----------------
var PINS = { r: 23, g: 24, b: 25 }; // BCM numbering
var PWM_RANGE = 255;
var PWM_FREQ = 2000; // Hz (reduce flicker)

// ---------------- State -----------------
var state = { r: 0, g: 0, b: 0, brightness: 100, effect: 'none' };
var effectTimer = null;

// SSE clients
var clients = [];

// ---------------- GPIO Setup ------------
var leds = {
  r: new Gpio(PINS.r, { mode: Gpio.OUTPUT }),
  g: new Gpio(PINS.g, { mode: Gpio.OUTPUT }),
  b: new Gpio(PINS.b, { mode: Gpio.OUTPUT })
};

// set PWM freq/range
Object.keys(leds).forEach(function (ch) {
  leds[ch].pwmFrequency(PWM_FREQ);
  leds[ch].pwmRange(PWM_RANGE);
});

// gamma lookup table (65 entries for speed)
var GAMMA = [0,13,22,28,33,37,40,43,46,49,52,55,58,61,64,67,70,73,76,79,82,85,88,91,94,97,100,103,106,109,112,115,118,121,124,127,130,133,136,139,142,145,148,151,154,157,160,163,166,169,172,175,178,181,184,187,190,193,196,199,202,205,208,211,214,217,220,223,226,229,232,235,238,241,244,247,250,253,255];

function applyScale(v) {
  var b = Math.max(0, Math.min(100, state.brightness)) / 100;
  var idx = Math.round((Math.max(0, Math.min(255, v)) / 255) * (GAMMA.length - 1));
  return Math.round(GAMMA[idx] * b);
}

function setRGB(r, g, b) {
  state.r = Math.max(0, Math.min(255, Number(r) || 0));
  state.g = Math.max(0, Math.min(255, Number(g) || 0));
  state.b = Math.max(0, Math.min(255, Number(b) || 0));

  leds.r.pwmWrite(applyScale(state.r));
  leds.g.pwmWrite(applyScale(state.g));
  leds.b.pwmWrite(applyScale(state.b));

  broadcastState();
}

// ---------------- Effects ----------------
function stopEffect() {
  if (effectTimer) { clearInterval(effectTimer); effectTimer = null; }
  state.effect = 'none';
}

function startEffect(body) {
  stopEffect();
  if (!body || !body.name) return;

  var name = String(body.name).toLowerCase();
  if (name === 'strobe') {
    var speed = Math.max(50, Math.min(2000, Number(body.speed) || 300));
    state.effect = 'strobe';
    var on = false;
    effectTimer = setInterval(function () {
      on = !on;
      if (on) setRGB(state.r, state.g, state.b);
      else setRGB(0, 0, 0);
    }, speed);
  }
  else if (name === 'breathe') {
    var period = Math.max(1000, Math.min(10000, Number(body.period) || 3000));
    state.effect = 'breathe';
    var t0 = Date.now();
    effectTimer = setInterval(function () {
      var t = (Date.now() - t0) % period;
      var phase = (t / period) * Math.PI * 2;
      var level = (1 - Math.cos(phase)) / 2; // 0..1
      setRGB(
        Math.round(state.r * level),
        Math.round(state.g * level),
        Math.round(state.b * level)
      );
    }, 40);
  }
}

// ---------------- Express ----------------
var app = express();
app.use(bodyParser.json());

// serve static frontend (index.html in same dir)
app.use(express.static(path.join(__dirname)));

// REST API
app.get('/api/state', function (req, res) {
  res.json({ ok: true, state: state });
});

app.post('/api/color', function (req, res) {
  var r = (req.body && req.body.r !== undefined) ? req.body.r : state.r;
  var g = (req.body && req.body.g !== undefined) ? req.body.g : state.g;
  var b = (req.body && req.body.b !== undefined) ? req.body.b : state.b;
  stopEffect(); // stop effect when manual color is set
  setRGB(r, g, b);
  res.json({ ok: true, state: state });
});

app.post('/api/brightness', function (req, res) {
  var v = (req.body && req.body.brightness !== undefined) ? Number(req.body.brightness) : state.brightness;
  state.brightness = Math.max(0, Math.min(100, v));
  setRGB(state.r, state.g, state.b);
  res.json({ ok: true, state: state });
});

app.post('/api/effect', function (req, res) {
  if (!req.body || !req.body.name || req.body.name === 'none') {
    stopEffect();
    setRGB(state.r, state.g, state.b);
    return res.json({ ok: true, effect: 'none' });
  }
  startEffect(req.body);
  res.json({ ok: true, effect: state.effect });
});

// SSE for live updates
app.get('/api/events', function (req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');
  clients.push(res);
  req.on('close', function () {
    clients = clients.filter(function (c) { return c !== res; });
  });
});

function broadcastState() {
  var msg = 'data: ' + JSON.stringify({ type: 'state', state: state }) + '\n\n';
  clients.forEach(function (c) { c.write(msg); });
}

// ---------------- Start -----------------
var PORT = 3000;
app.listen(PORT, function () {
  console.log('RGB server listening on http://localhost:' + PORT);
  console.log('Make sure pigpio daemon is running: sudo pigpiod');
  setRGB(0, 0, 0);
});
