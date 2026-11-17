import { useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { useAppearance } from "./appearance";
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
loader.config({ monaco });
// Match the app's own surfaces instead of Monaco's stock grey (#1e1e1e).
monaco.editor.defineTheme("workspace-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0d1015",
    "editor.lineHighlightBackground": "#151a22",
    "editor.lineHighlightBorder": "#151a2200",
    "editorLineNumber.foreground": "#5d6779",
    "editorLineNumber.activeForeground": "#a9b2c3",
    "editorGutter.background": "#0d1015",
    "editor.selectionBackground": "#8b9dff40",
    "editorCursor.foreground": "#8b9dff",
    "editorWidget.background": "#13171f",
    "editorWidget.border": "#303a4a",
    "scrollbarSlider.background": "#303a4a80",
    "scrollbarSlider.hoverBackground": "#3b4659",
  },
});
monaco.editor.defineTheme("workspace-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.lineHighlightBackground": "#f0f3f8",
    "editor.lineHighlightBorder": "#f0f3f800",
    "editorLineNumber.foreground": "#7a889f",
    "editorLineNumber.activeForeground": "#1d2737",
    "editor.selectionBackground": "#4054bd30",
    "editorCursor.foreground": "#4054bd",
  },
});
export default function CodeEditor({
  content,
  path,
  readOnly,
  onChange,
  onSave,
}: {
  content: string;
  path: string;
  readOnly: boolean;
  onChange: (v: string) => void;
  onSave?: () => void;
}) {
  const { resolved } = useAppearance();
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const extension = path.split(".").pop();
  const language =
    extension === "diff"
      ? "diff"
      : ["ts", "tsx"].includes(extension || "")
        ? "typescript"
        : ["js", "jsx"].includes(extension || "")
          ? "javascript"
          : extension === "json"
            ? "json"
            : extension === "md"
              ? "markdown"
              : extension === "css"
                ? "css"
                : "plaintext";
  return (
    <Editor
      onMount={(editor) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          saveRef.current?.(),
        );
      }}
      height="100%"
      theme={resolved === "light" ? "workspace-light" : "workspace-dark"}
      language={language}
      key={path + String(readOnly)}
      path={path}
      defaultValue={content}
      value={readOnly ? content : undefined}
      onChange={(v) => onChange(v || "")}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        padding: { top: 18 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}
