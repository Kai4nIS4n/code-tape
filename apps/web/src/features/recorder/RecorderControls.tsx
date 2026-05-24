import type { RecordingControllerState } from "@/shared/recording-schema";
import { formatDurationMs } from "@/shared/time/duration";

export type RecorderControlsProps = {
  state: RecordingControllerState;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onToggleMicrophone(next: boolean): void;
  onToggleCamera(next: boolean): void;
  onRun(): void;
};

/**
 * RecorderControls — top bar with record / pause / stop / mic / cam / run.
 *
 * STUB. Real implementation belongs to issue
 * `[P0] RecorderPage 录制控制条 UI`.
 *
 * 实装要点：
 *   - 录制按钮使用 record token + animate-record-pulse；状态 recording 显示停止图标
 *   - 暂停按钮仅在 recording 状态启用，恢复按钮仅 paused 启用
 *   - 麦/相机 Toggle 用 shared/ui/Toggle，禁用条件由 props.state.mediaCapability 决定
 *   - 运行按钮在 recording / paused 都启用（暂停时按 ADR-022 锁定）
 *   - 持续时间用 font-mono 显示；红点 + 时间是「正在录制」最强烈的视觉信号
 *   - 错误状态把 lastError.message 渲染到 toast / status-bar
 */
export function RecorderControls({
  state,
  microphoneEnabled,
  cameraEnabled,
}: RecorderControlsProps) {
  return (
    <div className="flex h-12 items-center gap-3 border-b border-border bg-surface/80 px-4">
      <span
        aria-hidden
        className={[
          "inline-block h-2.5 w-2.5 rounded-full",
          state.status === "recording" ? "animate-record-pulse bg-record" : "bg-border",
        ].join(" ")}
      />
      <span className="font-mono text-sm text-foreground">{formatDurationMs(state.durationMs)}</span>
      <span className="text-xs uppercase tracking-wide text-muted">{state.status}</span>
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs text-muted"
        disabled
      >
        开始录制
      </button>
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs text-muted"
        disabled
      >
        运行代码
      </button>
      <span className="text-xs text-muted">
        麦克风 {microphoneEnabled ? "on" : "off"} · 摄像头 {cameraEnabled ? "on" : "off"}
      </span>
      <span className="flex-1" />
      <span className="text-xs text-muted">RecorderControls scaffold · 待 issue 实装</span>
    </div>
  );
}
