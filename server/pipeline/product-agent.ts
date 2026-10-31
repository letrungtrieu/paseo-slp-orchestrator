// Spawns the standalone Product Agent (outside any SLP Run) that shapes a feature's mockup and Spec with the human.
import { randomBytes, randomUUID } from "node:crypto";
import { describeSpecWriteBlocker, MOCKUP_ROOT, specNeedsMockupReview, type BoardTicket } from "../../shared/board";
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
import { formatMockupElementCommentsMarkdown } from "../store/board-mockup";
import type { PipelineContext } from "./context";

export const STANDALONE_PRODUCT_AGENT_TOOLS: readonly BusToolName[] = [
  "slp_board_list_tickets",
  "slp_board_get_ticket",
  "slp_board_save_spec",
  "slp_board_set_mockup",
];

export interface StandaloneProductAgentSession {
  agentId: string;
  token: string;
  repoPath: string;
  workspaceId: string;
  // The ticket under discussion, so Studio notes and approvals reach the session already holding its context.
  ticketId: string | null;
  createdAt: string;
}

// In-memory registry of standalone Product Agent tokens so the MCP bus can authenticate them without an SLP Run.
const standaloneProductAgentByToken = new Map<string, StandaloneProductAgentSession>();
const standaloneProductAgentById = new Map<string, StandaloneProductAgentSession>();

export function findStandaloneProductAgentByToken(token: string): StandaloneProductAgentSession | null {
  return standaloneProductAgentByToken.get(token) ?? null;
}

export function findStandaloneProductAgentById(agentId: string): StandaloneProductAgentSession | null {
  return standaloneProductAgentById.get(agentId) ?? null;
}

// An agent may open with no ticket and create one later, so the link is recorded whenever it touches a card.
export function bindProductAgentToTicket(agentId: string, ticketId: string): void {
  const productSession = standaloneProductAgentById.get(agentId);
  if (productSession) productSession.ticketId = ticketId;
}

function latestProductAgentForTicket(ticketId: string): StandaloneProductAgentSession | null {
  const ticketSessions = [...standaloneProductAgentById.values()].filter(
    (productSession) => productSession.ticketId === ticketId,
  );
  return ticketSessions.at(-1) ?? null;
}

// Returns the reached agent, or null so the caller can open a fresh session; a closed session must not lose the human's notes.
export async function promptProductAgentForTicket(
  ctx: PipelineContext,
  ticketId: string,
  promptText: string,
): Promise<string | null> {
  const productSession = latestProductAgentForTicket(ticketId);
  if (!productSession) return null;
  try {
    await ctx.gateway.prompt(productSession.agentId, promptText);
    return productSession.agentId;
  } catch {
    return null;
  }
}

export interface SpawnProductAgentInput {
  repoPath: string;
  ticketId?: string;
  provider: string;
  thinkingOptionId?: string | null;
  permissionModeId?: string | null;
}

// System prompt for the Product Agent: mockup first because ideas only become clear once they can be seen and edited.
const STANDALONE_PRODUCT_AGENT_SYSTEM_PROMPT = [
  "You are the Product Agent. You help the human turn an idea into an approved mockup and then a Product Spec, in Vietnamese, before any SLP Run exists.",
  `- Board access: MCP server "${BUS_SERVER_NAME}" (\`slp_board_list_tickets\`, \`slp_board_get_ticket\`, \`slp_board_save_spec\`, \`slp_board_set_mockup\`).`,
  `- Mockup first: for anything with a UI, build the idea as an interactive mockup and refine it with the human before writing a Spec. Features without a UI skip the mockup.`,
  `- Layout: \`${MOCKUP_ROOT}/<feature>.html\` is only an index. It holds the markup and loads files with plain \`<link rel="stylesheet">\` and \`<script src>\` tags. Never write JavaScript or CSS inline in it, because \`slp_board_set_mockup\` refuses an index that has inline code.`,
  `- Feature code: \`${MOCKUP_ROOT}/features/<feature>/\` holds that feature's own \`.js\` and \`.css\` files, split by concern (for example \`cart.js\`, \`checkout.css\`). Put all of a feature's behavior there.`,
  `- Shared code: \`${MOCKUP_ROOT}/core/\` holds the style and logic every mockup uses (\`core.css\`, \`core.js\`), and \`${MOCKUP_ROOT}/assets/\` holds shared images. Create core from the project's real design tokens the first time it is missing.`,
  "- Change core only for something truly shared, and tell the human because it affects every other mockup. Prefer editing the feature's own files.",
  "- Load every file with plain tags, because the preview inlines only those. ES module `import` statements between files will not run.",
  `- You may write only inside \`${MOCKUP_ROOT}/\`. Everything else in the repository is read-only, so read the real screens and terminology but never edit source files.`,
  "- After each meaningful mockup change, call `slp_board_set_mockup({ ticketId?, title?, file, summary })` so the card and preview stay current. That resets any approval and clears notes you have addressed.",
  `- Approval belongs to the human, through the Approve button on the board. It requires \`${MOCKUP_ROOT}\` to be committed. Commit or push only when the human asks, and stage only paths under \`${MOCKUP_ROOT}/\`.`,
  "- The Spec depends on the mockup. While the mockup is a draft, `slp_board_save_spec` is refused for that ticket, even to keep an existing Spec in step with your edits. Change only the mockup and do not look for a way around the refusal.",
  "- Approval starts the Spec work, and the engine tells you which kind. With no Spec yet, write a thin one with `slp_board_save_spec({ ticketId, spec, summary })`: reference the mockup file for the UI and record only what it cannot show (business rules, data, permissions, edge cases, out of scope). Never restate the UI in prose, because that duplicates the mockup.",
  "- When a mockup was edited after approval and then approved again, the Spec exists already: review it against the mockup. Save a revised Spec if something changed, or save the same text again to confirm it still matches. Until you save, the ticket cannot start a Run.",
  "- Without a mockup, write the Spec in full: 1. Screens / surfaces, 2. States, 3. Interactions Given/When/Then, 4. Business rules & data, 5. Out of scope.",
].join("\n");

// What the Product Agent owes the Spec once the human approves the mockup: write it the first time, review it after a re-approval.
export function buildSpecWorkPrompt(ticket: BoardTicket): string | null {
  if (ticket.mockup?.status !== "approved") return null;
  const approvedMockupLabel = `\`${ticket.mockup.file}\` tại commit \`${ticket.mockup.approvedCommit ?? ""}\``;
  const saveSpecCall = `\`slp_board_save_spec({ ticketId: "${ticket.ticketKey}", spec: "...", summary: "..." })\``;
  if (ticket.currentSpecRev < 1) {
    return `Mockup ${approvedMockupLabel} đã được chốt. Hãy soạn Spec mỏng và lưu bằng ${saveSpecCall}.`;
  }
  if (specNeedsMockupReview(ticket)) {
    return `Mockup ${approvedMockupLabel} đã được chốt lại sau khi chỉnh sửa. Hãy rà soát Spec hiện tại (\`v${ticket.currentSpecRev}\`) so với mockup này, rồi lưu bằng ${saveSpecCall}: bản sửa nếu có điểm khác, hoặc lưu lại nguyên văn để xác nhận Spec vẫn đúng.`;
  }
  return null;
}

// Builds the initial user-facing prompt, resuming from whatever state the ticket has reached.
function buildStandaloneProductKickoffPrompt(targetTicket: BoardTicket | null): string {
  if (!targetTicket) {
    return [
      "Mình có một ý tưởng tính năng mới cho dự án này.",
      "Hãy hỏi mình về ý tưởng, khảo sát mã nguồn hiện tại (chỉ đọc) để nắm bối cảnh, rồi dựng mockup để mình xem và chỉnh sửa. Nếu tính năng không có giao diện, hãy bỏ qua mockup và cùng mình viết Spec.",
    ].join("\n\n");
  }
  const latestSpecRevision = targetTicket.specRevisions.at(-1);
  const mockupState = targetTicket.mockup;
  const openNotes = mockupState
    ? [mockupState.feedback ?? "", formatMockupElementCommentsMarkdown(mockupState.elementComments)].filter(Boolean)
    : [];
  return [
    `Mình muốn tiếp tục thẻ **\`${targetTicket.ticketKey}\`** (${targetTicket.title}).`,
    mockupState
      ? `Mockup: \`${mockupState.file}\` (${mockupState.status}${mockupState.approvedCommit ? ` tại commit ${mockupState.approvedCommit}` : ""}).`
      : "",
    latestSpecRevision?.content
      ? `Nội dung Spec hiện tại (\`v${targetTicket.currentSpecRev}\`):\n\n${latestSpecRevision.content}`
      : "",
    openNotes.length > 0 ? `Góp ý mình vừa gửi cho mockup:\n\n${openNotes.join("\n\n")}` : "",
    // A locked Spec is stated up front so the agent does not spend a turn trying to keep it in step with the draft.
    describeSpecWriteBlocker(targetTicket) && latestSpecRevision
      ? "Mockup còn là bản nháp nên Spec đang bị khóa: chỉ sửa mockup, Spec sẽ được rà soát sau khi mình duyệt lại."
      : "",
    buildSpecWorkPrompt(targetTicket)
      ?? "Hãy tóm tắt ngắn gọn trạng thái hiện tại rồi làm tiếp theo góp ý, hoặc hỏi mình muốn chỉnh điểm nào.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Spawns a normal standalone Paseo agent in the project workspace without creating any SLP Run or Supervisor.
export async function spawnBoardProductAgent(
  ctx: PipelineContext,
  input: SpawnProductAgentInput,
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
  const sessionRecord: StandaloneProductAgentSession = {
    agentId,
    token,
    repoPath: input.repoPath,
    workspaceId: projectWorkspace.workspaceId,
    ticketId: targetTicket?.id ?? null,
    createdAt: new Date().toISOString(),
  };
  standaloneProductAgentByToken.set(token, sessionRecord);
  standaloneProductAgentById.set(agentId, sessionRecord);

  const busUrl = await ctx.gateway.busEndpointForToken(token);
  const selectedProviderId = input.provider.trim().toLowerCase().split("/", 1)[0];
  const providerFeatureValues = defaultFeatureValuesForProvider(input.provider);
  const agentTitle = targetTicket
    ? `Product · ${targetTicket.ticketKey}`
    : "Product Discussion";

  const baseSessionConfig = {
    provider: input.provider,
    modeId: input.permissionModeId ?? permissionModeFor(input.provider),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(providerFeatureValues ? { featureValues: providerFeatureValues } : {}),
    systemPrompt: STANDALONE_PRODUCT_AGENT_SYSTEM_PROMPT,
    mcpServers: {
      [BUS_SERVER_NAME]: {
        type: "http" as const,
        alwaysLoad: true,
        url: busUrl,
      },
    },
  };

  const preapprovedToolPolicy = {
    preapproved: STANDALONE_PRODUCT_AGENT_TOOLS.map((toolName) => ({
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
        prompt: buildStandaloneProductKickoffPrompt(targetTicket),
        config: baseSessionConfig,
      });
    } else {
      try {
        await workspaceHandle.agents.create({
          agentId,
          title: agentTitle,
          prompt: buildStandaloneProductKickoffPrompt(targetTicket),
          config: { ...baseSessionConfig, toolPolicy: preapprovedToolPolicy },
        });
      } catch (toolPolicyError) {
        if (!isUnsupportedToolPolicyError(toolPolicyError)) throw toolPolicyError;
        // Allocate a fresh agentId before retrying because Paseo registers the failed agentId before session.open.
        standaloneProductAgentById.delete(agentId);
        agentId = randomUUID();
        sessionRecord.agentId = agentId;
        standaloneProductAgentById.set(agentId, sessionRecord);
        await workspaceHandle.agents.create({
          agentId,
          title: agentTitle,
          prompt: buildStandaloneProductKickoffPrompt(targetTicket),
          config: baseSessionConfig,
        });
      }
    }
  } catch (createError) {
    standaloneProductAgentByToken.delete(token);
    standaloneProductAgentById.delete(agentId);
    throw createError;
  }

  return {
    agentId,
    workspaceId: projectWorkspace.workspaceId,
  };
}
