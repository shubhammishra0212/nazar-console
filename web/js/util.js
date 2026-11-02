// util.js — small helpers every other script uses. Everything lives on one global object, N, because the page is
// plain <script> files with no bundler (it must work offline from file://).
'use strict';

window.N = window.N || {};

N.util = (() => {
  const $ = id => document.getElementById(id);

  /** el('div', {class: 'x', onclick: fn}, 'text', child) */
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  }

  const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pad = n => String(n).padStart(2, '0');
  const hms = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const duration = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  const ago = ms => {
    if (ms == null) return '—';
    const s = ms / 1000;
    if (s < 60) return `${Math.floor(s)} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    return `${Math.floor(s / 3600)} h ago`;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const csvCell = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  };
  /** Gaussian-ish noise, for demo data. */
  const noise = s => (Math.random() + Math.random() + Math.random() - 1.5) * s * 1.15;

  /** fetch with a hard timeout, for the AI services (the line never waits on them). */
  async function fetchT(url, opts = {}, ms = 2000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); }
    finally { clearTimeout(timer); }
  }

  let toastTimer = 0;
  function toast(text, ms = 3200) {
    const t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  return { $, el, fmt, pad, hms, duration, ago, clamp, median, sleep, csvCell, stamp, noise, fetchT, toast };
})();

/** A tiny event bus: N.on('tel', fn), N.emit('tel', data). */
(() => {
  const subs = {};
  N.on = (name, fn) => { (subs[name] = subs[name] || []).push(fn); };
  N.emit = (name, ...args) => {
    for (const fn of subs[name] || []) {
      try { fn(...args); } catch (e) { console.error(`[${name}]`, e); }
    }
  };
})();
