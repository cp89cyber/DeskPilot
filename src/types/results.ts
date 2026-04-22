export interface FollowupItem {
  id: string;
  title: string;
  dueAt?: string;
  status: string;
  sourceRefs: string[];
  fingerprint: string;
  createdAt: string;
  completedAt?: string;
}

export interface InboxUrgentThread {
  threadId: string;
  subject: string;
  reason: string;
}

export interface ReplyRecommendation {
  threadId: string;
  recommendation: string;
  stagedActionId?: string;
}

export interface FollowupDraft {
  title: string;
  dueAt?: string;
  status: string;
  sourceRefs: string[];
}

export interface InboxTriageResult {
  overview: string;
  urgentThreads: InboxUrgentThread[];
  replyRecommendations: ReplyRecommendation[];
  followUps: FollowupDraft[];
  stagedActionIds: string[];
  sourceRefs: string[];
}

export interface DailyBriefMeeting {
  title: string;
  start: string;
  end?: string;
  prepNotes: string;
  relatedFiles?: string[];
  sourceRefs: string[];
}

export interface DailyBriefResult {
  date: string;
  summary: string;
  priorities: string[];
  meetings: DailyBriefMeeting[];
  urgentThreads: InboxUrgentThread[];
  followUps: FollowupDraft[];
  sourceRefs: string[];
}

export interface ProposedSlot {
  start: string;
  end: string;
  reason: string;
}

export interface DraftInvitation {
  subject: string;
  body: string;
}

export interface SchedulePlanResult {
  needsClarification: boolean;
  clarifyingQuestion?: string;
  summary?: string;
  proposedSlots?: ProposedSlot[];
  draftInvitation?: DraftInvitation;
  stagedActionId?: string;
  sourceRefs: string[];
}

export interface DocumentSummaryResult {
  title: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  sourceRefs: string[];
}
