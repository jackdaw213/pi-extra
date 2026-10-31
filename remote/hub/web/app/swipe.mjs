// Swipe gesture state machine — pure, Node-import-safe (no DOM at module
// level). Touch/drag event data in (phase + pointer coordinates + timestamp),
// reveal/delete state out. The dashboard applies the state to a session card.
//
// Semantics (all thresholds exported so tests pin them):
//   - TAP_SLOP_PX (10): movement within the slop is a tap, not a swipe.
//   - Axis lock: the first movement past the slop locks the axis. Vertical
//     (y) means the gesture belongs to scrolling — the machine reports axis
//     "y" and never opens; the card CSS uses touch-action: pan-y so vertical
//     panning stays native (pointercancel cleans up).
//   - Horizontal (x): the card follows the finger, translation clamped to
//     [-REVEAL_MAX_PX, 0] where REVEAL_MAX_PX = 1.7 * REVEAL_WIDTH_PX.
//   - Release (end):
//       full swipe  — |travel| > FULL_SWIPE_RATIO * REVEAL_WIDTH_PX
//       flick       — leftward velocity beyond FLICK_VELOCITY_PX_PER_MS px/ms
//     both fire action "delete" (delete without tapping the button);
//     otherwise travel past -REVEAL_WIDTH_PX/2 snaps open, else closed.
//   - start accepts offset (the card's translation when grabbed, 0 or
//     -REVEAL_WIDTH_PX) so dragging an already-open row works: thresholds
//     apply to offset + pointer travel.

export const TAP_SLOP_PX = 10; // movements <= this are a tap, not a swipe
export const REVEAL_WIDTH_PX = 72; // how far the card translates to reveal Delete
export const FULL_SWIPE_RATIO = 1.6; // |travel| > ratio * reveal => delete
export const FLICK_VELOCITY_PX_PER_MS = 0.6; // leftward px/ms => delete
export const REVEAL_MAX_PX = REVEAL_WIDTH_PX * 1.7; // drag clamp: past the full-swipe point so the card keeps following the finger

const CLOSED = Object.freeze({ reveal: "closed", px: 0, tap: false, axis: null, action: null });

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function createSwipeMachine() {
  let st = {
    ...CLOSED,
    startX: 0,
    startY: 0,
    tracking: false,
    offset: 0,
    travel: 0, // raw pointer travel along x (unclamped)
    lastX: 0,
    lastT: 0,
    vel: 0, // px/ms, negative = leftward
  };

  function view(s) {
    return { reveal: s.reveal, px: s.px, tap: s.tap, axis: s.axis, action: s.action };
  }

  function update(ev) {
    const phase = ev && ev.phase;

    if (phase === "start") {
      st = {
        ...CLOSED,
        startX: Number(ev.x) || 0,
        startY: Number(ev.y) || 0,
        lastX: Number(ev.x) || 0,
        lastT: Number(ev.t) || 0,
        offset: Number(ev.offset) || 0,
        tracking: true,
      };
      return view(st);
    }

    if (!st.tracking) return view(st);

    if (phase === "move") {
      const x = Number(ev.x) || 0;
      const y = Number(ev.y) || 0;
      const t = Number(ev.t) || 0;
      const dx = x - st.startX;
      const dy = y - st.startY;
      // Lock the gesture axis once movement exceeds the tap slop.
      if (st.axis === null && (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX)) {
        st.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      }
      if (st.axis === "x") {
        st.travel = dx;
        st.px = clamp(st.offset + dx, -REVEAL_MAX_PX, 0);
        st.reveal = "opening";
      }
      if (t > st.lastT) {
        st.vel = (x - st.lastX) / (t - st.lastT);
        st.lastX = x;
        st.lastT = t;
      }
      return view(st);
    }

    if (phase === "end") {
      st.tracking = false;
      const travel = ev && ev.x != null ? (Number(ev.x) || 0) - st.startX : st.travel;
      const t = Number(ev && ev.t) || 0;
      if (t > st.lastT) {
        const x = Number(ev && ev.x) || st.lastX;
        st.vel = (x - st.lastX) / (t - st.lastT);
      }
      st.tap = st.axis === null; // never left the tap slop in either axis
      if (st.axis !== "x") {
        st.reveal = "closed";
        st.px = 0;
        return view(st);
      }
      const effective = st.offset + travel;
      if (
        Math.abs(effective) > FULL_SWIPE_RATIO * REVEAL_WIDTH_PX ||
        st.vel < -FLICK_VELOCITY_PX_PER_MS
      ) {
        // Full swipe or fast leftward flick: delete at once.
        st.action = "delete";
        st.reveal = "closed";
        st.px = 0;
      } else if (effective < -REVEAL_WIDTH_PX / 2) {
        st.reveal = "open";
        st.px = -REVEAL_WIDTH_PX;
      } else {
        st.reveal = "closed";
        st.px = 0;
      }
      return view(st);
    }

    if (phase === "cancel") {
      st = { ...CLOSED };
      return view(st);
    }

    return view(st);
  }

  return {
    get state() {
      return view(st);
    },
    update,
  };
}
