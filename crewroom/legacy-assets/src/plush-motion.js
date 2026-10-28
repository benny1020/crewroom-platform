const phases = new Set([
  "ready",
  "coding",
  "investigating",
  "testing",
  "review",
  "celebrating",
  "question",
  "writing",
  "queued",
  "planning",
  "paused",
  "blocked",
]);
const attr = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Stable identity excludes changing counters/timestamps, but never crosses a task,
// run, result, status or chosen character. No task text is copied into the key.
export function motionAttributes({
  surface,
  agentId,
  character,
  task,
  phase,
  artifactId,
}) {
  const safePhase = phases.has(phase) ? phase : "ready",
    key = JSON.stringify([
      surface,
      agentId,
      character,
      task?.id,
      task?.current_run_id || task?.runId,
      task?.status,
      artifactId,
      safePhase,
    ]),
    offset = [...String(agentId)].reduce(
      (sum, c) => (sum * 31 + c.charCodeAt(0)) % 1400,
      0,
    );
  return `data-plush-key="${attr(key)}" data-plush-phase="${safePhase}" style="--g-motion-offset:-${offset}ms"`;
}

export function plushEffects() {
  return '<span class="g-plush-effects" aria-hidden="true"><i></i><i></i><i></i></span>';
}

// Full HTML refreshes must not restart a completed celebration or reset a loop.
// Keep only the current render's scenes; detached pages never accumulate in a cache.
export function rememberPlushMotion(root) {
  const previous = new Map(
    [...root.querySelectorAll("[data-plush-key]")].map((node) => [
      node.dataset.plushKey,
      {
        node,
        timelines: node.getAnimations({ subtree: true }).map((animation) => ({
          target: animation.effect?.target,
          name: animation.animationName,
          time: animation.currentTime,
        })),
      },
    ]),
  );
  return () => {
    for (const next of root.querySelectorAll("[data-plush-key]")) {
      const old = previous.get(next.dataset.plushKey);
      if (!old || old.node === next) continue;
      previous.delete(next.dataset.plushKey);
      next.replaceWith(old.node);
      for (const { target, name, time } of old.timelines) {
        if (!target || !name || time === null) continue;
        const animation = target
          .getAnimations()
          .find((a) => a.animationName === name);
        if (animation) animation.currentTime = time;
      }
    }
  };
}

export function bindPlushVisibility(root) {
  const sync = () => root.classList.toggle("g-plush-sleeping", document.hidden);
  document.addEventListener("visibilitychange", sync);
  sync();
}
