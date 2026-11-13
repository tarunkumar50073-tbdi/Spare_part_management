// A packet's QR label as a 300 dpi black-and-white picture, for printing
// straight to the label printer through the DX label helper (5 Nov 2026: "ye
// a4 printer nhi jo ye popup aayega, print mtlb sidha print"). The same
// picture is the preview, so what is seen is what prints.
//
// Same layout as utils/packetLabels.js (the browser print): a tiny label is
// the QR (code | spec) with the bold TB code under it; a bigger one is the QR
// with its code, then Part No., the whole description (shrunk to fit) and the
// location. On top of it each PC can tune a size ("parametrs adjust k sath ok
// h ... left right etc"): move it left / right and up / down, the QR's size,
// and the text size. The store's 25 x 15 mm GoDEX roll starts at the sample
// it passed on 5 Nov 2026: 1.5 mm left, 0.2 mm up, code 4.2 pt.
//
// The QR's squares are whole printer dots, every one the same (10 Nov 2026:
// the gun read an HP sticker's small, full QR but not our 8.7 mm one, whose
// squares were 2-3 dots and smudged on the thermal roll). The QR takes as many
// dots a square as the label has room for; "QR size" on this PC steps one dot
// a square at a time (tune.mod). The old fixed size in mm (tune.qr) is no
// longer used.
import { QRCodeDecoderErrorCorrectionLevel, QRCodeEncoder } from "@zxing/library";
import { DOTS_PER_MM, PRINTER_DPI, TIERS, TINY, fitPt, labelTier, qrDots, tinyQr } from "./packetLabels.js";

export const DPI = PRINTER_DPI;
const PX = DOTS_PER_MM;                // dots per mm
const PT = 0.3528;                     // mm per point

const TUNE_KEY = "dx_label_tune_v1";
const BASE_TUNE = { dx: 0, dy: 0, mod: null, text: 100 };
// Sizes tuned on the store's own printer, by "w x h".
const TUNED = { "25x15": { dx: -1.5, dy: -0.2, text: 84 } };

const sizeKey = (size) => `${Number(size.w)}x${Number(size.h)}`;

export function defaultTune(size) {
  return { ...BASE_TUNE, ...(TUNED[sizeKey(size)] || {}) };
}

export function savedTune(size) {
  try {
    const all = JSON.parse(localStorage.getItem(TUNE_KEY)) || {};
    return { ...defaultTune(size), ...(all[sizeKey(size)] || {}) };
  } catch {
    return defaultTune(size);
  }
}

export function saveTune(size, tune) {
  try {
    const all = JSON.parse(localStorage.getItem(TUNE_KEY)) || {};
    all[sizeKey(size)] = tune;
    localStorage.setItem(TUNE_KEY, JSON.stringify(all));
  } catch { /* remembered for this visit only */ }
}

function qrRows(text) {
  const m = QRCodeEncoder.encode(String(text), QRCodeDecoderErrorCorrectionLevel.M).getMatrix();
  const n = m.getWidth();
  const rows = [];
  for (let y = 0; y < n; y += 1) {
    const r = [];
    for (let x = 0; x < n; x += 1) r.push(m.get(x, y) === 1);
    rows.push(r);
  }
  return rows;
}

// Squares on printer dots: the QR starts on a dot and every square is exactly
// `dots` x `dots`.
function drawQr(ctx, rows, xMm, yMm, dots) {
  const n = rows.length;
  const x0 = Math.round(xMm * PX), y0 = Math.round(yMm * PX);
  ctx.fillStyle = "#000";
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (rows[y][x]) ctx.fillRect(x0 + x * dots, y0 + y * dots, dots, dots);
    }
  }
}

function font(ctx, pt, family, bold = true) {
  ctx.font = `${bold ? "bold " : ""}${(pt / 72) * DPI}px ${family}`;
}

// Words to lines no wider than maxPx; a word longer than a line breaks anywhere.
function wrap(ctx, text, maxPx) {
  const lines = [];
  let line = "";
  for (const word of String(text || "").split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxPx) { line = next; continue; }
    if (line) lines.push(line);
    line = "";
    let w = word;
    while (ctx.measureText(w).width > maxPx && w.length > 1) {
      let cut = w.length - 1;
      while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxPx) cut -= 1;
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    line = w;
  }
  if (line) lines.push(line);
  return lines;
}

function text(ctx, s, xMm, yMm, align = "left") {
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000";
  ctx.fillText(s, xMm * PX, yMm * PX);
}

// White between the QR and the code under it: about one square.
const GAP = 0.35;

// Dots a square: as many as fit (`auto`, a little white kept around the QR),
// or this PC's own pick (tune.mod) up to all the room there is (`most`).
function pickDots(n, autoMm, roomMm, tune) {
  const auto = qrDots(n, autoMm), most = qrDots(n, roomMm);
  const dots = tune.mod ? Math.min(most, Math.max(3, Math.round(tune.mod))) : auto;
  return { n, auto, most, dots, side: (n * dots) / PX };
}

function tinyFit(p, w, h, tune) {
  const pad = TINY.pad;
  const code = String(p.code || "");
  const autoPt = Math.min(TINY.maxCodePt, ((w - 2 * pad) / (Math.max(code.length, 8) * 0.6)) / PT);
  const codePt = autoPt * (tune.text / 100);
  const codeMm = codePt * PT * 1.1;
  const rows = qrRows(tinyQr(p));
  const n = rows.length;
  const room = Math.max(8, Math.min(w - 2 * pad, h - 2 * pad - codeMm - GAP));
  return { code, codePt, codeMm, rows, ...pickDots(n, (room * n) / (n + 1), room, tune) };
}

function drawTiny(ctx, p, w, h, tune) {
  const f = tinyFit(p, w, h, tune);
  const top = (h - (f.side + GAP + f.codeMm)) / 2 + tune.dy;
  const cx = w / 2 + tune.dx;
  drawQr(ctx, f.rows, cx - f.side / 2, top, f.dots);
  font(ctx, f.codePt, "'Courier New', monospace");
  text(ctx, f.code, cx, top + f.side + GAP, "center");
}

function fullFit(p, w, h, tier, tune) {
  const t = TIERS[tier];
  const k = Math.min(1.5, Math.max(0.85, Math.min(w / t.ref[0], h / t.ref[1])));
  const pad = tier === "SMALL" ? 1.2 : 2;
  const box = Math.max(10, Math.min(h - 2 * pad - t.code * k * 0.42 - 0.5, w * 0.42));
  // The same QR on every size (13 Nov 2026: "bade & chote lable par same chape"): code + model no.
  const rows = qrRows(tinyQr(p));
  const n = rows.length;
  return { t, k, pad, box, rows, ...pickDots(n, (box * n) / (n + 4), box, tune) };
}

function drawFull(ctx, p, w, h, tier, tune) {
  const { t, k, pad, box, rows, dots, side } = fullFit(p, w, h, tier, tune);
  const s = tune.text / 100;
  const padX = pad + 0.5;
  const gap = tier === "SMALL" ? 1.5 : 2.5;
  const code = String(p.code || "");
  const codePt = Math.min(t.code * k, (box / (Math.max(code.length, 8) * 0.6)) / PT) * s;
  // The QR with its code under it, centred down the label.
  const qTop = (h - (side + 0.3 + codePt * PT * 1.1)) / 2 + tune.dy;
  const qCx = padX + box / 2 + tune.dx;
  drawQr(ctx, rows, qCx - side / 2, qTop, dots);
  font(ctx, codePt, "'Courier New', monospace");
  text(ctx, code, qCx, qTop + side + 0.3, "center");
  // Part No., description, location beside it, centred down the label.
  const part = p.part || {};
  const colX = padX + box + gap + tune.dx;
  const colW = w - 2 * padX - gap - box;
  const pnPt = t.pn * k * s, locPt = t.loc * k * s;
  const colH = h - 2 * pad - pnPt * PT * 1.05 - locPt * PT * 1.2 - 1.3;
  const dsPt = fitPt(part.part_name, colW, colH, t.ds * k) * s;
  font(ctx, dsPt, "Arial, Helvetica, sans-serif");
  const ds = part.part_name ? wrap(ctx, part.part_name, colW * PX) : [];
  font(ctx, pnPt, "Arial, Helvetica, sans-serif");
  const pn = wrap(ctx, part.part_no || "", colW * PX);
  font(ctx, locPt, "Arial, Helvetica, sans-serif");
  const loc = p.location ? wrap(ctx, p.location, colW * PX) : [];
  const height = pn.length * pnPt * PT * 1.05 + (ds.length ? 0.7 + ds.length * dsPt * PT * 1.15 : 0)
    + (loc.length ? 0.6 + loc.length * locPt * PT * 1.2 : 0);
  let y = (h - height) / 2 + tune.dy;
  font(ctx, pnPt, "Arial, Helvetica, sans-serif");
  for (const l of pn) { text(ctx, l, colX, y); y += pnPt * PT * 1.05; }
  if (ds.length) {
    y += 0.7;
    font(ctx, dsPt, "Arial, Helvetica, sans-serif");
    for (const l of ds) { text(ctx, l, colX, y); y += dsPt * PT * 1.15; }
  }
  if (loc.length) {
    y += 0.6;
    font(ctx, locPt, "Arial, Helvetica, sans-serif");
    for (const l of loc) { text(ctx, l, colX, y); y += locPt * PT * 1.2; }
  }
}

// The QR a label gets on this PC: its squares (n), dots a square (dots; auto
// and the most that fit) and its size in mm (side) — for the "QR size" step.
export function qrFit(packet, size, tune = savedTune(size)) {
  const w = Number(size.w), h = Number(size.h);
  const tier = labelTier(h, w);
  const f = tier === "TINY" ? tinyFit(packet, w, h, tune) : fullFit(packet, w, h, tier, tune);
  return { n: f.n, dots: f.dots, auto: f.auto, most: f.most, side: f.side };
}

// The label as a canvas: white, then black only (no grey - a thermal printer
// prints a dot or nothing).
export function labelCanvas(packet, size, tune = savedTune(size)) {
  const w = Number(size.w), h = Number(size.h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * PX);
  canvas.height = Math.round(h * PX);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tier = labelTier(h, w);
  if (tier === "TINY") drawTiny(ctx, packet, w, h, tune);
  else drawFull(ctx, packet, w, h, tier, tune);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 150 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function labelPng(packet, size, tune) {
  return labelCanvas(packet, size, tune).toDataURL("image/png");
}
