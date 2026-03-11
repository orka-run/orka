import { z } from "zod/v4";

export const ApprovalPolicySchema = z.enum(["auto", "ask", "deny"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const ApprovalDecisionSchema = z.enum(["approve", "approve_session", "deny", "cancel"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  threadId: string;
  requestType: string;
  detail?: string;
  args?: unknown;
  status: "pending" | "resolved";
  decision?: ApprovalDecision;
  createdAt: string;
  resolvedAt?: string;
}
