/* APAAR platform — tiny dependency-free canvas chart library.
   All charts are HiDPI-aware, animated, and re-render on resize. */
(function (global) {
  'use strict';

  var PALETTE = ['#2d4bff', '#7c5cff', '#f5a524', '#17b978', '#22c9e0', '#f4436c', '#f7a53b', '#4f6bff', '#0c8a58', '#d12249'];

  function setupCanvas(cv, height) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || cv.parentElement.clientWidth || 300;
    var h = height || cv.clientHeight || 220;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function ease(t) { return 1 - Math.pow(1 - t, 3); }

  function animate(draw, ms) {
    var start = null;
    var duration = ms || 900;
    var raf;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      draw(ease(t));
      if (t < 1) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return function cancel() { cancelAnimationFrame(raf); };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var charts = [];

  function register(cv, render) {
    var entry = { cv: cv, render: render };
    charts.push(entry);
    render(1);
    return entry;
  }

  window.addEventListener('resize', function () {
    charts.forEach(function (c) {
      if (!document.body.contains(c.cv)) return;
      c.render(1);
    });
  });

  /* ---------- vertical bars ------------------------------------------------ */
  function barChart(cv, data, opts) {
    opts = opts || {};
    var colorA = opts.color || '#2d4bff';
    var colorB = opts.color2 || '#7c5cff';
    var valueFmt = opts.valueFmt || function (v) { return String(v); };
    var cancel;
    function draw(p) {
      var s = setupCanvas(cv, opts.height || 230);
      var ctx = s.ctx, W = s.w, H = s.h;
      ctx.clearRect(0, 0, W, H);
      if (!data.length) return;
      var padL = 44, padR = 12, padT = 18, padB = 40;
      var cw = W - padL - padR, ch = H - padT - padB;
      var max = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;
      max = max * 1.15;

      // grid + y labels
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      var steps = 4;
      for (var i = 0; i <= steps; i++) {
        var gv = (max / steps) * i;
        var gy = padT + ch - (gv / max) * ch;
        ctx.strokeStyle = i === 0 ? '#d9dff0' : '#eef1f9';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, gy);
        ctx.lineTo(W - padR, gy);
        ctx.stroke();
        ctx.fillStyle = '#8a92b0';
        ctx.fillText(compact(gv), padL - 8, gy);
      }

      var n = data.length;
      var slot = cw / n;
      var bw = Math.min(slot * 0.56, 54);
      data.forEach(function (d, idx) {
        var x = padL + slot * idx + (slot - bw) / 2;
        var full = (d.value / max) * ch;
        var bh = full * p;
        var y = padT + ch - bh;
        var grad = ctx.createLinearGradient(0, y, 0, padT + ch);
        grad.addColorStop(0, d.color || (idx === n - 1 ? colorB : colorA));
        grad.addColorStop(1, d.color ? hexA(d.color || colorA, 0.55) : hexA(idx === n - 1 ? colorB : colorA, 0.45));
        ctx.fillStyle = grad;
        if (bh > 1) { roundRect(ctx, x, y, bw, Math.max(bh, 3), 6); ctx.fill(); }

        // value on top
        if (p > 0.6) {
          ctx.globalAlpha = (p - 0.6) / 0.4;
          ctx.fillStyle = '#17203a';
          ctx.font = '700 11px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(valueFmt(d.value), x + bw / 2, y - 7);
          ctx.globalAlpha = 1;
        }
        // x label
        ctx.fillStyle = '#5a6485';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        wrapLabel(ctx, d.label, x + bw / 2, padT + ch + 12, slot - 4, 2);
      });
    }
    if (cancel) cancel();
    cancel = animate(draw, 850);
    return register(cv, function (p) { draw(p); });
  }

  /* ---------- horizontal bars ---------------------------------------------- */
  function hbarChart(cv, data, opts) {
    opts = opts || {};
    function draw(p) {
      var rowH = opts.rowH || 34;
      // Size to the data, but honour a minimum so a short list (e.g. an
      // institution-scoped dashboard with one row) still fills its card
      // instead of collapsing to a sliver. Extra room is shared as padding.
      var contentH = data.length * rowH + 10;
      var s = setupCanvas(cv, Math.max(contentH, opts.minH || 0));
      var ctx = s.ctx, W = s.w;
      ctx.clearRect(0, 0, W, s.h);
      if (!data.length) return;
      var top = Math.max(6, (s.h - contentH) / 2 + 6);
      var labelW = opts.labelW || 150;
      var max = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;
      var valW = 58;
      var barW = W - labelW - valW - 12;
      data.forEach(function (d, i) {
        var y = i * rowH + top;
        ctx.font = '600 12px Inter, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillStyle = '#5a6485';
        ctx.fillText(clip(d.label, 22), labelW - 10, y + rowH / 2 - 4);

        var bx = labelW;
        var by = y + rowH / 2 - 12;
        ctx.fillStyle = '#eef1f9';
        roundRect(ctx, bx, by, barW, 14, 7); ctx.fill();

        var w = (d.value / max) * barW * p;
        if (w > 1) {
          var grad = ctx.createLinearGradient(bx, 0, bx + barW, 0);
          grad.addColorStop(0, d.color || '#2d4bff');
          grad.addColorStop(1, d.color ? hexA(d.color, 0.65) : '#7c5cff');
          ctx.fillStyle = grad;
          roundRect(ctx, bx, by, Math.max(w, 8), 14, 7); ctx.fill();
        }
        ctx.textAlign = 'left';
        ctx.fillStyle = '#17203a';
        ctx.font = '700 12px Inter, sans-serif';
        ctx.fillText(d.display || String(d.value), bx + barW + 8, by + 7);
      });
    }
    animate(draw, 850);
    return register(cv, function (p) { draw(p); });
  }

  /* ---------- donut -------------------------------------------------------- */
  function donutChart(cv, data, opts) {
    opts = opts || {};
    function draw(p) {
      var s = setupCanvas(cv, opts.height || 220);
      var ctx = s.ctx, W = s.w, H = s.h;
      ctx.clearRect(0, 0, W, H);
      if (!data.length) return;
      var total = data.reduce(function (a, d) { return a + d.value; }, 0) || 1;
      var cx = W / 2, cy = H / 2;
      var r = Math.min(W, H) / 2 - 16;
      var lw = Math.max(20, r * 0.32);
      var start = -Math.PI / 2;
      data.forEach(function (d, i) {
        var frac = d.value / total;
        var sweep = frac * Math.PI * 2 * p;
        ctx.beginPath();
        ctx.arc(cx, cy, r - lw / 2, start, start + sweep);
        ctx.strokeStyle = d.color || PALETTE[i % PALETTE.length];
        ctx.lineWidth = lw;
        ctx.lineCap = 'butt';
        ctx.stroke();
        start += sweep + (p > 0.02 ? 0.022 : 0);
      });
      // center label
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#17203a';
      ctx.font = '800 26px Inter, sans-serif';
      ctx.fillText(opts.centerLabel || compact(total), cx, cy - 7);
      ctx.fillStyle = '#8a92b0';
      ctx.font = '700 11px Inter, sans-serif';
      ctx.fillText((opts.centerSub || 'TOTAL').toUpperCase(), cx, cy + 16);
    }
    animate(draw, 900);
    return register(cv, function (p) { draw(p); });
  }

  /* ---------- line / area --------------------------------------------------- */
  function lineChart(cv, data, opts) {
    opts = opts || {};
    function draw(p) {
      var s = setupCanvas(cv, opts.height || 230);
      var ctx = s.ctx, W = s.w, H = s.h;
      ctx.clearRect(0, 0, W, H);
      if (data.length < 2) return;
      var padL = 44, padR = 14, padT = 16, padB = 36;
      var cw = W - padL - padR, ch = H - padT - padB;
      var max = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;
      max *= 1.2;

      ctx.font = '11px Inter, sans-serif';
      for (var i = 0; i <= 4; i++) {
        var gv = (max / 4) * i;
        var gy = padT + ch - (gv / max) * ch;
        ctx.strokeStyle = i === 0 ? '#d9dff0' : '#eef1f9';
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
        ctx.fillStyle = '#8a92b0'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(compact(gv), padL - 8, gy);
      }

      var pts = data.map(function (d, idx) {
        return [padL + (idx / (data.length - 1)) * cw, padT + ch - (d.value / max) * ch];
      });
      var visible = Math.max(2, Math.ceil(pts.length * p));

      // area
      ctx.beginPath();
      ctx.moveTo(pts[0][0], padT + ch);
      for (var j = 0; j < visible; j++) ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.lineTo(pts[visible - 1][0], padT + ch);
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
      grad.addColorStop(0, hexA(opts.color || '#2d4bff', 0.30));
      grad.addColorStop(1, hexA(opts.color || '#2d4bff', 0.02));
      ctx.fillStyle = grad; ctx.fill();

      // line
      ctx.beginPath();
      for (var k = 0; k < visible; k++) {
        var pt = pts[k];
        if (k === 0) ctx.moveTo(pt[0], pt[1]);
        else ctx.lineTo(pt[0], pt[1]);
      }
      ctx.strokeStyle = opts.color || '#2d4bff';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // dots + labels
      for (var m = 0; m < visible; m++) {
        ctx.beginPath();
        ctx.arc(pts[m][0], pts[m][1], 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = opts.color || '#2d4bff'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.fillStyle = '#5a6485';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      data.forEach(function (d, idx) {
        if (data.length > 9 && idx % 2 === 1) return;
        ctx.fillText(d.label, padL + (idx / (data.length - 1)) * cw, padT + ch + 10);
      });
    }
    animate(draw, 950);
    return register(cv, function (p) { draw(p); });
  }

  /* ---------- gauge -------------------------------------------------------- */
  function gaugeChart(cv, value, opts) {
    opts = opts || {};
    function draw(p) {
      var s = setupCanvas(cv, opts.height || 150);
      var ctx = s.ctx, W = s.w, H = s.h;
      ctx.clearRect(0, 0, W, H);
      var cx = W / 2, cy = H - 14;
      var r = Math.min(W / 2 - 10, H - 26);
      var start = Math.PI, end = Math.PI * 2;
      // track
      ctx.beginPath(); ctx.arc(cx, cy, r, start, end);
      ctx.strokeStyle = '#eef1f9'; ctx.lineWidth = 16; ctx.lineCap = 'round'; ctx.stroke();
      // value arc
      var pct = Math.min(1, value / 100) * p;
      ctx.beginPath(); ctx.arc(cx, cy, r, start, start + (end - start) * pct);
      var grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
      grad.addColorStop(0, opts.colorA || '#2d4bff');
      grad.addColorStop(1, opts.colorB || '#7c5cff');
      ctx.strokeStyle = grad; ctx.lineWidth = 16; ctx.lineCap = 'round'; ctx.stroke();
      // text
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#17203a';
      ctx.font = '800 30px Inter, sans-serif';
      ctx.fillText((value * p).toFixed(1).replace(/\.0$/, '') + '%', cx, cy - 8);
      ctx.fillStyle = '#8a92b0';
      ctx.font = '700 11px Inter, sans-serif';
      ctx.fillText((opts.label || '').toUpperCase(), cx, cy + 12);
    }
    animate(draw, 1000);
    return register(cv, function (p) { draw(p); });
  }

  /* ---------- helpers ------------------------------------------------------ */
  function compact(v) {
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v * 10) / 10);
  }
  function clip(str, n) { return str.length > n ? str.slice(0, n - 1) + '…' : str; }
  function wrapLabel(ctx, text, x, y, maxW, maxLines) {
    var words = String(text).split(' ');
    var line = '', lines = [];
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; }
      else line = test;
      if (lines.length === maxLines) break;
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (lines.length === maxLines && words.length > 1) {
      var last = lines[maxLines - 1];
      while (ctx.measureText(last + '…').width > maxW && last.length > 1) last = last.slice(0, -1);
      lines[maxLines - 1] = last + (last !== line ? '…' : '');
    }
    lines.forEach(function (ln, i) { ctx.fillText(ln, x, y + i * 13); });
  }
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  global.Charts = {
    bar: barChart, hbar: hbarChart, donut: donutChart,
    line: lineChart, gauge: gaugeChart,
    palette: PALETTE, compact: compact
  };
})(window);
