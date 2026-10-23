/** 普通与 bridge 单轮输入的编排组件。 */
import { resolveSandboxTraceId } from './safe-log.js';
import { SESSION_RUN_ID } from './session-core.js';
import { pendingBridgeResult } from './session-turn-helpers.js';
import type { ExtractFrameOutcome, PendingActionContext, RouteEvidence, StructuredInput, TurnResult } from './session-types.js';
import { recordTurnTiming, TurnTimingTracker } from './turn-timing.js';
import type { BehaviorContext, PendingReference } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';

export type SessionTurnContext = {
  whenReady: () => Promise<void>;
  nextTurnId: () => number;
  hasPending: () => boolean;
  pendingAction: () => PendingActionContext | undefined;
  cancelStalePending: () => Promise<void>;
  currentBehaviorContext: () => BehaviorContext;
  resolveSelection: (text: string, context: BehaviorContext) => { descriptor?: PluginDescriptor; invalid: boolean; reasonCode: string };
  rejectSelection: (userText: string, reasonCode: string) => Promise<TurnResult>;
  extractFrame: (traceId: string, text: string, context: BehaviorContext, recentMessages: Array<{ role: string; text: string }>, selectedDescriptor?: PluginDescriptor, pendingAction?: PendingActionContext, structuredInput?: StructuredInput) => Promise<ExtractFrameOutcome>;
  recentMessages: () => Array<{ role: string; text: string }>;
  markUnresolved: (reasonCode: string, pendingReference?: PendingReference) => Promise<void>;
  pushMessage: (userText: string, reply: string) => void;
  routeNormalTurn: (context: { userText: string; traceId: string; behaviorContext: BehaviorContext; extracted: Extract<ExtractFrameOutcome, { ok: true }>; timing: TurnTimingTracker; passThroughOnNoMatch: boolean; selectedDescriptor?: PluginDescriptor }) => Promise<TurnResult>;
};

export class SandboxSessionTurn {
  public constructor(private readonly context: SessionTurnContext) {}

  public async run(text: string, bridgeMode: boolean, structuredInput?: StructuredInput): Promise<TurnResult> {
    await this.context.whenReady();
    const userText = text.trim();
    const turnId = this.context.nextTurnId();
    const traceId = resolveSandboxTraceId(`trace-sandbox-${String(turnId)}`);
    const timing = new TurnTimingTracker(traceId);
    try {
      if (bridgeMode && this.context.hasPending()) return this.withTiming(pendingBridgeResult(), timing);
      const pendingAction = this.context.pendingAction();
      const behaviorContext = this.context.currentBehaviorContext();
      const selection = this.context.resolveSelection(userText, behaviorContext);
      if (selection.invalid) return this.withTiming(await this.context.rejectSelection(userText, selection.reasonCode), timing);
      timing.start('semantic.extract');
      const extracted = await this.context.extractFrame(traceId, userText, behaviorContext, this.context.recentMessages(), selection.descriptor, pendingAction, structuredInput);
      timing.end('semantic.extract');
      if (!extracted.ok) {
        await this.context.markUnresolved(extracted.reasonCode);
        this.context.pushMessage(userText, extracted.reply);
        return this.withTiming({ status: 'failed', reply: extracted.reply, route: extracted.route, reasonCode: extracted.reasonCode }, timing);
      }
      return this.withTiming(await this.context.routeNormalTurn({ userText, traceId, behaviorContext, extracted, timing, passThroughOnNoMatch: bridgeMode, ...(selection.descriptor === undefined ? {} : { selectedDescriptor: selection.descriptor }) }), timing);
    } catch (error) {
      recordTurnTiming(timing.finish());
      throw error;
    }
  }

  private withTiming(result: TurnResult, timing: TurnTimingTracker): TurnResult {
    const summary = timing.finish();
    recordTurnTiming(summary);
    return { ...result, timing: summary };
  }
}
