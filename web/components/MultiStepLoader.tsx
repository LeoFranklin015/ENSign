"use client";

export type Step = {
  id: string;
  label: string;
  description: string;
};

export function MultiStepLoader({
  steps,
  currentId,
  done,
  error,
}: {
  steps: Step[];
  currentId: string | null; // null when idle
  done: boolean;
  error: string | null;
}) {
  return (
    <div className="loader">
      {steps.map((step, i) => {
        const idx = steps.findIndex((s) => s.id === step.id);
        const currentIdx = currentId ? steps.findIndex((s) => s.id === currentId) : -1;
        const state =
          done && idx <= steps.length - 1
            ? "done"
            : currentIdx === idx
              ? error
                ? "error"
                : "active"
              : currentIdx > idx
                ? "done"
                : "idle";

        return (
          <div key={step.id} className={`loader-step loader-step--${state}`}>
            <div className="loader-mark" aria-hidden="true">
              {state === "done"
                ? "✓"
                : state === "error"
                  ? "!"
                  : state === "active"
                    ? <span className="loader-spin" />
                    : String(i + 1).padStart(2, "0")}
            </div>
            <div className="loader-body">
              <div className="loader-label">{step.label}</div>
              <div className="loader-description">{step.description}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
