// Progress card published into the Supervisor's chat for every task (spec section 5, tool 2).
// The daemon appends it as a plugin timeline row; re-appending the same id updates it in place.
import { z } from "zod";
import { TASK_PHASES, type TaskPhase } from "./state";

export const TASK_CARD_KIND = "slp-task-card";
// Bumped when the payload shape changes; the client only renders versions it knows, so old rows in a stored chat stay harmless.
export const TASK_CARD_VERSION = 1;

export const TaskCardSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  title: z.string(),
  // Validated against TASK_PHASES so the card can never carry a phase the colour and label maps do not know.
  phase: z.enum(TASK_PHASES),
  phaseLabel: z.string(),
  fixLoopCount: z.number(),
  fixLoopLimit: z.number(),
  // Nullable (not optional) so 'no gate' is an explicit value in the payload and the client needs no undefined checks.
  gateNote: z.string().nullable(),
  pausedReason: z.string().nullable(),
  workspaceId: z.string().nullable(),
  updatedAt: z.string(),
});
export type TaskCardData = z.infer<typeof TaskCardSchema>;

// Vietnamese labels follow the wording used by specs/MVP.md; the loop counter is added by the caller.
export function phaseLabel(phase: TaskPhase, fixLoopCount: number, fixLoopLimit: number): string {
  // The round shown while verifying is the one in progress (count + 1), capped so the label never exceeds the limit.
  const verifyingLabel = `Đang kiểm thử (Vòng ${Math.min(fixLoopCount + 1, fixLoopLimit)}/${fixLoopLimit})`;
  // A complete Record over TaskPhase: adding a phase without a label fails typechecking instead of rendering blank text.
  const labels: Record<TaskPhase, string> = {
    queued: "Đang chờ",
    handshaking: "Đang bắt tay",
    implementing: "Đang viết code",
    verifying: verifyingLabel,
    fixing: `Đang sửa lỗi (Vòng ${fixLoopCount}/${fixLoopLimit})`,
    documenting: "Đang viết hồ sơ nghiệm thu",
    ready_for_merge: "Sẵn sàng gộp",
    merged: "Đã gộp vào dev",
    paused: "Tạm dừng",
    failed: "Thất bại",
  };
  return labels[phase];
}
