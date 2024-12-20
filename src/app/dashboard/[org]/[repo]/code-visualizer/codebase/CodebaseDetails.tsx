import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { type ContextItem } from "~/server/utils/codebaseContext";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faTimes,
  faInfoCircle,
  faChevronLeft,
  faChevronRight,
  faChevronDown,
  faCopy,
  faCheck,
  faComment,
  faPlus,
} from "@fortawesome/free-solid-svg-icons";
import Mermaid from "./Mermaid";
import Markdown, { type Components } from "react-markdown";
import gfm from "remark-gfm";
import path from "path";
import CodeSection from "./CodeSection";
import ImportsSection from "./ImportsSection";
import ExportsSection from "./ExportsSection";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/cjs/styles/prism";
import { faClipboard } from "@fortawesome/free-solid-svg-icons";
import { toast } from "react-toastify";
import { useRouter } from "next/navigation";

interface CodebaseDetailsProps {
  item: ContextItem;
  onClose: () => void;
  onToggleWidth: () => void;
  isExpanded?: boolean;
  allFiles: string[];
  onNodeClick: (path: string) => void;
  viewMode: "folder" | "taxonomy";
  theme: "light" | "dark";
  org: string;
  repo: string;
}

const copyToClipboard = async (text: string) => {
  await navigator.clipboard.writeText(text);
  toast.success("Copied to clipboard");
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-redundant-type-constituents
export const renderers: Partial<Components | any> = {
  code: ({
    inline,
    className,
    theme,
    children,
    ...props
  }: {
    inline: boolean;
    className: string;
    theme: "light" | "dark";
    children: React.ReactNode;
  }) => {
    const match = /language-(\w+)/.exec(className || "");
    if (!inline && match) {
      return (
        <div className="relative">
          <button
            className="absolute right-2 top-0 rounded bg-gray-800 p-1 text-white"
            onClick={() => copyToClipboard(String(children))}
          >
            <FontAwesomeIcon icon={faClipboard} />
          </button>
          <SyntaxHighlighter
            style={theme === "dark" ? oneDark : oneLight}
            language={match[1]}
            PreTag="div"
            {...props}
          >
            {String(children).replace(/\n$/, "")}
          </SyntaxHighlighter>
        </div>
      );
    } else if (inline) {
      // Render inline code with `<code>` instead of `<div>`
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    } else {
      // Fallback for non-highlighted code
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
  },
};

const CodebaseDetails: React.FC<CodebaseDetailsProps> = ({
  item,
  onClose,
  onToggleWidth,
  isExpanded = false,
  allFiles,
  onNodeClick,
  viewMode,
  theme,
  org,
  repo,
}) => {
  const [copyStatus, setCopyStatus] = useState(false);
  const router = useRouter();

  const handleCopy = () => {
    navigator.clipboard
      .writeText(JSON.stringify(item, null, 2))
      .then(() => {
        setCopyStatus(true);
        setTimeout(() => setCopyStatus(false), 2000);
      })
      .catch(() => {
        console.error("Failed to copy context item");
      });
  };

  const handleSendToChat = () => {
    if (item.file) {
      const encodedFilePath = encodeURIComponent(item.file);
      router.push(
        `/dashboard/${org}/${repo}/chat?file_path=${encodedFilePath}`,
      );
    } else {
      toast.error(
        "No file selected. Please select a file before sending to chat.",
      );
    }
  };

  const handleStartNewIssue = () => {
    if (item.file) {
      const encodedFilePath = encodeURIComponent(item.file);
      router.push(
        `/dashboard/${org}/${repo}/issue-writer?file_path=${encodedFilePath}`,
      );
    } else {
      toast.error(
        "No file selected. Please select a file before starting a new issue.",
      );
    }
  };

  return (
    <div className="details hide-scrollbar h-full overflow-scroll bg-white text-left text-sm text-gray-800 dark:bg-gray-900 dark:text-white">
      <div className="sticky top-0 z-10 flex h-12 items-center justify-between bg-gradient-to-r from-aurora-50 to-aurora-100/70 px-4 shadow-sm dark:from-gray-800 dark:to-gray-700">
        <div className="flex items-center space-x-3">
          <button
            onClick={onToggleWidth}
            className="text-aurora-500 transition-colors hover:text-aurora-600 dark:text-gray-400 dark:hover:text-white"
          >
            <FontAwesomeIcon
              icon={isExpanded ? faChevronRight : faChevronLeft}
              size="lg"
            />
          </button>
          <h2 className="truncate text-lg font-semibold text-gray-800 dark:text-blueGray-200">
            {path.basename(item.file)}
          </h2>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={handleCopy}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-white"
          >
            <FontAwesomeIcon icon={copyStatus ? faCheck : faCopy} size="lg" />
          </button>
          <button
            onClick={onClose}
            className=" text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-white"
          >
            <FontAwesomeIcon icon={faTimes} size="lg" />
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-6 px-4">
        <p className="mb-3 text-gray-700 dark:text-gray-100">{item.overview}</p>
        {item.diagram && <Mermaid chart={item.diagram} theme={theme} />}
        <Section
          icon={faInfoCircle}
          title="Overview"
          iconColor="text-primary-500"
        >
          <Markdown
            remarkPlugins={[gfm]}
            className={`markdown-details text-gray-700 dark:text-neutral-200`}
            components={renderers}
          >
            {item.text}
          </Markdown>
        </Section>

        <ImportsSection
          importStatements={item.importStatements}
          importedFiles={item.importedFiles}
          allFiles={allFiles}
          onFileClick={onNodeClick}
          referencedImportDetails={item.referencedImportDetails ?? []}
          currentFile={item.file}
          viewMode={viewMode}
          theme={theme}
        />

        {item.exports?.length ? (
          <ExportsSection contextItem={item} theme={theme} />
        ) : null}

        {item?.code?.length ? (
          <CodeSection code={item.code} theme={theme} />
        ) : null}
      </div>

      <div className="sticky bottom-0 left-0 right-0 bg-white p-4 dark:bg-gray-900">
        <div className="flex space-x-2">
          <button
            onClick={handleStartNewIssue}
            className="flex w-full items-center justify-center rounded-lg bg-aurora-500 px-4 py-2 font-semibold text-white transition-colors hover:bg-aurora-600 dark:bg-aurora-800 dark:hover:bg-aurora-900"
          >
            <FontAwesomeIcon icon={faPlus} className="mr-2" />
            Start New Issue
          </button>
          <button
            onClick={handleSendToChat}
            className="flex w-full items-center justify-center rounded-lg bg-aurora-500 px-4 py-2 font-semibold text-white transition-colors hover:bg-aurora-600 dark:bg-aurora-800 dark:hover:bg-aurora-900"
          >
            <FontAwesomeIcon icon={faComment} className="mr-2" />
            Update with Chat
          </button>
        </div>
      </div>
    </div>
  );
};

export const Section: React.FC<{
  icon: any;
  title: string;
  iconColor: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}> = ({ icon, title, iconColor, children, defaultExpanded = false }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="mb-4 whitespace-pre-wrap"
    >
      <h3
        className="mb-2 flex cursor-pointer items-center justify-between text-base font-semibold text-gray-800 dark:text-gray-200"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center">
          <FontAwesomeIcon icon={icon} className={`mr-2 ${iconColor}`} />
          {title}
        </div>
        <FontAwesomeIcon
          icon={isExpanded ? faChevronDown : faChevronRight}
          className="text-gray-500 dark:text-gray-400"
        />
      </h3>
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
};

export default CodebaseDetails;
