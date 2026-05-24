import { forwardRef, useImperativeHandle, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import type { RecordingLanguage } from "@/shared/recording-schema";

export type CodeEditorHandle = {
  /** Lazy accessor — null until the editor has mounted. */
  getEditor(): MonacoEditor.IStandaloneCodeEditor | null;
};

export type CodeEditorProps = {
  language: RecordingLanguage;
  initialValue: string;
  fontSize: number;
  theme: "light" | "dark";
  onMount?(editor: MonacoEditor.IStandaloneCodeEditor): void;
};

/**
 * CodeEditor — Monaco editor host + theme bridge.
 *
 * STUB. Real implementation belongs to issue `[P0] CodeEditor 组件接入 Monaco`.
 *
 * 实装要点：
 *   - 用 monaco-editor 直接 import（不用 @monaco-editor/react，保持依赖最小）
 *   - 在 effect 内 monaco.editor.create(host, { value, language, fontSize, theme })
 *   - props.language / fontSize / theme 改变 → 调对应 setter
 *   - props.initialValue 仅首次写入，后续禁止覆盖（避免回放外部 setValue 触发循环）
 *   - onMount 回调暴露 editor 实例给 EditorProducer.getEditor()
 *   - 暗主题用 "vs-dark"，浅主题用 "vs"；并通过 monaco.editor.defineTheme 注册
 *     一个与 tokens.css 对齐的自定义主题（issue 内细化）
 *   - cleanup 时 editor.dispose()
 */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  _props,
  ref,
) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  useImperativeHandle(ref, () => ({ getEditor: () => editorRef.current }), []);
  return (
    <div className="relative h-full w-full bg-surface">
      <div className="flex h-full items-center justify-center text-sm text-muted">
        <span className="font-mono">
          CodeEditor scaffold · 待 issue「[P0] CodeEditor 组件接入 Monaco」实装
        </span>
      </div>
    </div>
  );
});
