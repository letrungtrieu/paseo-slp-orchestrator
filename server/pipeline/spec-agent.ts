// Spawns a standalone normal Paseo agent (outside any SLP Run) connected to the project's Kanban Spec board.
import { randomBytes, randomUUID } from "node:crypto";
import type { BoardTicket } from "../../shared/board";
import { BUS_SERVER_NAME } from "../../shared/roles";
import type { BusToolName } from "../bus/tool-schemas";
import { assertGitRepository } from "../git/git";
import { openSupervisorWorkspace } from "../git/worktree";
import {
  defaultFeatureValuesForProvider,
  isUnsupportedToolPolicyError,
  permissionModeFor,
  PROVIDERS_WITHOUT_TOOL_POLICY,
} from "../runtime/agent-gateway-helpers";
import type { PipelineContext } from "./context";

export const STANDALONE_SPEC_AGENT_TOOLS: readonly BusToolName[] = [
  "slp_board_list_tickets",
  "slp_board_get_ticket",
  "slp_board_save_spec",
];

export interface StandaloneSpecAgentSession {
  agentId: string;
  token: string;
  repoPath: string;
  workspaceId: string;
  createdAt: string;
}

// In-memory registry of standalone Spec Agent tokens so the MCP bus can authenticate them without an SLP Run.
const standaloneSpecAgentByToken = new Map<string, StandaloneSpecAgentSession>();
const standaloneSpecAgentById = new Map<string, StandaloneSpecAgentSession>();

export function findStandaloneSpecAgentByToken(token: string): StandaloneSpecAgentSession | null {
  return standaloneSpecAgentByToken.get(token) ?? null;
}

export function findStandaloneSpecAgentById(agentId: string): StandaloneSpecAgentSession | null {
  return standaloneSpecAgentById.get(agentId) ?? null;
}

export interface SpawnSpecAgentInput {
  repoPath: string;
  ticketId?: string;
  provider: string;
  thinkingOptionId?: string | null;
  permissionModeId?: string | null;
}

// System prompt for a normal standalone Spec discussion agent (no SLP Supervisor/Lead/Peer orchestration rules).
const STANDALONE_SPEC_AGENT_SYSTEM_PROMPT = [
  "You are a Product Spec Assistant helping the user discuss and write clear Product Specifications in Vietnamese.",
  "- Stay read-only on the repository: inspect code, screens, routes, and schemas as needed, but do not edit source files.",
  `- You have access to the project's Kanban Spec board through MCP server "${BUS_SERVER_NAME}" (\`slp_board_list_tickets\`, \`slp_board_get_ticket\`, \`slp_board_save_spec\`).`,
  "- Whenever you draft or update a Product Spec with the user, call `slp_board_save_spec({ ticketId?, spec, summary })` so the Spec card is created or updated directly on the Kanban board.",
].join("\n");

// Builds the initial user-facing prompt when opening the standalone agent chat.
function buildStandaloneSpecKickoffPrompt(targetTicket: BoardTicket | null): string {
  if (targetTicket) {
    const latestSpecRevision = targetTicket.specRevisions.at(-1);
    return [
      `Mình muốn thảo luận và chỉnh sửa thẻ Spec **\`${targetTicket.ticketKey}\`** (${targetTicket.title}).`,
      latestSpecRevision?.content
        ? `Nội dung Spec hiện tại (\`v${targetTicket.currentSpecRev}\`):\n\n${latestSpecRevision.content}`
        : "",
      `Hãy tóm tắt ngắn gọn nội dung hiện tại của \`${targetTicket.ticketKey}\`, hỏi mình muốn bổ sung hay chỉnh sửa điểm nào, và khi chốt nội dung thì lưu lại lên Kanban bằng \`slp_board_save_spec({ ticketId: "${targetTicket.ticketKey}", spec: "...", summary: "..." })\`.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    "Mình muốn thảo luận cùng bạn để viết một **Product Spec** mới cho dự án này.",
    "Hãy hỏi mình về tính năng hoặc bài toán cần làm, khảo sát mã nguồn hiện tại của dự án (chỉ đọc) để nắm bối cảnh, và cùng mình hoàn thiện bản Spec (gồm: 1. Screens / surfaces, 2. States, 3. Interactions Given/When/Then, 4. Business rules & data, 5. Out of scope).",
    "Khi có bản nháp hoặc mỗi khi cập nhật theo thảo luận, hãy lưu trực tiếp lên cột `1. SPEC` của bảng Kanban bằng công cụ `slp_board_save_spec({ spec, summary })`.",
  ].join("\n\n");
}

// Spawns a normal standalone Paseo agent in the project workspace without creating any SLP Run or Supervisor.
export async function spawnBoardSpecAgent(
  ctx: PipelineContext,
  input: SpawnSpecAgentInput,
): Promise<{ agentId: string; workspaceId: string }> {
  await assertGitRepository(input.repoPath);
  const targetTicket = input.ticketId?.trim()
    ? ctx.store.board.find(input.ticketId.trim(), input.repoPath) ?? null
    : null;

  const paseo = await ctx.holder.get();
  // Open or reuse the repository's normal workspace in Paseo without creating any worktree or SLP Run.
  const projectWorkspace = await openSupervisorWorkspace(paseo, input.repoPath);
  const workspaceHandle = paseo.workspaces.ref(projectWorkspace.workspaceId);
  await workspaceHandle.refresh();

  let agentId = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const sessionRecord: StandaloneSpecAgentSession = {
    agentId,
    token,
    repoPath: input.repoPath,
    workspaceId: projectWorkspace.workspaceId,
    createdAt: new Date().toISOString(),
  };
  standaloneSpecAgentByToken.set(token, sessionRecord);
  standaloneSpecAgentById.set(agentId, sessionRecord);

  const busUrl = await ctx.gateway.busEndpointForToken(token);
  const selectedProviderId = input.provider.trim().toLowerCase().split("/", 1)[0];
  const providerFeatureValues = defaultFeatureValuesForProvider(input.provider);
  const agentTitle = targetTicket
    ? `Spec · ${targetTicket.ticketKey}`
    : "Spec Discussion";

  const baseSessionConfig = {
    provider: input.provider,
    modeId: input.permissionModeId ?? permissionModeFor(input.provider),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(providerFeatureValues ? { featureValues: providerFeatureValues } : {}),
    systemPrompt: STANDALONE_SPEC_AGENT_SYSTEM_PROMPT,
    mcpServers: {
      [BUS_SERVER_NAME]: {
        type: "http" as const,
        alwaysLoad: true,
        url: busUrl,
      },
    },
  };

  const preapprovedToolPolicy = {
    preapproved: STANDALONE_SPEC_AGENT_TOOLS.map((toolName) => ({
      kind: "mcp" as const,
      server: BUS_SERVER_NAME,
      tool: toolName,
    })),
  };

  try {
    // Skip toolPolicy for plugin/ACP providers (e.g. Antigravity, Kiro) that reject exact MCP tool preapproval.
    if (PROVIDERS_WITHOUT_TOOL_POLICY.has(selectedProviderId)) {
      await workspaceHandle.agents.create({
        agentId,
        title: agentTitle,
        prompt: buildStandaloneSpecKickoffPrompt(targetTicket),
        config: baseSessionConfig,
      });
    } else {
      try {
        await workspaceHandle.agents.create({
          agentId,
          title: agentTitle,
          prompt: buildStandaloneSpecKickoffPrompt(targetTicket),
          config: { ...baseSessionConfig, toolPolicy: preapprovedToolPolicy },
        });
      } catch (toolPolicyError) {
        if (!isUnsupportedToolPolicyError(toolPolicyError)) throw toolPolicyError;
        // Allocate a fresh agentId before retrying because Paseo registers the failed agentId before session.open.
        standaloneSpecAgentById.delete(agentId);
        agentId = randomUUID();
        sessionRecord.agentId = agentId;
        standaloneSpecAgentById.set(agentId, sessionRecord);
        await workspaceHandle.agents.create({
          agentId,
          title: agentTitle,
          prompt: buildStandaloneSpecKickoffPrompt(targetTicket),
          config: baseSessionConfig,
        });
      }
    }
  } catch (createError) {
    standaloneSpecAgentByToken.delete(token);
    standaloneSpecAgentById.delete(agentId);
    throw createError;
  }

  return {
    agentId,
    workspaceId: projectWorkspace.workspaceId,
  };
}
