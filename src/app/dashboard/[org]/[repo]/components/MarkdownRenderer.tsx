import React, { Suspense, useMemo, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "next-themes";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faClipboard } from "@fortawesome/free-solid-svg-icons";
import { toast } from "react-toastify";
import ReactMarkdown from "react-markdown";
import CodeModal from "./CodeModal";

interface CodeBlockProps {
  inline?: boolean;
  className?: string;
  children: string[]; // Ensure children is of type string[]
}

interface MarkdownRendererProps {
  className?: string;
  children: string | string[]; // Update the type of children
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  className,
  children,
}) => {
  const { resolvedTheme } = useTheme();
  const [modalFilePath, setModalFilePath] = useState<string | null>(null);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const CodeBlock = useMemo(() => {
    // eslint-disable-next-line react/display-name
    return ({ inline, className, children, ...props }: CodeBlockProps) => {
      const match = /language-(\w+)/.exec(className ?? "");

      if (!inline && match) {
        return (
          <div className="relative w-full max-w-full overflow-hidden">
            <button
              className="absolute right-2 top-2 z-10 rounded bg-gray-300 px-2 py-1 text-blueGray-50 hover:bg-gray-400 dark:bg-gray-700/80 dark:text-white dark:hover:bg-gray-600/80"
              onClick={() => copyToClipboard(String(children))}
            >
              <FontAwesomeIcon icon={faClipboard} />
            </button>
            <Suspense fallback={<div>Loading...</div>}>
              <SyntaxHighlighter
                style={resolvedTheme === "dark" ? oneDark : oneLight}
                language={match[1]}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  padding: "1rem 2.5rem 1rem 1rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  overflowWrap: "break-word",
                  maxWidth: "100%",
                }}
                wrapLines
                wrapLongLines
                {...props}
              >
                {children}
              </SyntaxHighlighter>
            </Suspense>
          </div>
        );
      } else if (inline) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      } else {
        const pathCheck = Array.isArray(children) ? "" : children;

        const isCodeFile =
          pathCheck?.startsWith("/") &&
          /\.(js|ts|jsx|tsx|py|rb|go|java|cpp|h|cs|php|swift|kt|rs|scala|elm|hs|lua|r|m|f|sql)$/i.test(
            pathCheck,
          );

        if (isCodeFile) {
          return (
            <code
              {...props}
              onClick={(e) => {
                e.preventDefault();
                setModalFilePath(pathCheck);
              }}
              className={`cursor-pointer  text-aurora-800/80 no-underline hover:text-aurora-800/80 hover:underline${className}`}
            >
              {children}
            </code>
          );
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
    };
  }, [resolvedTheme]);

  return (
    <>
      <ReactMarkdown
        className={className}
        components={{
          code: CodeBlock as any,
        }}
      >
        {Array.isArray(children) ? children.join("") : children ?? ""}
      </ReactMarkdown>
      {modalFilePath && (
        <CodeModal
          filePath={modalFilePath}
          isOpen={!!modalFilePath}
          onClose={() => setModalFilePath(null)}
        />
      )}
    </>
  );
};

export default React.memo(MarkdownRenderer);
