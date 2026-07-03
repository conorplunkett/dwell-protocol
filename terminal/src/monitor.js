import { locateClaudeCliTranscript, readTranscriptActivity } from "./transcript.js";
import { readState, updateState } from "./state.js";

export function startSessionMonitor({
  statePath,
  home,
  backend,
  device,
  ad,
  intervalMs = 1000,
  viewThresholdMs = 5000,
  heartbeatFreshMs = 4000,
  transcriptFreshMs = 4000,
} = {}) {
  // Server-authoritative billing: serve a single-use token at the START of an
  // active segment, then redeem it once the qualifying view (viewThresholdMs)
  // has elapsed BETWEEN serve and redeem — which is exactly the on-screen dwell
  // the server's min-dwell wants. One bill per active segment. A segment shorter
  // than the threshold serves a token that's simply left to expire (no bill).
  let served = null;    // { token, at } minted for the current active segment
  let redeemed = false; // one redeem per active segment
  let busy = false;     // guard against overlapping serve/redeem calls
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const state = readState(statePath);
    if (!state) return;
    const heartbeatFresh = state.lastHeartbeatMs
      && (now - state.lastHeartbeatMs) <= heartbeatFreshMs;
    const transcriptPath = state.transcriptPath || locateClaudeCliTranscript(home);
    const activity = transcriptPath ? readTranscriptActivity(transcriptPath, now) : null;
    const active = !!heartbeatFresh && !!activity
      && activity.active && activity.ageMs <= transcriptFreshMs;

    updateState(statePath, (next) => {
      next.active = active;
      next.transcriptPath = transcriptPath || next.transcriptPath || "";
      if (active) {
        next.lastActiveMs = now;
        if (!next.activeStartedAt) next.activeStartedAt = now;
      } else {
        next.activeStartedAt = null;
      }
      return next;
    });

    // Inactivity ends the segment: drop any unredeemed token and re-arm.
    if (!active) {
      served = null;
      redeemed = false;
      return;
    }
    if (busy || redeemed) return;
    busy = true;
    try {
      if (!served) {
        // Serve at the segment start; the dwell accrues until we redeem below.
        const token = await backend.serveImpression(device);
        if (token) served = { token, at: Date.now() };
      } else if (now - served.at >= viewThresholdMs) {
        // The qualifying view elapsed between serve and now → bill it once.
        const token = served.token;
        try {
          await backend.redeemImpression(device, token);
          redeemed = true;
          updateState(statePath, (next) => {
            next.impression = { sent: true, token, sentAt: Date.now() };
            return next;
          });
        } catch {
          updateState(statePath, (next) => {
            next.impression = { sent: false, token: "", sentAt: 0 };
            return next;
          });
        }
      }
    } catch {
      // serve failed (network / cap) — leave served null and retry next tick.
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  try { timer.unref?.(); } catch { /* ignore */ }
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
