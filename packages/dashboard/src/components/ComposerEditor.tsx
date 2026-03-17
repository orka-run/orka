import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  type EditorState,
} from "lexical";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

export interface ComposerEditorHandle {
  focus: () => void;
  focusAtEnd: () => void;
  clear: () => void;
  getText: () => string;
}

interface ComposerEditorProps {
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  initialText?: string;
  onChange?: (text: string) => void;
  onSubmit?: () => void;
}

function $setEditorText(text: string): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length > 0) {
      paragraph.append($createTextNode(line));
    }
    if (i < lines.length - 1) {
      paragraph.append($createLineBreakNode());
    }
  }
}

function KeyCommandsPlugin({ onSubmit }: { onSubmit?: () => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event) return false;
        // Shift+Enter = newline (let default happen)
        if (event.shiftKey) return false;
        // Enter or Ctrl/Cmd+Enter = submit
        event.preventDefault();
        onSubmit?.();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        editor.getRootElement()?.blur();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterEnter();
      unregisterEscape();
    };
  }, [editor, onSubmit]);

  return null;
}

function EditorInner({
  disabled,
  placeholder,
  autoFocus,
  className,
  initialText,
  onChange,
  onSubmit,
  editorRef,
}: ComposerEditorProps & { editorRef: React.Ref<ComposerEditorHandle> }) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (autoFocus) {
      editor.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync initialText changes into editor (for restoring drafts)
  const lastSyncedText = useRef(initialText ?? "");
  useEffect(() => {
    if (initialText === undefined) return;
    if (initialText === lastSyncedText.current) return;
    lastSyncedText.current = initialText;
    editor.update(() => {
      $setEditorText(initialText);
    });
  }, [initialText, editor]);

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => editor.focus(),
      focusAtEnd: () => {
        const rootElement = editor.getRootElement();
        if (!rootElement) return;
        rootElement.focus();
        editor.update(() => {
          const root = $getRoot();
          const lastChild = root.getLastDescendant();
          if (lastChild) {
            const selection = root.selectEnd();
            if (selection) return;
          }
          root.selectEnd();
        });
      },
      clear: () => {
        editor.update(() => {
          $setEditorText("");
        });
        lastSyncedText.current = "";
      },
      getText: () => {
        let text = "";
        editor.getEditorState().read(() => {
          text = $getRoot().getTextContent();
        });
        return text;
      },
    }),
    [editor],
  );

  const handleChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const text = $getRoot().getTextContent();
      lastSyncedText.current = text;
      onChangeRef.current?.(text);
    });
  }, []);

  return (
    <div className="relative flex-1">
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className={`block w-full bg-transparent py-1.5 px-2 text-sm text-ink outline-none ${className ?? ""}`}
            aria-label="Chat message"
            aria-placeholder={placeholder}
            placeholder={<span />}
          />
        }
        placeholder={
          <div className="pointer-events-none absolute inset-0 px-2 py-1.5 text-sm text-ink-muted">
            {placeholder}
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin onChange={handleChange} />
      <KeyCommandsPlugin onSubmit={onSubmit} />
      <HistoryPlugin />
    </div>
  );
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(props, ref) {
    const initialConfig = useMemo<InitialConfigType>(
      () => ({
        namespace: "orka-composer",
        editable: !props.disabled,
        theme: { paragraph: "m-0" },
        nodes: [],
        editorState: () => {
          if (props.initialText) {
            $setEditorText(props.initialText);
          }
        },
        onError: (error) => {
          console.error("ComposerEditor error:", error);
        },
      }),
      [], // eslint-disable-line react-hooks/exhaustive-deps
    );

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <EditorInner {...props} editorRef={ref} />
      </LexicalComposer>
    );
  },
);
