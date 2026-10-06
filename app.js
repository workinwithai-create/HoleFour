/* HoleFour — four-bar stop-time. Audio-clock desk. Samples pinned to commit SHAs. */
const PIANO = "https://cdn.jsdelivr.net/gh/workinwithai-create/PreEight@d58301e4a494555f411a2afbc448b724136eee76/public/samples";
const GM = "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM";
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const SR = 48000;
const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const CHAIRS = ["piano", "bass", "nylon", "trumpet", "kit"];

const SAMPLE_NOTES = {
  piano: ["C3", "E3", "G3", "A3", "C4", "E4", "G4", "A4", "C5", "E5"],
  bass: ["E1", "G1", "A1", "C2", "E2", "G2", "A2", "C3", "E3"],
  nylon: ["C3", "E3", "G3", "A3", "C4", "E4", "G4", "A4", "C5"],
  trumpet: ["C4", "E4", "G4", "A4", "C5", "E5", "G5", "A5"]
};

const RECIPES = [
  { id: "band-hit", name: "Band hit", blurb: "Everyone on 1. A hole. Nylon and trumpet answer on the and of 3. Kit does not keep time." },
  { id: "guitar-leave", name: "Guitar leave", blurb: "Upright and piano hit the downbeat. Nylon fills the hole with a real acoustic guitar phrase." },
  { id: "brass-stab", name: "Brass stab", blurb: "Trumpet stabs the stop. Bass lands on 1 and the last 16th into the next bar." },
  { id: "late-fill", name: "Late fill", blurb: "Bars 1–2 still groove. Bars 3–4 stop. Snare answers in the hole and does not roll into the seam." },
  { id: "half-rest", name: "Half rest", blurb: "Only the downbeat. The rest of the bar is written silence." },
  { id: "call-back", name: "Call back", blurb: "Piano calls on 1. Trumpet answers two beats later. Bass stays out of the answer." }
];

const state = {
  bpm: 92,
  key: "A minor",
  chords: "Am F C G",
  bars: 4,
  side: "B",
  recipe: "band-hit",
  mutes: { piano: false, bass: false, nylon: false, trumpet: false, kit: false }
};

let ctx = null;
let chairGain = {};
let buffers = {};
let raw = {};
let missing = [];
let timerId = null;
let nextStepTime = 0;
let step = 0;
let anchorTime = 0;
let anchorStep = 0;
let raf = 0;
let active = [];
let started = false;

const $ = (id) => document.getElementById(id);

function midiOf(name) {
  const m = name.match(/^([A-G]b?)(-?\d)$/);
  return NAMES.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
}

function parseChord(token) {
  const t = token.trim();
  const m = t.match(/^([A-G]b?)(.*)$/);
  if (!m) return { root: 0, minor: false, label: "C" };
  const root = NAMES.indexOf(m[1]);
  const minor = /m/.test(m[2]) && !/maj/i.test(m[2]);
  return { root: root < 0 ? 0 : root, minor, label: t };
}

function keyRoot() {
  const m = state.key.match(/^([A-G]b?)/);
  return NAMES.indexOf(m ? m[1] : "A");
}

function progression() {
  return state.chords.split(/\s+/).filter(Boolean).map(parseChord);
}

function chordAt(barIndex) {
  const p = progression();
  return p[barIndex % p.length] || { root: 0, minor: false, label: "C" };
}

function third(ch, base) {
  return base + (ch.minor ? 3 : 4);
}

function nearest(chair, midi) {
  const list = SAMPLE_NOTES[chair];
  let best = list[0];
  let bestD = 99;
  for (const n of list) {
    const d = Math.abs(midiOf(n) - midi);
    if (d < bestD) { bestD = d; best = n; }
  }
  const sampleMidi = midiOf(best);
  let target = midi;
  if (target - sampleMidi > 4) target = sampleMidi + 4;
  if (sampleMidi - target > 4) target = sampleMidi - 4;
  return { key: chair + ":" + best, rate: Math.pow(2, (target - sampleMidi) / 12), midi: target };
}

function recipeMeta() {
  return RECIPES.find((r) => r.id === state.recipe) || RECIPES[0];
}

function eventsFor(local) {
  const events = [];
  const stepDur = 60 / local.bpm / 4;
  const kr = (() => {
    const m = local.key.match(/^([A-G]b?)/);
    return NAMES.indexOf(m ? m[1] : "A");
  })();
  const chords = local.chords.split(/\s+/).filter(Boolean).map(parseChord);
  const chord = (bar) => chords[bar % chords.length] || { root: 0, minor: false, label: "C" };
  const add = (chair, midi, stepIndex, durSteps, gain) => {
    if (local.mutes[chair]) return;
    events.push({
      chair,
      midi,
      time: stepIndex * stepDur,
      dur: durSteps * stepDur,
      gain,
      step: stepIndex
    });
  };
  for (let bar = 0; bar < local.bars; bar++) {
    const ch = chord(bar);
    const root = 60 + ((ch.root - kr + 12) % 12);
    const b0 = bar * 16;
    if (local.side !== "B") {
      add("piano", root, b0, 8, 0.2);
      add("piano", third(ch, root), b0, 8, 0.15);
      add("piano", root + 7, b0, 8, 0.12);
      add("bass", root - 24, b0, 8, 0.32);
      add("bass", root - 17, b0 + 8, 8, 0.26);
      add("nylon", root, b0 + 2, 4, 0.16);
      add("nylon", third(ch, root), b0 + 8, 4, 0.14);
      add("trumpet", root + 12, b0 + 4, 4, 0.12);
      add("kit", 36, b0, 2, 0.42);
      add("kit", 38, b0 + 4, 2, 0.32);
      add("kit", 36, b0 + 8, 2, 0.36);
      add("kit", 38, b0 + 12, 2, 0.32);
      for (let s = 0; s < 16; s += 2) add("kit", 42, b0 + s, 1, 0.12);
      continue;
    }
    const rec = local.recipe;
    const last = bar === local.bars - 1;
    const groove = rec === "late-fill" && bar < Math.max(1, local.bars - 2);
    if (groove) {
      add("piano", root, b0, 6, 0.16);
      add("bass", root - 24, b0, 8, 0.28);
      add("nylon", third(ch, root), b0 + 4, 4, 0.14);
      add("kit", 36, b0, 2, 0.36);
      add("kit", 38, b0 + 8, 2, 0.28);
      continue;
    }
    add("piano", root, b0, 2, 0.22);
    add("piano", third(ch, root), b0, 2, 0.16);
    add("piano", root + 7, b0, 2, 0.14);
    add("bass", root - 24, b0, 3, 0.34);
    if (rec === "half-rest") {
      add("kit", 36, b0, 2, 0.4);
      if (last) add("kit", 38, b0 + 12, 2, 0.22);
      continue;
    }
    if (rec === "guitar-leave") {
      add("nylon", root, b0 + 6, 4, 0.2);
      add("nylon", third(ch, root), b0 + 10, 3, 0.16);
      add("nylon", root + 7, b0 + 13, 2, 0.14);
      add("kit", 36, b0, 2, 0.36);
    } else if (rec === "brass-stab") {
      add("trumpet", root + 12, b0, 2, 0.22);
      add("trumpet", third(ch, root) + 12, b0 + 8, 2, 0.18);
      add("bass", root - 24, b0 + 14, 2, 0.26);
      add("kit", 36, b0, 2, 0.38);
      add("kit", 38, b0 + 8, 1, 0.24);
    } else if (rec === "call-back") {
      add("trumpet", third(ch, root) + 12, b0 + 8, 4, 0.2);
      add("trumpet", root + 12, b0 + 12, 3, 0.16);
      add("kit", 36, b0, 2, 0.34);
    } else if (rec === "late-fill") {
      add("nylon", root, b0 + 8, 3, 0.16);
      add("kit", 36, b0, 2, 0.36);
      add("kit", 38, b0 + 8, 1, 0.28);
      add("kit", 38, b0 + 10, 1, 0.24);
      add("kit", 38, b0 + 12, 1, 0.22);
    } else {
      add("nylon", third(ch, root), b0 + 6, 3, 0.18);
      add("trumpet", root + 12, b0 + 10, 3, 0.18);
      add("kit", 36, b0, 2, 0.38);
      if (!last) add("kit", 42, b0 + 14, 1, 0.1);
    }
  }
  return events;
}

function track(node, audioCtx) {
  if (audioCtx !== ctx) return;
  active.push(node);
  node.onended = () => { active = active.filter((n) => n !== node); };
}

function playNote(audioCtx, when, ev, dest, bag) {
  if (ev.chair === "kit") {
    const map = { 36: "kit:kick", 38: "kit:snare", 42: "kit:hat" };
    const buf = bag[map[ev.midi] || "kit:kick"];
    if (!buf) return;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(Math.max(0.04, ev.gain), when);
    const rel = Math.max(0.05, Math.min(ev.dur, 0.35));
    g.gain.linearRampToValueAtTime(0.0001, when + rel);
    src.connect(g);
    g.connect(dest);
    src.start(when);
    src.stop(when + rel + 0.02);
    track(src, audioCtx);
    return;
  }
  const pick = nearest(ev.chair, ev.midi);
  const buf = bag[pick.key];
  if (!buf) return;
  const hold = Math.max(0.18, ev.dur);
  const slice = 0.42;
  const n = Math.max(1, Math.ceil(hold / (slice * 0.82)));
  for (let i = 0; i < n; i++) {
    const t = when + i * slice * 0.82;
    if (t >= when + hold) break;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.setValueAtTime(pick.rate, t);
    const g = audioCtx.createGain();
    const attack = 0.012;
    const peak = ev.gain;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    const end = Math.min(when + hold, t + slice);
    g.gain.setValueAtTime(Math.max(0.001, peak * 0.8), Math.max(t + attack + 0.01, end - 0.012));
    g.gain.linearRampToValueAtTime(0.0001, end + 0.012);
    src.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(end + 0.03);
    track(src, audioCtx);
  }
}

function scheduleStep(stepIndex, when) {
  const total = state.bars * 16;
  const s = stepIndex % total;
  const local = {
    bpm: state.bpm,
    side: state.side,
    recipe: state.recipe,
    bars: state.bars,
    mutes: state.mutes,
    chords: state.chords,
    key: state.key
  };
  eventsFor(local).forEach((e) => {
    if (e.step === s) playNote(ctx, when, e, chairGain[e.chair], buffers);
  });
}

function scheduler() {
  if (!ctx) return;
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(step, nextStepTime);
    const stepDur = 60 / state.bpm / 4;
    nextStepTime += stepDur;
    step = (step + 1) % (state.bars * 16);
  }
}

function stopAll() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  active.forEach((n) => { try { n.stop(0); } catch (e) { /* ended */ } });
  active = [];
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  document.querySelectorAll(".bar").forEach((el) => el.classList.remove("now"));
}

function paintHead() {
  if (!ctx || !timerId) return;
  const stepDur = 60 / state.bpm / 4;
  const elapsed = ctx.currentTime - anchorTime;
  const pos = anchorStep + elapsed / stepDur;
  const s = ((Math.floor(pos) % (state.bars * 16)) + state.bars * 16) % (state.bars * 16);
  const bar = Math.floor(s / 16);
  document.querySelectorAll(".bar").forEach((el, i) => el.classList.toggle("now", i === bar));
}

function start() {
  if (!ctx || missing.length) return;
  if (ctx.state === "suspended") ctx.resume();
  stopAll();
  nextStepTime = ctx.currentTime + 0.1;
  step = 0;
  anchorTime = nextStepTime;
  anchorStep = 0;
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
  const loop = () => {
    if (!timerId) return;
    paintHead();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}

function wireBus(audioCtx, dest) {
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.knee.value = 6;
  comp.ratio.value = 12;
  comp.attack.value = 0.003;
  comp.release.value = 0.12;
  const out = audioCtx.createGain();
  out.gain.value = 0.72;
  comp.connect(out);
  out.connect(dest);
  const gains = {};
  CHAIRS.forEach((c) => {
    const g = audioCtx.createGain();
    g.gain.value = 0.9;
    g.connect(comp);
    gains[c] = g;
  });
  return gains;
}

function sampleUrl(chair, note) {
  if (chair === "piano" || chair === "bass") return PIANO + "/" + chair + "/" + note + ".mp3";
  if (chair === "nylon") return GM + "/acoustic_guitar_nylon-mp3/" + note + ".mp3";
  if (chair === "trumpet") return GM + "/trumpet-mp3/" + note + ".mp3";
  return "";
}

async function ensureCtx() {
  if (!ctx) {
    ctx = new AudioContext();
    chairGain = wireBus(ctx, ctx.destination);
    await loadSamples();
  }
  if (ctx.state === "suspended") await ctx.resume();
  started = true;
}

async function loadSamples() {
  missing = [];
  const files = [];
  Object.keys(SAMPLE_NOTES).forEach((chair) => {
    SAMPLE_NOTES[chair].forEach((n) => files.push([chair + ":" + n, chair, sampleUrl(chair, n)]));
  });
  [
    ["kit:kick", "kit", PIANO + "/drums/kick.mp3"],
    ["kit:snare", "kit", PIANO + "/drums/snare.mp3"],
    ["kit:hat", "kit", PIANO + "/drums/hihat.mp3"]
  ].forEach((f) => files.push(f));
  let done = 0;
  for (const [key, chair, url] of files) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      const ab = await r.arrayBuffer();
      raw[key] = ab;
      buffers[key] = await ctx.decodeAudioData(ab.slice(0));
    } catch (e) {
      missing.push(chair + " (" + key + ")");
    }
    done += 1;
    $("status").textContent = "Seating chairs " + done + "/" + files.length;
  }
  if (missing.length) {
    const uniq = [...new Set(missing.map((m) => m.split(" ")[0]))];
    $("status").textContent = "Missing instruments: " + uniq.join(", ") + " — " + missing.join("; ");
    return;
  }
  $("status").textContent = "Chairs seated · FluidR3 pinned · " + files.length + " samples";
}

function readForm() {
  state.bpm = Math.max(60, Math.min(180, Number($("bpm").value) || 92));
  state.key = $("key").value;
  state.chords = $("chords").value.trim() || "Am F C G";
  state.bars = Math.max(4, Math.min(8, Number($("bars").value) || 4));
  localStorage.setItem("holefour-v1", JSON.stringify(state));
  paintBars();
  punch();
}

function paintBars() {
  const host = $("barsView");
  host.innerHTML = "";
  host.style.gridTemplateColumns = "repeat(" + state.bars + ", 1fr)";
  for (let i = 0; i < state.bars; i++) {
    const ch = chordAt(i);
    const el = document.createElement("div");
    const hole = state.side === "B" && !(state.recipe === "late-fill" && i < Math.max(1, state.bars - 2));
    el.className = "bar " + (hole ? "hole" : "hit");
    el.innerHTML = "<b>" + (i + 1) + "</b>" + ch.label + (hole ? " · stop" : " · groove");
    host.appendChild(el);
  }
  $("blurb").textContent = state.side === "A"
    ? "Print. The pattern never leaves. This is the loop that talks over the turnaround."
    : recipeMeta().blurb;
}

function punch() {
  const lines = [
    "HoleFour · " + (state.side === "A" ? "print" : recipeMeta().name),
    state.bpm + " bpm · " + state.key + " · " + state.chords,
    state.side === "A" ? "Do not export the print as the stop." : "Drop these " + state.bars + " bars on the turnaround. The next section starts the bar after this file ends.",
    "Hit on 1. Leave the hole. Answer inside the bar. Do not roll across the seam."
  ];
  $("punch").textContent = lines.join("\n");
}

function fileBase() {
  const key = state.key.replace(/\s+/g, "");
  const rec = state.side === "A" ? "print" : state.recipe;
  return "holefour-" + rec + "-" + state.bpm + "bpm-" + key;
}

function write24(view, offset, sample) {
  let v = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388607)));
  if (v < 0) v += 0x1000000;
  view.setUint8(offset, v & 255);
  view.setUint8(offset + 1, (v >> 8) & 255);
  view.setUint8(offset + 2, (v >> 16) & 255);
}

function encodeWav(floatL, floatR, withTail) {
  const n = floatL.length;
  const block = 6;
  const buf = new ArrayBuffer(44 + n * block);
  const v = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + n * block, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, 24, true);
  writeStr(36, "data");
  v.setUint32(40, n * block, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    write24(v, o, floatL[i]);
    write24(v, o + 3, floatR[i]);
    o += 6;
  }
  const blob = new Blob([buf], { type: "audio/wav" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileBase() + (withTail ? "-with-tail" : "") + ".wav";
  a.click();
  return n;
}

async function exportWav(withTail) {
  if (missing.length) return;
  await ensureCtx();
  readForm();
  const bars = state.bars;
  const length = Math.round(bars * 4 * 60 / state.bpm * SR);
  const tailSec = 1.2;
  const offline = new OfflineAudioContext(2, length + Math.round(tailSec * SR), SR);
  const gains = wireBus(offline, offline.destination);
  const decoded = {};
  for (const k of Object.keys(raw)) decoded[k] = await offline.decodeAudioData(raw[k].slice(0));
  const local = {
    bpm: state.bpm,
    side: state.side,
    recipe: state.recipe,
    bars,
    mutes: { ...state.mutes },
    chords: state.chords,
    key: state.key
  };
  const saved = active;
  active = [];
  eventsFor(local).forEach((e) => playNote(offline, e.time, e, gains[e.chair], decoded));
  active = saved;
  const rendered = await offline.startRendering();
  const l = rendered.getChannelData(0);
  const r = rendered.getChannelData(1);
  const loopL = new Float32Array(withTail ? l.length : length);
  const loopR = new Float32Array(withTail ? r.length : length);
  const n = loopL.length;
  for (let i = 0; i < Math.min(n, l.length); i++) { loopL[i] = l[i]; loopR[i] = r[i]; }
  if (!withTail) {
    for (let i = length; i < l.length; i++) {
      const j = i - length;
      if (j < length) { loopL[j] += l[i]; loopR[j] += r[i]; }
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(loopL[i]), Math.abs(loopR[i]));
  const target = Math.pow(10, -1 / 20);
  const g = peak > target ? target / peak : 1;
  for (let i = 0; i < n; i++) { loopL[i] *= g; loopR[i] *= g; }
  const written = encodeWav(loopL, loopR, withTail);
  $("status").textContent = "WAV " + written + " samples · expected " + length + (withTail ? " plus tail" : "");
}

function vlq(n) {
  let v = n;
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function exportMidi() {
  readForm();
  const local = {
    bpm: state.bpm,
    side: state.side,
    recipe: state.recipe,
    bars: state.bars,
    mutes: { ...state.mutes },
    chords: state.chords,
    key: state.key
  };
  const evs = eventsFor(local);
  const ppq = 480;
  const tracks = CHAIRS.map((chair) => {
    const notes = evs.filter((e) => e.chair === chair).map((e) => {
      const midi = e.chair === "kit" ? e.midi : nearest(e.chair, e.midi).midi;
      const start = Math.round(e.time / (60 / local.bpm) * ppq);
      const dur = Math.max(1, Math.round(e.dur / (60 / local.bpm) * ppq));
      return { start, dur, midi, vel: Math.max(1, Math.min(127, Math.round(e.gain * 280))) };
    }).sort((a, b) => a.start - b.start);
    const events = [{ t: 0, b: [0xFF, 0x03].concat([chair.length], Array.from(chair).map((c) => c.charCodeAt(0))) }];
    notes.forEach((n) => {
      events.push({ t: n.start, b: [0x90, n.midi, n.vel] });
      events.push({ t: n.start + n.dur, b: [0x80, n.midi, 0] });
    });
    events.sort((a, b) => a.t - b.t);
    const bytes = [];
    let last = 0;
    events.forEach((e) => {
      vlq(e.t - last).forEach((x) => bytes.push(x));
      last = e.t;
      e.b.forEach((x) => bytes.push(x));
    });
    vlq(0).forEach((x) => bytes.push(x));
    [0xFF, 0x2F, 0x00].forEach((x) => bytes.push(x));
    return bytes;
  });
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255];
  const tempo = Math.round(60000000 / local.bpm);
  const meta = [0x00, 0xFF, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255, 0x00, 0xFF, 0x58, 0x04, 4, 2, 24, 8, 0x00, 0xFF, 0x2F, 0x00];
  const chunks = [meta].concat(tracks).map((bytes) => {
    const out = [0x4d, 0x54, 0x72, 0x6b, (bytes.length >> 24) & 255, (bytes.length >> 16) & 255, (bytes.length >> 8) & 255, bytes.length & 255];
    return out.concat(bytes);
  });
  const all = header.concat(...chunks);
  const blob = new Blob([new Uint8Array(all)], { type: "audio/midi" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileBase() + ".mid";
  a.click();
}

function paintRecipes() {
  const host = $("recipes");
  host.innerHTML = "";
  RECIPES.forEach((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = r.name;
    b.className = r.id === state.recipe ? "on" : "";
    b.addEventListener("click", () => {
      state.recipe = r.id;
      state.side = "B";
      localStorage.setItem("holefour-v1", JSON.stringify(state));
      paintRecipes();
      paintBars();
      punch();
      $("sideA").classList.remove("on");
      $("sideB").classList.add("on");
    });
    host.appendChild(b);
  });
}

function bind() {
  ["bpm", "key", "chords", "bars"].forEach((id) => {
    $(id).addEventListener("change", readForm);
    $(id).addEventListener("input", readForm);
  });
  $("sideA").addEventListener("click", () => {
    state.side = "A";
    $("sideA").classList.add("on");
    $("sideB").classList.remove("on");
    readForm();
  });
  $("sideB").addEventListener("click", () => {
    state.side = "B";
    $("sideB").classList.add("on");
    $("sideA").classList.remove("on");
    readForm();
  });
  document.querySelectorAll("[data-chair]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = btn.getAttribute("data-chair");
      state.mutes[c] = !state.mutes[c];
      btn.classList.toggle("muted", state.mutes[c]);
      localStorage.setItem("holefour-v1", JSON.stringify(state));
    });
  });
  $("play").addEventListener("click", async () => {
    await ensureCtx();
    if (missing.length) return;
    start();
  });
  $("stop").addEventListener("click", stopAll);
  $("wav").addEventListener("click", () => exportWav(false));
  $("tail").addEventListener("click", () => exportWav(true));
  $("mid").addEventListener("click", exportMidi);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopAll();
  });
}

function boot() {
  try {
    const saved = JSON.parse(localStorage.getItem("holefour-v1") || "null");
    if (saved) Object.assign(state, saved);
  } catch (e) { /* ignore */ }
  $("bpm").value = state.bpm;
  $("key").value = state.key;
  $("chords").value = state.chords;
  $("bars").value = state.bars;
  paintRecipes();
  paintBars();
  punch();
  bind();
  $("status").textContent = "Tap Play to start audio";
}

boot();
