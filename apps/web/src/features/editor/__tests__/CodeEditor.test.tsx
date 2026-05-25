import { act, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeEditorHandle } from "../CodeEditor";

const monacoMock = vi.hoisted(() => {
  class MockEditorWorker {}
  class MockTsWorker {}

  class MockModel {
    disposed = false;

    constructor(
      public value: string,
      public language: string,
    ) {}

    getValue() {
      return this.value;
    }

    dispose() {
      this.disposed = true;
    }
  }

  class MockEditor {
    disposed = false;
    updateOptions = vi.fn((nextOptions: Record<string, unknown>) => {
      Object.assign(this.options, nextOptions);
    });

    constructor(
      public host: HTMLElement,
      public options: Record<string, unknown> & { model: MockModel },
    ) {}

    getValue() {
      return this.options.model.getValue();
    }

    dispose() {
      this.disposed = true;
    }
  }

  const models: MockModel[] = [];
  const editors: MockEditor[] = [];
  const createModel = vi.fn((value: string, language: string) => {
    const model = new MockModel(value, language);
    models.push(model);
    return model;
  });
  const create = vi.fn((host: HTMLElement, options: Record<string, unknown> & { model: MockModel }) => {
    const editor = new MockEditor(host, options);
    editors.push(editor);
    return editor;
  });
  const defineTheme = vi.fn();
  const setTheme = vi.fn();
  const setModelLanguage = vi.fn((model: MockModel, language: string) => {
    model.language = language;
  });

  return {
    MockEditorWorker,
    MockTsWorker,
    models,
    editors,
    editor: {
      create,
      createModel,
      defineTheme,
      setTheme,
      setModelLanguage,
    },
  };
});

vi.mock("monaco-editor/esm/vs/editor/editor.api", () => ({ editor: monacoMock.editor }));
vi.mock("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/language/typescript/monaco.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: monacoMock.MockEditorWorker,
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: monacoMock.MockTsWorker,
}));

describe("CodeEditor", () => {
  beforeEach(() => {
    monacoMock.models.length = 0;
    monacoMock.editors.length = 0;
    monacoMock.editor.create.mockClear();
    monacoMock.editor.createModel.mockClear();
    monacoMock.editor.defineTheme.mockClear();
    monacoMock.editor.setTheme.mockClear();
    monacoMock.editor.setModelLanguage.mockClear();
    delete (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lazy-loads Monaco, creates the editor with initial props, and exposes it", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const ref = createRef<CodeEditorHandle>();
    const onMount = vi.fn();

    render(
      <CodeEditor
        ref={ref}
        language="javascript"
        initialValue="const answer = 42;"
        fontSize={16}
        theme="dark"
        onMount={onMount}
      />,
    );

    expect(monacoMock.editor.create).not.toHaveBeenCalled();
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    expect(monacoMock.editor.createModel).toHaveBeenCalledWith("const answer = 42;", "javascript");
    expect(monacoMock.editors[0].options).toEqual(
      expect.objectContaining({
        automaticLayout: true,
        fontSize: 16,
        model: monacoMock.models[0],
        theme: "code-tape-dark",
      }),
    );
    expect(ref.current?.getEditor()).toBe(monacoMock.editors[0]);
    expect(onMount).toHaveBeenCalledWith(monacoMock.editors[0]);
  });

  it("updates language, font size, and theme without rewriting initialValue", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { rerender } = render(
      <CodeEditor language="javascript" initialValue="const first = true;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const model = monacoMock.models[0];
    const editor = monacoMock.editors[0];
    model.value = "const userTyped = true;";

    await act(async () => {
      rerender(
        <CodeEditor
          language="typescript"
          initialValue="const overwritten = true;"
          fontSize={18}
          theme="light"
        />,
      );
    });

    expect(model.getValue()).toBe("const userTyped = true;");
    expect(monacoMock.editor.setModelLanguage).toHaveBeenCalledWith(model, "typescript");
    expect(editor.updateOptions).toHaveBeenCalledWith({ fontSize: 18 });
    expect(monacoMock.editor.setTheme).toHaveBeenCalledWith("code-tape-light");
  });

  it("configures JS/TS workers and disposes editor resources on unmount", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { unmount } = render(
      <CodeEditor language="typescript" initialValue="let value: number = 1;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    const environment = (globalThis as {
      MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
    }).MonacoEnvironment;
    expect(environment?.getWorker("", "javascript")).toBeInstanceOf(monacoMock.MockTsWorker);
    expect(environment?.getWorker("", "typescript")).toBeInstanceOf(monacoMock.MockTsWorker);
    expect(environment?.getWorker("", "editorWorkerService")).toBeInstanceOf(
      monacoMock.MockEditorWorker,
    );

    unmount();

    expect(monacoMock.editors[0].disposed).toBe(true);
    expect(monacoMock.models[0].disposed).toBe(true);
  });
});
