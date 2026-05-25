import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { RecordingLanguage } from "@/shared/recording-schema";

export type CodeEditorHandle = {
  /** Lazy accessor — null until the editor has mounted. */
  getEditor(): Monaco.editor.IStandaloneCodeEditor | null;
};

export type CodeEditorProps = {
  language: RecordingLanguage;
  initialValue: string;
  fontSize: number;
  theme: "light" | "dark";
  onMount?(editor: Monaco.editor.IStandaloneCodeEditor): void;
};

type MonacoModule = typeof Monaco;
type MonacoTheme = "code-tape-light" | "code-tape-dark";
type WorkerConstructor = new () => Worker;
type WorkerConstructors = {
  editor: WorkerConstructor;
  typescript: WorkerConstructor;
};
type MonacoEnvironmentHost = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
};

let workerPromise: Promise<WorkerConstructors> | null = null;
let monacoPromise: Promise<MonacoModule> | null = null;
let themesDefined = false;

function monacoTheme(theme: CodeEditorProps["theme"]): MonacoTheme {
  return theme === "dark" ? "code-tape-dark" : "code-tape-light";
}

function loadWorkers() {
  workerPromise ??= Promise.all([
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
  ]).then(([editorWorker, tsWorker]) => ({
    editor: editorWorker.default,
    typescript: tsWorker.default,
  }));
  return workerPromise;
}

function configureWorkers(workers: WorkerConstructors) {
  (globalThis as MonacoEnvironmentHost).MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === "javascript" || label === "typescript") {
        return new workers.typescript();
      }
      return new workers.editor();
    },
  };
}

function defineThemes(monaco: MonacoModule) {
  if (themesDefined) return;
  monaco.editor.defineTheme("code-tape-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#f5f5f4",
      "editor.foreground": "#24272d",
      "editorLineNumber.foreground": "#7b808a",
      "editorLineNumber.activeForeground": "#2f66c9",
      "editorCursor.foreground": "#2f66c9",
      "editor.selectionBackground": "#b8d6ff",
      "editor.inactiveSelectionBackground": "#d7e6fb",
      "editor.lineHighlightBackground": "#ffffff",
      "editorGutter.background": "#f5f5f4",
    },
  });
  monaco.editor.defineTheme("code-tape-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#252931",
      "editor.foreground": "#e8eaee",
      "editorLineNumber.foreground": "#9ba2ad",
      "editorLineNumber.activeForeground": "#8fc4ff",
      "editorCursor.foreground": "#8fc4ff",
      "editor.selectionBackground": "#284b74",
      "editor.inactiveSelectionBackground": "#334153",
      "editor.lineHighlightBackground": "#2d323b",
      "editorGutter.background": "#252931",
    },
  });
  themesDefined = true;
}

async function loadMonaco() {
  const workers = await loadWorkers();
  configureWorkers(workers);
  monacoPromise ??= (async () => {
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
    await Promise.all([
      import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution"),
      import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution"),
      import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
    ]);
    defineThemes(monaco);
    return monaco;
  })();
  return monacoPromise;
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { language, initialValue, fontSize, theme, onMount },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const initialValueRef = useRef(initialValue);
  const latestPropsRef = useRef({ language, fontSize, theme });
  const onMountRef = useRef(onMount);

  latestPropsRef.current = { language, fontSize, theme };
  onMountRef.current = onMount;

  useImperativeHandle(ref, () => ({ getEditor: () => editorRef.current }), []);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;

    void loadMonaco()
      .then((monaco) => {
        if (cancelled) return;
        const currentProps = latestPropsRef.current;
        const model = monaco.editor.createModel(initialValueRef.current, currentProps.language);
        const editor = monaco.editor.create(host, {
          model,
          automaticLayout: true,
          fontSize: currentProps.fontSize,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          theme: monacoTheme(currentProps.theme),
        });

        monacoRef.current = monaco;
        modelRef.current = model;
        editorRef.current = editor;
        onMountRef.current?.(editor);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("Failed to initialize Monaco editor", error);
        }
      });

    return () => {
      cancelled = true;
      const editor = editorRef.current;
      const model = modelRef.current;
      editorRef.current = null;
      modelRef.current = null;
      monacoRef.current = null;
      editor?.dispose();
      model?.dispose();
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = modelRef.current;
    if (!monaco || !model) return;
    monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  useEffect(() => {
    monacoRef.current?.editor.setTheme(monacoTheme(theme));
  }, [theme]);

  return (
    <div
      ref={hostRef}
      aria-label="Code editor"
      className="relative h-full min-h-[320px] w-full bg-surface"
      data-code-editor
    />
  );
});
