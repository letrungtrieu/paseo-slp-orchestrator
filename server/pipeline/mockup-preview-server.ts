// Loopback static server for `.slp/mockup`: the preview iframe loads files by URL instead of receiving one huge inlined HTML string.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { DESIGN_ROOT, MOCKUP_ROOT } from "../../shared/board";
import { MIME_TYPE_BY_EXTENSION } from "./mockup-asset-resolver";
import { buildMockupInspectorBridgeScript } from "./mockup-inspector-bridge";

// Text types the asset resolver does not need to inline, but a page loaded by URL does.
const PAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ...MIME_TYPE_BY_EXTENSION,
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

interface PreviewRoot {
  mockupRootDirectory: string;
  repoRootDirectory: string;
}

// One token per repository keeps URLs stable across reloads, so the browser can reuse its cache for unchanged assets.
const previewRootByToken = new Map<string, PreviewRoot>();
const tokenByMockupRoot = new Map<string, string>();
let runningServer: Promise<{ server: Server; port: number }> | null = null;

function sendPlainStatus(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

// Why: `.design/assets` or `.slp/mockup/assets` often symlinks into repository asset folders (such as `../Assets/_Project/Resources`),
// so resolved targets are valid when they stay inside either the mockup root or the owning repository root.
function isRealPathInsideAllowedDirectory(
  resolvedFilePath: string,
  allowedRootDirectory: string,
): boolean {
  return (
    resolvedFilePath === allowedRootDirectory ||
    resolvedFilePath.startsWith(`${allowedRootDirectory}${sep}`)
  );
}

// Resolves a URL path to a real file inside the mockup or repository root; symlinks are followed first so they cannot escape the repo.
async function resolveFileInsideRoot(
  previewRoot: PreviewRoot,
  requestedRelativePath: string,
): Promise<string | null> {
  let decodedRelativePath: string;
  try {
    decodedRelativePath = decodeURIComponent(requestedRelativePath);
  } catch {
    return null;
  }
  const normalizedRelativePath = decodedRelativePath.replace(/^\/+/, "");
  const candidateLogicalPaths = [
    resolve(previewRoot.mockupRootDirectory, normalizedRelativePath),
    resolve(previewRoot.repoRootDirectory, normalizedRelativePath),
  ];

  const realMockupRootDirectory = await realpath(previewRoot.mockupRootDirectory).catch(() => null);
  const realRepoRootDirectory = await realpath(previewRoot.repoRootDirectory).catch(() => null);
  if (!realMockupRootDirectory || !realRepoRootDirectory) {
    return null;
  }

  for (const candidateLogicalPath of candidateLogicalPaths) {
    try {
      const realCandidateFilePath = await realpath(candidateLogicalPath);
      const staysInsideAuthorizedRoot =
        isRealPathInsideAllowedDirectory(realCandidateFilePath, realMockupRootDirectory) ||
        isRealPathInsideAllowedDirectory(realCandidateFilePath, realRepoRootDirectory);
      if (!staysInsideAuthorizedRoot) {
        continue;
      }
      const candidateFileStats = await stat(realCandidateFilePath);
      if (candidateFileStats.isFile()) {
        return realCandidateFilePath;
      }
    } catch {
      // Why: missing candidate in `mockupRootDirectory` is expected when falling back to `repoRootDirectory`.
    }
  }
  return null;
}

// The entry page gets the element-picker and Canvas sprite bridge early in <head> so synchronous <canvas> scripts are hooked.
async function sendEntryHtml(response: ServerResponse, absoluteHtmlPath: string): Promise<void> {
  const rawHtml = await readFile(absoluteHtmlPath, "utf8");
  const inspectorBridgeScript = buildMockupInspectorBridgeScript({ assetUris: [], assetIndexByKey: {} });
  const htmlWithInspector = /<\/head>/i.test(rawHtml)
    ? rawHtml.replace(/<\/head>/i, () => `${inspectorBridgeScript}\n</head>`)
    : /<\/body>/i.test(rawHtml)
      ? rawHtml.replace(/<\/body>/i, () => `${inspectorBridgeScript}\n</body>`)
      : `${inspectorBridgeScript}\n${rawHtml}`;
  response.writeHead(200, {
    "Content-Type": PAGE_MIME_TYPE_BY_EXTENSION[".html"],
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(htmlWithInspector);
}

async function handlePreviewRequest(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
  // Rejecting foreign Host headers blocks DNS-rebinding pages from reading mockups through a hostname they control.
  if (request.headers.host !== `127.0.0.1:${port}`) {
    sendPlainStatus(response, 403, "Forbidden");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendPlainStatus(response, 405, "Method Not Allowed");
    return;
  }
  const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const [, requestToken = "", ...pathSegments] = requestPath.split("/");
  const previewRoot = previewRootByToken.get(requestToken);
  if (!previewRoot) {
    sendPlainStatus(response, 404, "Unknown preview");
    return;
  }
  const absoluteFilePath = await resolveFileInsideRoot(previewRoot, pathSegments.join("/"));
  if (!absoluteFilePath) {
    sendPlainStatus(response, 404, "Not found");
    return;
  }
  const fileExtension = extname(absoluteFilePath).toLowerCase();
  if (fileExtension === ".html") {
    await sendEntryHtml(response, absoluteFilePath);
    return;
  }
  // `*` is required: the iframe is sandboxed without same-origin, so fonts and module scripts are cross-origin fetches.
  response.writeHead(200, {
    "Content-Type": PAGE_MIME_TYPE_BY_EXTENSION[fileExtension] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(absoluteFilePath).pipe(response);
}

function ensurePreviewServer(): Promise<{ server: Server; port: number }> {
  runningServer ??= new Promise((resolveServer, rejectServer) => {
    const previewServer = createServer((request, response) => {
      const port = (previewServer.address() as AddressInfo).port;
      handlePreviewRequest(request, response, port).catch(() => {
        if (!response.headersSent) sendPlainStatus(response, 500, "Preview error");
        else response.destroy();
      });
    });
    previewServer.on("error", (serverError) => {
      runningServer = null;
      rejectServer(serverError);
    });
    // Port 0 lets the OS pick a free port; 127.0.0.1 keeps the mockups unreachable from the network.
    previewServer.listen(0, "127.0.0.1", () => {
      // unref so an idle preview server never keeps the daemon process alive.
      previewServer.unref();
      resolveServer({ server: previewServer, port: (previewServer.address() as AddressInfo).port });
    });
  });
  return runningServer;
}

// Returns the URL the iframe should load for a mockup entry file such as `.design/checkout.html` or `.slp/mockup/checkout.html`.
export async function getMockupPreviewUrl(repoPath: string, mockupFile: string): Promise<string> {
  const normalizedMockupFile = mockupFile.replace(/\\/g, "/");
  // Serve `.design/` files from the `.design` root and `.slp/mockup/` files from the `.slp/mockup` root.
  const activeDesignRoot = normalizedMockupFile.startsWith(`${DESIGN_ROOT}/`)
    ? DESIGN_ROOT
    : MOCKUP_ROOT;
  const repoRootDirectory = resolve(repoPath);
  const mockupRootDirectory = resolve(repoRootDirectory, activeDesignRoot);
  let previewToken = tokenByMockupRoot.get(mockupRootDirectory);
  if (!previewToken) {
    previewToken = randomBytes(24).toString("hex");
    tokenByMockupRoot.set(mockupRootDirectory, previewToken);
  }
  // Why: update the token entry on each call so `repoRootDirectory` stays accurate for symlinked asset resolution.
  previewRootByToken.set(previewToken, { mockupRootDirectory, repoRootDirectory });
  const { port } = await ensurePreviewServer();
  const entryPathInsideRoot = normalizedMockupFile.replace(`${activeDesignRoot}/`, "");
  const encodedEntryPath = entryPathInsideRoot.split("/").map(encodeURIComponent).join("/");
  return `http://127.0.0.1:${port}/${previewToken}/${encodedEntryPath}`;
}
