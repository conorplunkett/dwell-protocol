// --- 3D float layer: cursor tilt + grey shadow + soft gloss -----------------
// Adapted from the "floating card" interaction in the Roster Candidate/Company
// card design handoff (prototype ids 3a/3b), reduced to a plain 3D block: each
// target leans toward the cursor with a critically-damped spring, pops on
// hover, and casts a grey drop shadow that deepens and shifts as it lifts — so
// it reads as a solid block rising off the page. A soft white gloss tracks the
// pointer. No rainbow.
//
// Each target is wrapped at runtime in a .r3d perspective container, becomes
// the tilting .r3d-card, and gets a .r3d-sheen (gloss) injected. One
// requestAnimationFrame loop lerps every channel toward its target. Honors
// prefers-reduced-motion: the CSS falls back to a simple hover lift, no tilt.
//
// The Claude mascot is a special case — it isn't a block, so it gets no
// wrapper/shadow/gloss; it just tilts and drifts with the cursor over the hero
// demo, so it moves along with the blocks it perches on.
(function float3d() {
  // Which lander surfaces float. `display` sets the generated wrapper's box so
  // the host layout is preserved; `tilt` scales the lean (the big advertiser
  // card swings at half strength so it doesn't feel like it's flipping).
  var TARGETS = [
    { sel: ".nav .logo", display: "inline-block", tilt: 1 },     // Dwell mark, top-left
    { sel: ".nav .navbtn-cta", display: "inline-block", tilt: 1 }, // Advertise button
    { sel: ".demo .demo-card", display: "block", tilt: 1 },      // stock spinner + with-dwell blocks
    { sel: ".hero-adv .wl-adv", display: "inline-block", tilt: 1 }, // "Want to be seen by AI native users?"
    { sel: ".surfaces .win", display: "block", tilt: 1 },        // screenshots
    { sel: ".downloads .dl-btn", display: "block", tilt: 1 },    // install buttons
    { sel: ".advertisers .adv-card", display: "block", tilt: 0.5 }, // ad purchase card — half tilt
  ];

  var MAX = 11; // max tilt in degrees
  var kRot = 0.13, kScale = 0.14, kGlow = 0.09, kPt = 0.2; // spring stiffness per channel

  function wrap(el, display) {
    if (el.closest(".r3d")) return null; // already floating
    var w = document.createElement("span");
    w.className = "r3d";
    w.style.display = display;
    if (display === "block") w.style.width = "100%"; // fill the host cell like the target did
    el.parentNode.insertBefore(w, el);

    var sheen = document.createElement("span");
    sheen.className = "r3d-sheen";

    w.appendChild(el);        // the card itself
    el.classList.add("r3d-card");
    el.appendChild(sheen);    // gloss, clipped to the card's rounded rect
    return { wrap: w, card: el, sheen: sheen };
  }

  function boot() {
    var wraps = [];
    TARGETS.forEach(function (t) {
      Array.prototype.forEach.call(document.querySelectorAll(t.sel), function (el) {
        var made = wrap(el, t.display);
        if (made) { made.tilt = t.tilt; wraps.push(made); }
      });
    });

    // Mascot: tilts/drifts with the cursor over the hero demo, no wrapper.
    var mascot = document.getElementById("claude-guy");
    var demo = document.querySelector(".demo");
    var hasMascot = mascot && demo;

    if (!wraps.length && !hasMascot) return;

    var reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Reduced motion: the CSS hover fallback handles the blocks; skip everything
    // motion-driven (mascot included).
    if (reduce) return;

    var states = wraps.map(function (m) {
      return {
        wrap: m.wrap, card: m.card, sheen: m.sheen, tilt: m.tilt,
        rx: 0, ry: 0, s: 1, g: 0, lift: 0,
        trx: 0, try_: 0, ts: 1, tg: 0, tlift: 0,
        mx: 50, my: 50, tmx: 50, tmy: 50,
      };
    });

    states.forEach(function (st) {
      st.wrap.addEventListener("pointermove", function (e) {
        var r = st.wrap.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var px = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
        var py = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
        st.try_ = (px - 0.5) * 2 * MAX * st.tilt;   // rotateY follows horizontal
        st.trx = -(py - 0.5) * 2 * MAX * st.tilt;   // rotateX follows vertical
        st.tmx = px * 100;
        st.tmy = py * 100;
      });
      st.wrap.addEventListener("pointerenter", function () { st.tg = 1; st.ts = 1.045; st.tlift = 1; });
      st.wrap.addEventListener("pointerleave", function () {
        st.tg = 0; st.ts = 1; st.tlift = 0; st.trx = 0; st.try_ = 0; st.tmx = 50; st.tmy = 50;
      });
    });

    // Mascot state, driven off the whole demo region so he leans toward the
    // cursor as it moves across the two blocks.
    var mst = null;
    if (hasMascot) {
      mst = { rx: 0, ry: 0, dx: 0, lift: 0, trx: 0, try_: 0, tdx: 0, tlift: 0 };
      demo.addEventListener("pointermove", function (e) {
        var r = demo.getBoundingClientRect();
        var px = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
        var py = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
        mst.try_ = (px - 0.5) * 2 * 13;   // rotateY
        mst.trx = -(py - 0.5) * 2 * 13;   // rotateX
        mst.tdx = (px - 0.5) * 14;        // drift toward the cursor
        mst.tlift = 1;
      });
      demo.addEventListener("pointerleave", function () {
        mst.trx = 0; mst.try_ = 0; mst.tdx = 0; mst.tlift = 0;
      });
    }

    function tick() {
      states.forEach(function (st) {
        st.rx += (st.trx - st.rx) * kRot;
        st.ry += (st.try_ - st.ry) * kRot;
        st.s += (st.ts - st.s) * kScale;
        st.g += (st.tg - st.g) * kGlow;
        st.lift += (st.tlift - st.lift) * kScale;
        st.mx += (st.tmx - st.mx) * kPt;
        st.my += (st.tmy - st.my) * kPt;
        st.card.style.transform =
          "translateY(" + (-6 * st.lift).toFixed(2) + "px) rotateX(" +
          st.rx.toFixed(2) + "deg) rotateY(" + st.ry.toFixed(2) + "deg) scale(" +
          st.s.toFixed(3) + ")";
        // Grey shadow: offset opposite the horizontal tilt, deeper as it lifts.
        var ox = (-st.ry * 0.9).toFixed(1);
        var oy = (12 + st.lift * 10).toFixed(1);
        var blur = (34 + st.g * 22).toFixed(0);
        var alpha = (0.26 + st.g * 0.16).toFixed(3);
        st.card.style.boxShadow =
          ox + "px " + oy + "px " + blur + "px -20px rgba(17,19,25," + alpha + ")";
        st.sheen.style.opacity = (st.g * 0.7).toFixed(3);
        st.sheen.style.setProperty("--mx", st.mx.toFixed(1) + "%");
        st.sheen.style.setProperty("--my", st.my.toFixed(1) + "%");
      });

      if (mst) {
        mst.rx += (mst.trx - mst.rx) * kRot;
        mst.ry += (mst.try_ - mst.ry) * kRot;
        mst.dx += (mst.tdx - mst.dx) * kPt;
        mst.lift += (mst.tlift - mst.lift) * kScale;
        mascot.style.transform =
          "perspective(500px) translateX(" + mst.dx.toFixed(2) + "px) translateY(" +
          (-5 * mst.lift).toFixed(2) + "px) rotateX(" + mst.rx.toFixed(2) +
          "deg) rotateY(" + mst.ry.toFixed(2) + "deg)";
      }

      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
