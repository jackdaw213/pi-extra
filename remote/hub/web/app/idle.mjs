// Idle sign-out controller — merciful and cheap by design: ONE repeating
// check (default every 10 s) compares a last-activity timestamp against
// `idleMs`; activities only move the timestamp, never touch timers. When the
// check finds the quiet period long enough, onExpire fires once. Scheduling
// and the clock are injectable so tests can drive both.
export function createIdleController({
  idleMs,
  onExpire,
  intervalMs = 10_000,
  schedule = (fn, ms) => setInterval(fn, ms),
  cancel = (t) => clearInterval(t),
  now = () => Date.now(),
}) {
  let last = now();
  let timer = null;
  let stopped = false;
  let expired = false;

  const check = () => {
    if (stopped || expired) return;
    if (now() - last >= idleMs) {
      expired = true;
      onExpire();
    }
  };

  return {
    start() {
      if (timer !== null) return;
      timer = schedule(check, intervalMs);
    },
    // User activity: only moves the timestamp (and re-arms after an expiry,
    // e.g. when the phone signs in again without a new controller).
    activity() {
      last = now();
      expired = false;
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
  };
}
