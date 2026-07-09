// --- 3D float layer: cursor tilt + rainbow bloom + specular sheen -----------
// A verbatim port of the "floating card" interaction from the Roster
// Candidate/Company card design handoff (prototype ids 3a/3b): cards tilt
// toward the cursor with a critically-damped spring, pop on hover, bloom a
// rainbow halo from underneath, and catch a moving specular glare. Only the
// physics + sheen layer of that handoff is implemented here — nothing else.
//
// Each target is wrapped at runtime in a .r3d perspective container, becomes
// the tilting .r3d-card, and gets a .r3d-glow (behind) and .r3d-sheen (on top)
// injected. One requestAnimationFrame loop lerps every channel toward its
// target. Honors prefers-reduced-motion: the halo just fades, no tilt/sheen.
(function float3d() {
  // Which lander surfaces float. `display` sets the generated wrapper's box so
  // the host layout (nav flex row, download grid, form column) is preserved.
  //  · spinning logo      → the eight-dot brand mark in the nav
  //  · ad logo            → the sponsor brand chips (demo + live preview)
  //  · screenshots        → the framed product windows in the surfaces showcase
  //  · install buttons    → the Chrome / Mac quick-install buttons
  //  · ad purchase modal  → the advertiser checkout card
  var TARGETS = [
    { sel: ".nav .logo", display: "inline-block" },
    { sel: ".brandchip", display: "inline-block" },
    { sel: ".adpreview-chip", display: "inline-block" },
    { sel: ".surfaces .win", display: "block" },
    { sel: ".downloads .dl-btn", display: "block" },
    { sel: ".advertisers .adv-card", display: "block" },
  ];

  var MAX = 11; // max tilt in degrees
  var kRot = 0.13, kScale = 0.14, kGlow = 0.09, kPt = 0.2; // spring stiffness per channel

  function wrap(el, display) {
    if (el.closest(".r3d")) return null; // already floating
    var w = document.createElement("span");
    w.className = "r3d";
    w.style.display = display;
    // Keep block wrappers from collapsing the target's own width/centering.
    if (display === "block") w.style.width = "100%";
    el.parentNode.insertBefore(w, el);

    var glow = document.createElement("span");
    glow.className = "r3d-glow";
    var sheen = document.createElement("span");
    sheen.className = "r3d-sheen";

    w.appendChild(glow);      // behind the card
    w.appendChild(el);        // the card itself
    el.classList.add("r3d-card");
    el.appendChild(sheen);    // clipped to the card's rounded rect
    return { wrap: w, card: el, glow: glow, sheen: sheen };
  }

  function boot() {
    var wraps = [];
    TARGETS.forEach(function (t) {
      Array.prototype.forEach.call(document.querySelectorAll(t.sel), function (el) {
        var made = wrap(el, t.display);
        if (made) wraps.push(made);
      });
    });
    if (!wraps.length) return;

    var reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      // Reduced motion: no tilt/sheen, just fade the rainbow halo on hover.
      wraps.forEach(function (st) {
        st.wrap.addEventListener("pointerenter", function () { st.glow.style.opacity = "0.85"; });
        st.wrap.addEventListener("pointerleave", function () { st.glow.style.opacity = "0"; });
      });
      return;
    }

    var states = wraps.map(function (m) {
      return {
        wrap: m.wrap, card: m.card, glow: m.glow, sheen: m.sheen,
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
        st.try_ = (px - 0.5) * 2 * MAX;   // rotateY follows horizontal
        st.trx = -(py - 0.5) * 2 * MAX;   // rotateX follows vertical
        st.tmx = px * 100;
        st.tmy = py * 100;
      });
      st.wrap.addEventListener("pointerenter", function () { st.tg = 1; st.ts = 1.045; st.tlift = 1; });
      st.wrap.addEventListener("pointerleave", function () {
        st.tg = 0; st.ts = 1; st.tlift = 0; st.trx = 0; st.try_ = 0; st.tmx = 50; st.tmy = 50;
      });
    });

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
        st.glow.style.opacity = st.g.toFixed(3);
        st.glow.style.backgroundPosition = st.mx.toFixed(1) + "% " + st.my.toFixed(1) + "%";
        st.sheen.style.opacity = (st.g * 0.9).toFixed(3);
        st.sheen.style.setProperty("--mx", st.mx.toFixed(1) + "%");
        st.sheen.style.setProperty("--my", st.my.toFixed(1) + "%");
      });
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
