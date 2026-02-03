/**
 * @fileoverview Base agent interface for Socratic Council
 * Defines the minimal contract for agent implementations.
 */

import type {
  AgentConfig,
  AgentId,
  AgentPersona,
  AgentResponse,
  Bid,
  CouncilContext,
  OracleResult,
  Provider,
  WhisperMessage,
} from "@socratic-council/shared";

export interface BaseAgent {
  id: AgentId;
  name: string;
  persona: AgentPersona;
  provider: Provider;
  config: AgentConfig;

  generateBid(context: CouncilContext): Promise<Bid>;
  generateResponse(context: CouncilContext): Promise<AgentResponse>;

  sendWhisper(target: AgentId, message: WhisperMessage): Promise<void>;
  receiveWhisper(from: AgentId, message: WhisperMessage): Promise<void>;

  queryOracle(query: string): Promise<OracleResult>;
}
